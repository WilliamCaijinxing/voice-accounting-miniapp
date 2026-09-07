// cloudfunctions/_shared/ledger-guard.js
// 共享账本访问守卫 —— 唯一事实源（勿在云函数目录内直接改副本）。
// 修改本文件后，在 cloudfunctions 目录执行：node sync-ledger-guard.js
// 会把本文件同步到 expenseCRUD/statistics/budgetCRUD/exportData 各自目录内，
// 随各云函数一起部署（微信云函数按目录独立上传，无法跨目录 require）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 云数据库文档 _id 为 24 位十六进制字符串
const LEDGER_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * 账本访问守卫。
 * - ledgerId 为空/未传 → 个人账本语义，直接放行；
 * - ledgerId 不是 24 位 hex 字符串 → 拒绝（阻断 NoSQL 操作符注入，如 {$ne:null}/{$exists:true}）；
 * - 共享账本 → 校验调用者是该账本创建者或成员，否则拒绝。
 * @param {*} ledgerId 客户端传入的账本 ID（外部可控，绝不信任）
 * @param {string} openid 调用者 openid（来自 getWXContext，可信）
 * @returns {Promise<{code:number,message?:string}>} code 0 放行；-1 拒绝
 */
async function guardLedgerAccess(ledgerId, openid) {
  if (ledgerId === undefined || ledgerId === null || ledgerId === '') {
    return { code: 0 };
  }
  if (typeof ledgerId !== 'string' || !LEDGER_ID_RE.test(ledgerId)) {
    return { code: -1, message: '参数非法' };
  }
  try {
    const res = await db.collection('ledgers').doc(ledgerId).get();
    const ledger = res.data;
    if (!ledger) return { code: -1, message: '账本不存在' };
    const members = ledger.members || [];
    const isMember = ledger.ownerOpenid === openid || members.some((m) => m && m.openid === openid);
    return isMember ? { code: 0 } : { code: -1, message: '无权访问该账本' };
  } catch (err) {
    // 账本不存在 / 无权限读取等一律拒绝
    return { code: -1, message: '无权访问该账本' };
  }
}

module.exports = { guardLedgerAccess, LEDGER_ID_RE };
