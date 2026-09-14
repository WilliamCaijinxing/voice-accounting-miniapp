// cloudfunctions/exportData/index.js
// 导出账本数据为 CSV，上传到云存储并返回下载 fileID
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_LIMIT = 100; // 单次查询上限
const CONCURRENCY = 4; // 分页并发上限：避免一次性 N 个请求打满连接导致云函数超时
const MAX_EXPORT = 20000; // 单次导出条数上限，防止超大账本打爆内存
const { guardLedgerAccess } = require('./ledger-guard');

/**
 * CSV 转义：字段中含逗号/引号/换行时需要加引号
 * 同时防「CSV 公式注入」——Excel 会把 = + - @ 开头的单元格当公式执行，
 * 描述/分类等用户可控字段可能被写成 =HYPERLINK(...) 之类的载荷。
 * 纯数字（含负数）不加前缀，避免破坏金额列。
 */
function csvEscape(value) {
  let str = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str)) {
    str = "'" + str;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * 金额从分转为元字符串
 */
function toYuan(amount) {
  return (amount / 100).toFixed(2);
}

/**
 * 拉取账单（处理云数据库 100 条/次上限）
 * - 共享账本（ledgerId 非空）：导出该账本全部成员数据
 * - 个人账本（ledgerId 为空）：仅导出本人数据
 */
async function fetchAllExpenses(openid, startDate, endDate, ledgerId) {
  const _ = db.command;
  const where = {};
  if (ledgerId) {
    where.ledgerId = ledgerId;
  } else {
    // 个人账本：仅本人、且未归属任何共享账本的记录
    // （口径与 expenseCRUD/statistics 的 buildScope 保持一致，否则个人导出会混入共享账本里的账）
    where._openid = openid;
    where.ledgerId = _.exists(false);
  }
  if (startDate && endDate) {
    where.date = _.gte(startDate).and(_.lte(endDate));
  }

  const countRes = await db.collection('expenses').where(where).count();
  const total = Math.min(countRes.total, MAX_EXPORT);
  if (countRes.total > MAX_EXPORT) {
    console.warn(`[exportData] 记录数 ${countRes.total} 超过单次上限 ${MAX_EXPORT}，本次仅导出前 ${MAX_EXPORT} 条`);
  }

  // 分批并发拉取：每批最多 CONCURRENCY 个请求，避免 N 个请求同时发出导致 20s 超时
  const pages = Math.ceil(total / MAX_LIMIT);
  const all = [];
  for (let start = 0; start < pages; start += CONCURRENCY) {
    const batch = [];
    for (let i = start; i < Math.min(start + CONCURRENCY, pages); i++) {
      batch.push(
        db.collection('expenses')
          .where(where)
          .orderBy('date', 'desc')
          .skip(i * MAX_LIMIT)
          .limit(MAX_LIMIT)
          .get()
      );
    }
    const results = await Promise.all(batch);
    results.forEach((res) => {
      all.push(...res.data);
    });
  }
  return all;
}

exports.main = async (event) => {
  const { action, startDate, endDate, ledgerId } = event;
  const { OPENID } = cloud.getWXContext();

  if (action !== 'exportCSV') {
    return { code: -1, message: 'Unknown action' };
  }

  // 共享账本导出前必须校验成员身份（防止拖走他人账本数据），个人账本自动放行
  if (ledgerId) {
    const guard = await guardLedgerAccess(ledgerId, OPENID);
    if (guard.code !== 0) return guard;
  }

  try {
    console.log('[exportData] 开始导出, openid:', OPENID, 'ledgerId:', ledgerId || '(个人)');

    const expenses = await fetchAllExpenses(OPENID, startDate, endDate, ledgerId);
    console.log('[exportData] 获取账单数量:', expenses.length);

    if (expenses.length === 0) {
      return { code: 0, data: { count: 0, message: '暂无账单数据可导出' } };
    }

    // 共享账本：建立 openid → 昵称 映射，CSV 增加「记账人」列
    let openidMap = {};
    if (ledgerId) {
      try {
        const ledgerRes = await db.collection('ledgers').doc(ledgerId).get();
        (ledgerRes.data.members || []).forEach((m) => {
          openidMap[m.openid] = m.nickname || '成员';
        });
      } catch (e) {
        // ignore
      }
    }

    // 生成 CSV 内容（带 BOM，保证 Excel 正确识别 UTF-8 中文）
    const header = ledgerId
      ? ['日期', '类型', '分类', '金额(元)', '描述', '记账人', '创建时间']
      : ['日期', '类型', '分类', '金额(元)', '描述', '创建时间'];
    const rows = expenses.map((item) => {
      const typeLabel = item.type === 'income' ? '收入' : '支出';
      const base = [
        csvEscape(item.date || ''),
        csvEscape(typeLabel),
        csvEscape(item.categoryName || item.categoryId || ''),
        csvEscape(toYuan(item.amount)),
        csvEscape(item.description || ''),
      ];
      if (ledgerId) {
        base.push(csvEscape(openidMap[item._openid] || '成员'));
      }
      // 字段名以 schema/写入方为准：expenseCRUD 写入的是 createdAt（此前误用 createTime 导致该列恒为空）
      base.push(csvEscape(item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''));
      return base.join(',');
    });

    const csvContent = '\uFEFF' + [header.join(','), ...rows].join('\r\n');

    // 上传到云存储
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cloudPath = `exports/ledger_${dateStr}_${OPENID.slice(-6)}.csv`;
    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from(csvContent, 'utf8'),
    });

    console.log('[exportData] 导出完成 fileID:', uploadRes.fileID);

    // 汇总统计
    let totalExpense = 0;
    let totalIncome = 0;
    expenses.forEach((e) => {
      if (e.type === 'income') totalIncome += e.amount;
      else totalExpense += e.amount;
    });

    return {
      code: 0,
      data: {
        count: expenses.length,
        fileID: uploadRes.fileID,
        totalExpense: toYuan(totalExpense),
        totalIncome: toYuan(totalIncome),
      },
    };
  } catch (err) {
    console.error('[exportData] Error:', err);
    return { code: -1, message: '导出失败：' + (err.message || '未知错误') };
  }
};
