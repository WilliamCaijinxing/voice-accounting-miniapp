// cloudfunctions/exportData/index.js
// 导出账本数据为 CSV，上传到云存储并返回下载 fileID
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_LIMIT = 100; // 单次查询上限
const CONCURRENCY = 4; // 分页并发上限：避免一次性 N 个请求打满连接导致云函数超时
const MAX_EXPORT = 20000; // 单次导出条数上限，防止超大账本打爆内存
const { guardLedgerAccess, ROLE_EDITOR } = require('./ledger-guard');
const { buildWorkbook } = require('./xiaoyang-export');

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

/**
 * 拉取预算（元），写入月块的「月计划支出」便签
 * 失败一律返回空对象：预算只是装饰性信息，不该因为它阻断导出
 */
async function fetchBudgets(openid, ledgerId) {
  const _ = db.command;
  try {
    const where = ledgerId
      ? { ledgerId }
      : { _openid: openid, ledgerId: _.exists(false) };
    const res = await db.collection('budgets').where(where).limit(100).get();
    const map = {};
    (res.data || []).forEach((b) => {
      if (b.ym && b.amount) map[b.ym] = b.amount / 100;
    });
    return map;
  } catch (err) {
    console.warn('[exportData] 读取预算失败，月计划便签留空:', err && err.message);
    return {};
  }
}

/**
 * 生成「小羊记账」版式的 xlsx 并上传云存储
 */
async function exportXlsxFile(openid, expenses, ledgerId) {
  const list = Array.isArray(expenses) ? expenses : [];
  const incomes = list.filter((e) => e.type === 'income');
  const expenseList = list.filter((e) => e.type !== 'income');
  const budgetsByYm = await fetchBudgets(openid, ledgerId);

  const buffer = await buildWorkbook({
    expenses: expenseList,
    incomes,
    budgetsByYm,
  });

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cloudPath = `exports/xiaoyang_${dateStr}_${openid.slice(-6)}.xlsx`;
  const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer });
  console.log('[exportData] xlsx 导出完成 fileID:', uploadRes.fileID);

  let totalExpense = 0;
  let totalIncome = 0;
  list.forEach((e) => {
    if (e.type === 'income') totalIncome += e.amount;
    else totalExpense += e.amount;
  });

  return {
    code: 0,
    data: {
      count: list.length,
      fileID: uploadRes.fileID,
      totalExpense: toYuan(totalExpense),
      totalIncome: toYuan(totalIncome),
      // 前端据此提示子表构成（每个有数据的年份一个支出子表 + 收入子表）
      years: Array.from(new Set(list.map((e) => String(e.date || '').slice(0, 4)).filter(Boolean))).sort(),
    },
  };
}

exports.main = async (event) => {
  const { action, startDate, endDate, ledgerId } = event;
  const { OPENID } = cloud.getWXContext();

  if (action !== 'exportCSV' && action !== 'exportXLSX') {
    return { code: -1, message: 'Unknown action' };
  }

  // 共享账本导出前必须校验成员身份（防止拖走他人账本数据），个人账本自动放行。
  //
  // 角色要求 editor 及以上（P1-8）：导出产出的是**文件**——能被转发进聊天记录、
  // 落到电脑上。一旦只读成员也能导出，创建者就等于失去了对数据流出的控制，
  // 「只读」只剩界面上的意义。
  if (ledgerId) {
    const guard = await guardLedgerAccess(ledgerId, OPENID, ROLE_EDITOR);
    if (guard.code !== 0) return guard;
  }

  try {
    console.log('[exportData] 开始导出, openid:', OPENID, 'ledgerId:', ledgerId || '(个人)');

    const expenses = await fetchAllExpenses(OPENID, startDate, endDate, ledgerId);
    console.log('[exportData] 获取账单数量:', expenses.length);

    if (expenses.length === 0) {
      return { code: 0, data: { count: 0, message: '暂无账单数据可导出' } };
    }

    // 小羊版式 xlsx：数据已取到，直接渲染版式并上传
    if (action === 'exportXLSX') {
      return await exportXlsxFile(OPENID, expenses, ledgerId);
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
    // 不回传原始报错文本（P1-18）：完整错误已由上面的 console.error 落到云函数日志
    return { code: -1, message: '导出失败，请重试', error: 'EXPORT_FAILED' };
  }
};
