// cloudfunctions/expenseCRUD/index.js
// 账目 CRUD 云函数（支持个人账本与共享账本）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;
const EXPENSE_COLL = 'expenses';
const LEDGER_COLL = 'ledgers';
const { guardLedgerAccess } = require('./ledger-guard');

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  // 统一入口守卫：涉共享账本的调用必须通过成员校验，
  // 且 ledgerId 须为合法 24 位 hex（阻断 NoSQL 操作符注入，如 {$ne:null}）。
  // 个人账本（未传 ledgerId）自动放行。
  if (event.ledgerId) {
    const guard = await guardLedgerAccess(event.ledgerId, OPENID);
    if (guard.code !== 0) return guard;
  }

  switch (action) {
    case 'create': return createExpense(OPENID, event);
    case 'list': return listExpenses(OPENID, event);
    case 'detail': return getExpenseDetail(OPENID, event);
    case 'update': return updateExpense(OPENID, event);
    case 'delete': return deleteExpense(OPENID, event);
    default: return { code: -1, message: 'Unknown action: ' + action };
  }
};

/**
 * 构造查询范围：
 * - ledgerId 非空 → 共享账本（按账本查）
 * - ledgerId 为空 → 个人账本（本人 + 无 ledgerId 字段的历史记录）
 */
function buildScope(openid, ledgerId) {
  if (ledgerId) return { ledgerId };
  return { _openid: openid, ledgerId: _.exists(false) };
}

/**
 * 校验当前用户是否为共享账本成员（个人账本无需校验）
 */
async function verifyLedgerMember(ledgerId, openid) {
  if (!ledgerId) return true;
  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return false;
    const members = ledgerRes.data.members || [];
    return ledgerRes.data.ownerOpenid === openid || members.some((m) => m.openid === openid);
  } catch (err) {
    return false;
  }
}

/**
 * 创建一笔账目
 */
async function createExpense(openid, { amount, type, categoryId, categoryName, date, description, ledgerId }) {
  if (!amount || !type || !categoryId || !date) {
    return { code: -1, message: '缺少必填字段' };
  }

  // 共享账本权限校验
  if (ledgerId) {
    const ok = await verifyLedgerMember(ledgerId, openid);
    if (!ok) return { code: -1, message: '无权在该账本记账' };
  }

  const doc = {
    _openid: openid,
    amount: Math.round(amount),       // 单位：分
    type,                             // 'expense' | 'income'
    categoryId,
    categoryName: categoryName || '',
    date,                             // 'YYYY-MM-DD'
    description: description || '',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  };

  // 仅共享账本写入 ledgerId（个人账本不写该字段，保证历史兼容）
  if (ledgerId) doc.ledgerId = ledgerId;

  try {
    const res = await db.collection(EXPENSE_COLL).add({ data: doc });
    return {
      code: 0,
      data: { _id: res._id, ...doc },
    };
  } catch (err) {
    console.error('Create expense error:', err);
    return { code: -1, message: '创建失败' };
  }
}

/**
 * 查询账目列表（分页 + 筛选）
 */
async function listExpenses(openid, { page = 1, pageSize = 20, startDate, endDate, categoryId, type, ledgerId }) {
  const scope = buildScope(openid, ledgerId);
  const query = { ...scope };

  // 日期范围筛选
  if (startDate && endDate) {
    query.date = _.gte(startDate).and(_.lte(endDate));
  }

  // 分类筛选
  if (categoryId) query.categoryId = categoryId;

  // 类型筛选
  if (type) query.type = type;

  try {
    const total = await db.collection(EXPENSE_COLL).where(query).count();

    const res = await db.collection(EXPENSE_COLL)
      .where(query)
      .orderBy('date', 'desc')
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    return {
      code: 0,
      data: {
        list: res.data,
        total: total.total,
        page,
        pageSize,
        hasMore: page * pageSize < total.total,
      },
    };
  } catch (err) {
    console.error('List expenses error:', err);
    return { code: -1, message: '查询失败' };
  }
}

/**
 * 查询单条账目详情
 */
async function getExpenseDetail(openid, { id, ledgerId }) {
  if (!id) return { code: -1, message: '缺少ID' };

  try {
    const res = await db.collection(EXPENSE_COLL).doc(id).get();
    if (!res.data) return { code: -1, message: '账目不存在' };

    // 权限校验：个人账本要求 _openid 匹配；共享账本要求成员
    if (ledgerId) {
      const ok = await verifyLedgerMember(ledgerId, openid);
      if (!ok || res.data.ledgerId !== ledgerId) return { code: -1, message: '无权访问该账目' };
    } else {
      if (res.data._openid !== openid || res.data.ledgerId) return { code: -1, message: '账目不存在' };
    }

    return { code: 0, data: res.data };
  } catch (err) {
    return { code: -1, message: '查询失败' };
  }
}

/**
 * 更新账目
 */
async function updateExpense(openid, { id, ledgerId, ...updates }) {
  if (!id) return { code: -1, message: '缺少ID' };

  // 安全检查：只能更新自己的数据
  delete updates._id;
  delete updates._openid;
  delete updates.ledgerId;
  updates.updatedAt = db.serverDate();

  try {
    // 共享账本成员校验
    if (ledgerId) {
      const ok = await verifyLedgerMember(ledgerId, openid);
      if (!ok) return { code: -1, message: '无权修改该账本记录' };
      await db.collection(EXPENSE_COLL)
        .where({ _id: id, ledgerId })
        .update({ data: updates });
    } else {
      await db.collection(EXPENSE_COLL)
        .where({ _id: id, _openid: openid, ledgerId: _.exists(false) })
        .update({ data: updates });
    }
    return { code: 0, data: { _id: id, ...updates } };
  } catch (err) {
    return { code: -1, message: '更新失败' };
  }
}

/**
 * 删除账目
 */
async function deleteExpense(openid, { id, ledgerId }) {
  if (!id) return { code: -1, message: '缺少ID' };

  try {
    if (ledgerId) {
      const ok = await verifyLedgerMember(ledgerId, openid);
      if (!ok) return { code: -1, message: '无权删除该账本记录' };
      await db.collection(EXPENSE_COLL)
        .where({ _id: id, ledgerId })
        .remove();
    } else {
      await db.collection(EXPENSE_COLL)
        .where({ _id: id, _openid: openid, ledgerId: _.exists(false) })
        .remove();
    }
    return { code: 0, data: { _id: id } };
  } catch (err) {
    return { code: -1, message: '删除失败' };
  }
}
