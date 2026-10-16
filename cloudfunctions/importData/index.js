// cloudfunctions/importData/index.js
// 从「小羊记账」版式 xlsx 导入账本数据。
// 两步式：parsePreview（解析 + 判重，不落库） → confirmImport（确认后批量入库）。
// 为什么要预览：表格里一笔 Coordinates 可能对应多条记账，换行对不齐、金额被手改，
// 直接入库等于让用户看不见地改了账本 —— 星明确要求「先预览确认再入库」。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { guardLedgerAccess, ROLE_EDITOR } = require('./ledger-guard');
const { parseWorkbook } = require('./xiaoyang-parse');

const EXPENSE_COLL = 'expenses';
const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12MB 上限，防超大文件打爆云函数内存
const MAX_PREVIEW = 5000;                // 预览条数上限
const MAX_CONFIRM = 500;                 // 单次入库条数上限（前端分批调用）
const INSERT_CONCURRENCY = 10;           // 入库并发
const MAX_AMOUNT_YUAN = 10000000;        // 单笔上限 1000 万元
const MAX_DESC_LEN = 100;

/** 读取范围内的现有记录，构造判重键集合 */
async function buildDedupKeys(openid, ledgerId, minDate, maxDate) {
  const where = ledgerId
    ? { ledgerId }
    : { _openid: openid, ledgerId: _.exists(false) };
  where.date = _.gte(minDate).and(_.lte(maxDate));

  const keys = new Set();
  const MAX_LIMIT = 100;
  let skip = 0;
  // 上限 5000 条：够覆盖任何单文件导入范围；再多就没必要为判重读爆数据库
  const CAP = 5000;
  while (skip < CAP) {
    const res = await db
      .collection(EXPENSE_COLL)
      .where(where)
      .skip(skip)
      .limit(MAX_LIMIT)
      .get();
    const list = res.data || [];
    list.forEach((e) => {
      keys.add(dedupKey(e.date, e.type, e.amount, e.description));
    });
    if (list.length < MAX_LIMIT) break;
    skip += MAX_LIMIT;
  }
  return keys;
}

function dedupKey(date, type, amountFen, desc) {
  return `${date}|${type}|${amountFen}|${String(desc || '')}`;
}

/** 金额（元）→ 分。拒绝 NaN / 负数 / 超限 */
function yuanToFen(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > MAX_AMOUNT_YUAN) return null;
  return Math.round(n * 100);
}

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= new Date(y, m, 0).getDate();
}

/** 预览：下载 + 解析 + 判重，不写库 */
async function parsePreview(openid, { fileID, ledgerId }) {
  if (!fileID || typeof fileID !== 'string') {
    return { code: -1, message: '缺少文件' };
  }

  let content;
  try {
    const res = await cloud.downloadFile({ fileID });
    content = res.fileContent;
  } catch (err) {
    console.error('[importData] 下载文件失败:', err && err.message);
    return { code: -1, message: '文件读取失败，请重新选择' };
  }

  if (!content || content.length === 0) {
    return { code: -1, message: '文件为空' };
  }
  if (content.length > MAX_FILE_BYTES) {
    return { code: -1, message: '文件过大（上限 12MB）' };
  }

  let parsed;
  try {
    parsed = await parseWorkbook(content);
  } catch (err) {
    console.error('[importData] 解析失败:', err && err.message);
    // 最常见的失败是「这不是小羊版式的表」——给用户可读的指引而不是技术报错
    return { code: -1, message: '无法识别表格格式，请确认是本年/往年记账导出的小羊格式 Excel' };
  }

  if (!parsed.records.length) {
    return { code: -1, message: '没有从表格中识别到任何记录' };
  }

  // 判重：取记录日期范围
  const dates = parsed.records.map((r) => r.date).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  let keys = new Set();
  try {
    keys = await buildDedupKeys(openid, ledgerId, minDate, maxDate);
  } catch (err) {
    // 判重失败不该阻断导入：降级为「全部视为不重复」，由预览 UI 让用户自己把关
    console.warn('[importData] 判重失败，降级为不判重:', err && err.message);
  }

  const limited = parsed.records.slice(0, MAX_PREVIEW);
  const records = limited.map((r) => {
    const amountFen = yuanToFen(r.amount);
    const key = dedupKey(r.date, r.type, amountFen, r.desc);
    return {
      date: r.date,
      desc: r.desc,
      amount: r.amount, // 元（前端展示用，入库时按此值转分）
      type: r.type,
      duplicate: amountFen === null || keys.has(key),
    };
  });

  const dupCount = records.filter((r) => r.duplicate).length;
  console.log(`[importData] 预览 ${records.length} 条（疑似重复 ${dupCount} 条）`);

  return {
    code: 0,
    data: {
      records,
      total: parsed.records.length,
      duplicateCount: dupCount,
      truncated: parsed.records.length > MAX_PREVIEW,
      years: parsed.years,
      warnings: parsed.warnings.slice(0, 20), // 只回传前 20 条提示，避免撑爆响应
    },
  };
}

