// cloudfunctions/expenseCRUD/index.js
// 账目 CRUD 云函数（支持个人账本与共享账本）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;
const EXPENSE_COLL = 'expenses';
const LEDGER_COLL = 'ledgers';
const { guardLedgerAccess, roleAtLeast, ROLE_VIEWER, ROLE_EDITOR, ROLE_OWNER } = require('./ledger-guard');

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  // 统一入口守卫：涉共享账本的调用必须通过成员校验，
  // 且 ledgerId 须为合法 24 位 hex（阻断 NoSQL 操作符注入，如 {$ne:null}）。
  // 个人账本（未传 ledgerId）自动放行。
  //
  // 角色分级（P1-8）：写操作要求 editor 及以上，只读动作（list/detail）只需是成员。
  // 角色通过「函数第三参数」下传，**不写进 event** —— event 完全由客户端可控，
  // 放进 event 里的 role 会被伪造。
  let role = ROLE_OWNER;
  if (event.ledgerId) {
    const WRITE_ACTIONS = ['create', 'update', 'delete'];
    const minRole = WRITE_ACTIONS.indexOf(action) !== -1 ? ROLE_EDITOR : ROLE_VIEWER;
    const guard = await guardLedgerAccess(event.ledgerId, OPENID, minRole);
    if (guard.code !== 0) return guard;
    role = guard.role;
  }

  switch (action) {
    case 'create': return createExpense(OPENID, event, role);
    case 'list': return listExpenses(OPENID, event, role);
    case 'detail': return getExpenseDetail(OPENID, event, role);
    case 'update': return updateExpense(OPENID, event, role);
    case 'delete': return deleteExpense(OPENID, event, role);
    default: return { code: -1, message: 'Unknown action: ' + action };
  }
};

/**
 * 构造查询范围：
 * - ledgerId 非空 → 共享账本（按账本查）
 * - ledgerId 为空 → 个人账本（本人 + 无 ledgerId 字段的历史记录）
 *
 * 注：成员与角色校验统一由入口的 guardLedgerAccess 承担，本文件不再另写
 * 「是不是成员」的判断——那会诱导后来者绕过角色分级（P1-8 整改的教训）。
 */
function buildScope(openid, ledgerId) {
  if (ledgerId) return { ledgerId };
  return { _openid: openid, ledgerId: _.exists(false) };
}

/**
 * 创建一笔账目
 */
async function createExpense(openid, { amount, type, categoryId, categoryName, date, description, ledgerId }, role) {
  if (!amount || !type || !categoryId || !date) {
    return { code: -1, message: '缺少必填字段' };
  }

  // 共享账本权限：入口已按 action 要求 editor+，这里是零成本的兜底断言
  // （防止将来新增分支绕过入口校验）
  if (ledgerId && !roleAtLeast(role, ROLE_EDITOR)) {
    return { code: -1, message: '你在该账本是只读成员，无法记账' };
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
async function getExpenseDetail(openid, { id, ledgerId }, role) {
  if (!id) return { code: -1, message: '缺少ID' };

  try {
    const res = await db.collection(EXPENSE_COLL).doc(id).get();
    if (!res.data) return { code: -1, message: '账目不存在' };

    // 权限校验：个人账本要求 _openid 匹配；共享账本要求成员（viewer 即可看）
    if (ledgerId) {
      if (res.data.ledgerId !== ledgerId || !roleAtLeast(role, ROLE_VIEWER)) {
        return { code: -1, message: '无权访问该账目' };
      }
    } else {
      if (res.data._openid !== openid || res.data.ledgerId) return { code: -1, message: '账目不存在' };
    }

    // 把「能不能改/删」一并下发（P1-8）。
    // 前端曾靠 app.globalData.openid 自己判断归属，但静默登录是异步的 ——
    // 登录完成前点进详情页时 openid 还是空串，editor 连自己的记录都看不到编辑入口。
    // 更根本的问题是：权限判定在前端重复实现一遍，必然与服务端漂移（同 P1-19 的教训）。
    // 这里以服务端口径为唯一事实源，前端只负责按它渲染。
    const canWrite = ledgerId
      ? (role === ROLE_OWNER || (role === ROLE_EDITOR && res.data._openid === openid))
      : true; // 个人账本：本就是自己的账

    return { code: 0, data: { ...res.data, canEdit: canWrite, canDelete: canWrite } };
  } catch (err) {
    return { code: -1, message: '查询失败' };
  }
}

/**
 * 更新账目
 */
async function updateExpense(openid, { id, ledgerId, ...updates }, role) {
  if (!id) return { code: -1, message: '缺少ID' };

  // 安全检查：只能更新自己的数据
  delete updates._id;
  delete updates._openid;
  delete updates.ledgerId;
  updates.updatedAt = db.serverDate();

  try {
    // 共享账本成员校验
    if (ledgerId) {
      if (!roleAtLeast(role, ROLE_EDITOR)) {
        return { code: -1, message: '你在该账本是只读成员，无法修改记录' };
      }

      // P1-8 信任底座：共享账本里 editor 只能改**自己**记的账，
      // 只有创建者（owner）能改任何人的记录。
      // 此前直接 where({_id, ledgerId}).update(...)，任何成员都能改掉别人的账。
      const target = await db.collection(EXPENSE_COLL).doc(id).get();
      if (!target.data || target.data.ledgerId !== ledgerId) {
        return { code: -1, message: '账目不存在' };
      }
      if (target.data._openid !== openid && role !== ROLE_OWNER) {
        return { code: -1, message: '只能修改自己记的账' };
      }

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
async function deleteExpense(openid, { id, ledgerId }, role) {
  if (!id) return { code: -1, message: '缺少ID' };

  try {
    if (ledgerId) {
      if (!roleAtLeast(role, ROLE_EDITOR)) {
        return { code: -1, message: '你在该账本是只读成员，无法删除记录' };
      }

      // 同 update：editor 只能删自己的记录，owner 可删任何人的
      const target = await db.collection(EXPENSE_COLL).doc(id).get();
      if (!target.data || target.data.ledgerId !== ledgerId) {
        return { code: -1, message: '账目不存在' };
      }
      if (target.data._openid !== openid && role !== ROLE_OWNER) {
        return { code: -1, message: '只能删除自己记的账' };
      }

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
