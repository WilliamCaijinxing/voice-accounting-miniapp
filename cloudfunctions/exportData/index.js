// cloudfunctions/exportData/index.js
// 导出账本数据为 CSV，上传到云存储并返回下载 fileID
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_LIMIT = 100; // 单次查询上限
const { guardLedgerAccess } = require('./ledger-guard');

/**
 * CSV 转义：字段中含逗号/引号/换行时需要加引号
 */
function csvEscape(value) {
  const str = String(value == null ? '' : value);
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
  const where = {};
  if (ledgerId) {
    where.ledgerId = ledgerId;
  } else {
    where._openid = openid;
  }
  if (startDate && endDate) {
    where.date = db.command.gte(startDate).and(db.command.lte(endDate));
  }

  const countRes = await db.collection('expenses').where(where).count();
  const total = countRes.total;

  const tasks = [];
  for (let i = 0; i < Math.ceil(total / MAX_LIMIT); i++) {
    tasks.push(
      db.collection('expenses')
        .where(where)
        .orderBy('date', 'desc')
        .skip(i * MAX_LIMIT)
        .limit(MAX_LIMIT)
        .get()
    );
  }
  const results = await Promise.all(tasks);
  return results.reduce((acc, res) => acc.concat(res.data), []);
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
      base.push(csvEscape(item.createTime ? new Date(item.createTime).toLocaleString('zh-CN') : ''));
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
