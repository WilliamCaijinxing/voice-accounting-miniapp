// cloudfunctions/_shared/ledger-guard.js
// 共享账本访问守卫 —— 唯一事实源（勿在云函数目录内直接改副本）。
// 修改本文件后，在 cloudfunctions 目录执行：node sync-ledger-guard.js
// 会把本文件同步到 expenseCRUD/statistics/budgetCRUD/exportData 各自目录内，
// 随各云函数一起部署（微信云函数按目录独立上传，无法跨目录 require）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 微信云开发数据库自动生成的文档 _id 是 **32 位**十六进制字符串
// （实测样本 54ad1eea620fb1d9114b551e6c207cdb，与 MongoDB 的 24 位 ObjectId 不同，
// 生成规则是云开发自定义的）。曾经错误地假设成 24 位，导致所有真实账本 id 被误判为
// 「参数非法」——共享账本整体不可用。这里同时兼容 24 位（Mongo 风格 / 历史导入数据）
// 与 32 位（云开发自动生成）。
// 这个校验的真正目的只是防 NoSQL 注入（ledgerId 必须是字符串值，不能是 {$ne:null}
// 这类对象），并不是要精确描述 id 的生成规则 —— 字符集限定为纯 hex 即可。
const LEDGER_ID_RE = /^[a-f0-9]{24,32}$/i;

/* ============================================================================
 * 成员角色（P1-8 信任底座）
 * 自上而下包含：viewer ⊂ editor ⊂ owner
 *   viewer 只读 —— 看账目/统计/预算；不能记账、不能改删任何记录、不能导出、不能改预算
 *   editor 可记账，能改删「自己」的记录，能改预算、能导出（P0-8 整改前的既有行为）
 *   owner  创建者，能改删任何人的记录、管理成员与角色、增删成员、重置邀请码、解散
 * ========================================================================== */
const ROLE_VIEWER = 'viewer';
const ROLE_EDITOR = 'editor';
const ROLE_OWNER = 'owner';
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

/** 非成员 / 非法角色 / 存量成员（无 role 字段）返回空串 */
function isValidRole(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_RANK, role);
}

// 历史遗留的角色值 → 现语义。'member' 是 P0-3 时期写入但从未被任何逻辑读取过的
// 死字段（当时 members 只有「是不是成员」一个维度），等价于现在的 editor。
const LEGACY_ROLE_ALIAS = { member: ROLE_EDITOR };

/**
 * 取出调用者在该账本中的角色。
 * 非成员返回空串。
 * @param {object} ledger 账本文档
 * @param {string} openid 调用者 openid
 * @returns {string} '' | 'viewer' | 'editor' | 'owner'
 */
function roleOf(ledger, openid) {
  if (!ledger || !openid) return '';
  if (ledger.ownerOpenid === openid) return ROLE_OWNER;
  const member = (ledger.members || []).find((m) => m && m.openid === openid);
  if (!member) return '';
  if (isValidRole(member.role)) return member.role;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_ALIAS, member.role)) {
    return LEGACY_ROLE_ALIAS[member.role];
  }
  // 存量成员没有 role 字段：按 editor 处理，等价于 P1-8 整改前的行为，
  // 避免升级后老成员突然失去记账能力（权限是「收窄到 owner 才能改删他人」，
  // 不是「全员降级」）。
  return ROLE_EDITOR;
}

/** 角色是否达到要求（比较顺序用 ROLE_RANK） */
function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

/**
 * 账本访问守卫。
 * - ledgerId 为空/未传 → 个人账本语义，直接放行（对自己的账本天然全权）；
 * - ledgerId 不是 24 位 hex 字符串 → 拒绝（阻断 NoSQL 操作符注入，如 {$ne:null}/{$exists:true}）；
 * - 共享账本 → 校验调用者是该账本创建者或成员，且角色达到 minRole。
 * @param {*} ledgerId 客户端传入的账本 ID（外部可控，绝不信任）
 * @param {string} openid 调用者 openid（来自 getWXContext，可信）
 * @param {string} [minRole] 要求的最低角色，默认 viewer（即「是成员即可读」）
 * @returns {Promise<{code:number,role?:string,message?:string}>} code 0 放行；-1 拒绝
 */
async function guardLedgerAccess(ledgerId, openid, minRole = ROLE_VIEWER) {
  if (ledgerId === undefined || ledgerId === null || ledgerId === '') {
    // 个人账本：不存在共享语义，调用者对自己的数据天然是 owner
    return { code: 0, role: ROLE_OWNER };
  }
  if (typeof ledgerId !== 'string' || !LEDGER_ID_RE.test(ledgerId)) {
    return { code: -1, message: '参数非法' };
  }
  try {
    const res = await db.collection('ledgers').doc(ledgerId).get();
    const ledger = res.data;
    if (!ledger) return { code: -1, message: '账本不存在' };

    const role = roleOf(ledger, openid);
    if (!role) return { code: -1, message: '无权访问该账本' };
    if (!roleAtLeast(role, minRole)) {
      // 只读成员撞上写操作：说清原因，避免用户以为自己记错了
      const denied = role === ROLE_VIEWER
        ? '你在该账本是只读成员，无法进行此操作'
        : '你在该账本没有此操作权限';
      return { code: -1, message: denied, role };
    }
    return { code: 0, role };
  } catch (err) {
    // 账本不存在 / 无权限读取等一律拒绝
    return { code: -1, message: '无权访问该账本' };
  }
}

module.exports = {
  guardLedgerAccess,
  roleOf,
  roleAtLeast,
  isValidRole,
  LEDGER_ID_RE,
  ROLE_VIEWER,
  ROLE_EDITOR,
  ROLE_OWNER,
  ROLE_RANK,
};