/** 确认入库：校验后批量写入 */
async function confirmImport(openid, { records, ledgerId }, role) {
  if (!Array.isArray(records) || records.length === 0) {
    return { code: -1, message: '没有可导入的记录' };
  }
  if (!Array.isArray(records)) {
    return { code: -1, message: '参数非法' };
  }
  if (records.length > MAX_CONFIRM) {
    return { code: -1, message: `单次导入上限 ${MAX_CONFIRM} 条，请分批` };
  }
  // 共享账本兜底断言（入口已要求 editor+）
  if (ledgerId && role !== 'owner' && role !== 'editor') {
    return { code: -1, message: '你在该账本没有导入权限' };
  }

  const docs = [];
  const skipped = [];
  records.forEach((r, idx) => {
    const amount = yuanToFen(r.amount);
    if (amount === null) {
      skipped.push({ idx, reason: '金额非法' });
      return;
    }
    if (!isValidDate(r.date)) {
      skipped.push({ idx, reason: '日期非法' });
      return;
    }
    const type = r.type === 'income' ? 'income' : 'expense';
    const desc = String(r.desc == null ? '' : r.desc).trim().slice(0, MAX_DESC_LEN);
    const categoryId = /^[a-z_]{1,32}$/.test(r.categoryId || '')
      ? r.categoryId
      : (type === 'income' ? 'other_income' : 'other');
    const categoryName = String(r.categoryName == null ? '' : r.categoryName).trim().slice(0, 20);

    // 字段结构与 expenseCRUD.createExpense 完全一致（个人账本不写 ledgerId，
    // 保证 buildScope 的 _.exists(false) 口径不被破坏）
    const doc = {
      _openid: openid,
      amount,
      type,
      categoryId,
      categoryName: categoryName || (type === 'income' ? '其他收入' : '其他'),
      date: r.date,
      description: desc,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };
    if (ledgerId) doc.ledgerId = ledgerId;
    docs.push(doc);
  });

  let inserted = 0;
  const failed = skipped.length;
  for (let i = 0; i < docs.length; i += INSERT_CONCURRENCY) {
    const batch = docs.slice(i, i + INSERT_CONCURRENCY);
    // 单条失败不影响其余：并发批次内允许部分失败
    const results = await Promise.allSettled(
      batch.map((doc) => db.collection(EXPENSE_COLL).add({ data: doc }))
    );
    results.forEach((res) => {
      if (res.status === 'fulfilled') inserted += 1;
      else console.error('[importData] 写入失败:', res.reason && res.reason.message);
    });
  }

  console.log(`[importData] 入库完成：成功 ${inserted}，跳过/失败 ${docs.length - inserted + failed}`);

  return {
    code: 0,
    data: { inserted, skipped: docs.length - inserted + failed },
  };
}

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();
  const { ledgerId } = event;

  if (action !== 'parsePreview' && action !== 'confirmImport') {
    return { code: -1, message: 'Unknown action' };
  }

  // 导入 = 写操作，要求 editor 及以上（P1-8 角色口径：viewer 只读）
  let role = ROLE_EDITOR;
  if (ledgerId) {
    const guard = await guardLedgerAccess(ledgerId, OPENID, ROLE_EDITOR);
    if (guard.code !== 0) return guard;
    role = guard.role;
  }

  try {
    if (action === 'parsePreview') {
      const res = await parsePreview(OPENID, event);
      // 预览结束后清掉临时文件：解析结果已返回前端，云存储的副本没有留存意义
      if (event.fileID) {
        cloud.deleteFile({ fileList: [event.fileID] }).catch(() => {});
      }
      return res;
    }
    return await confirmImport(OPENID, event, role);
  } catch (err) {
    console.error('[importData] Error:', err);
    return { code: -1, message: '导入失败，请重试', error: 'IMPORT_FAILED' };
  }
};
