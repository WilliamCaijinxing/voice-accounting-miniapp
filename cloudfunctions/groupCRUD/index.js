// cloudfunctions/groupCRUD/index.js
// 共享账本 / 群组管理：创建、加入（邀请码/分享）、列表、成员、退出、移除、重生成邀请码
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const LEDGER_COLL = 'ledgers';

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { code: -1, message: '获取用户标识失败' };
  }

  switch (action) {
    case 'create': return createLedger(OPENID, event);
    case 'list': return listMyLedgers(OPENID);
    case 'detail': return getLedgerDetail(OPENID, event);
    case 'joinByCode': return joinByCode(OPENID, event);
    case 'joinByShare': return joinByShare(OPENID, event);
    case 'quit': return quitLedger(OPENID, event);
    case 'removeMember': return removeMember(OPENID, event);
    case 'regenerateCode': return regenerateCode(OPENID, event);
    case 'dissolve': return dissolveLedger(OPENID, event);
    default: return { code: -1, message: 'Unknown action: ' + action };
  }
};

/**
 * 生成唯一的 6 位邀请码（去掉易混淆字符）
 */
async function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 30; i++) {
    let code = '';
    for (let j = 0; j < 6; j++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const exist = await db.collection(LEDGER_COLL).where({ inviteCode: code }).count();
    if (exist.total === 0) return code;
  }
  return { code: -1, message: '邀请码生成失败，请重试' };
}

/**
 * 判断用户是否为账本成员或创建者
 */
function isMember(ledger, openid) {
  if (!ledger) return false;
  if (ledger.ownerOpenid === openid) return true;
  return (ledger.members || []).some((m) => m.openid === openid);
}

/**
 * 创建共享账本
 */
async function createLedger(openid, { name, nickname, avatar }) {
  try {
    const codeRes = await generateInviteCode();
    if (typeof codeRes === 'object') return codeRes; // 生成失败

    const ledger = {
      name: (name && name.trim()) || '共享账本',
      ownerOpenid: openid,
      members: [{
        openid,
        nickname: nickname || '',
        avatar: avatar || '',
        role: 'owner',
        joinedAt: db.serverDate(),
      }],
      inviteCode: codeRes,
      createdAt: db.serverDate(),
    };

    const addRes = await db.collection(LEDGER_COLL).add({ data: ledger });
    return { code: 0, data: { _id: addRes._id, ...ledger } };
  } catch (err) {
    console.error('Create ledger error:', err);
    return { code: -1, message: '创建账本失败' };
  }
}

/**
 * 我参与的账本列表（作为创建者或成员）
 */
async function listMyLedgers(openid) {
  try {
    const res = await db.collection(LEDGER_COLL)
      .where(_.or([
        { ownerOpenid: openid },
        { 'members.openid': openid },
      ]))
      .orderBy('createdAt', 'desc')
      .get();

    const list = res.data.map((l) => ({
      _id: l._id,
      name: l.name,
      ownerOpenid: l.ownerOpenid,
      inviteCode: l.inviteCode,
      memberCount: (l.members || []).length,
      isOwner: l.ownerOpenid === openid,
      createdAt: l.createdAt,
    }));

    return { code: 0, data: { list } };
  } catch (err) {
    console.error('List ledgers error:', err);
    return { code: -1, message: '获取账本列表失败' };
  }
}

/**
 * 账本详情（成员列表）
 */
async function getLedgerDetail(openid, { ledgerId }) {
  if (!ledgerId) return { code: -1, message: '缺少账本ID' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };
    if (!isMember(ledgerRes.data, openid)) return { code: -1, message: '无权访问该账本' };

    const ledger = ledgerRes.data;
    return {
      code: 0,
      data: {
        _id: ledger._id,
        name: ledger.name,
        ownerOpenid: ledger.ownerOpenid,
        inviteCode: ledger.inviteCode,
        members: ledger.members || [],
        isOwner: ledger.ownerOpenid === openid,
        createdAt: ledger.createdAt,
      },
    };
  } catch (err) {
    console.error('Ledger detail error:', err);
    return { code: -1, message: '获取账本详情失败' };
  }
}

/**
 * 通过邀请码加入
 */
async function joinByCode(openid, { code, nickname, avatar }) {
  if (!code) return { code: -1, message: '请输入邀请码' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL)
      .where({ inviteCode: code.trim().toUpperCase() })
      .limit(1)
      .get();

    if (!ledgerRes.data.length) {
      return { code: -1, message: '邀请码无效或账本不存在' };
    }

    const ledger = ledgerRes.data[0];
    if (isMember(ledger, openid)) {
      return { code: 0, data: ledger, message: '你已在该账本中' };
    }

    const member = {
      openid,
      nickname: nickname || '',
      avatar: avatar || '',
      role: 'member',
      joinedAt: db.serverDate(),
    };
    await db.collection(LEDGER_COLL).doc(ledger._id).update({
      data: { members: _.push(member) },
    });

    return { code: 0, data: { ...ledger, members: [...(ledger.members || []), member] } };
  } catch (err) {
    console.error('Join by code error:', err);
    return { code: -1, message: '加入失败' };
  }
}

/**
 * 通过微信分享卡片进入并加入（分享卡片 path 带 ledgerId）
 */
async function joinByShare(openid, { ledgerId, nickname, avatar }) {
  if (!ledgerId) return { code: -1, message: '缺少账本ID' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };

    const ledger = ledgerRes.data;
    if (isMember(ledger, openid)) {
      return { code: 0, data: ledger, message: '你已在该账本中' };
    }

    const member = {
      openid,
      nickname: nickname || '',
      avatar: avatar || '',
      role: 'member',
      joinedAt: db.serverDate(),
    };
    await db.collection(LEDGER_COLL).doc(ledgerId).update({
      data: { members: _.push(member) },
    });

    return { code: 0, data: { ...ledger, members: [...(ledger.members || []), member] } };
  } catch (err) {
    console.error('Join by share error:', err);
    return { code: -1, message: '加入失败' };
  }
}

/**
 * 退出账本（创建者不能退出）
 */
async function quitLedger(openid, { ledgerId }) {
  if (!ledgerId) return { code: -1, message: '缺少账本ID' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };
    if (ledgerRes.data.ownerOpenid === openid) {
      return { code: -1, message: '创建者不能退出，可先解散账本' };
    }
    if (!isMember(ledgerRes.data, openid)) {
      return { code: -1, message: '你不在该账本中' };
    }

    await db.collection(LEDGER_COLL).doc(ledgerId).update({
      data: { members: _.pull({ openid }) },
    });

    return { code: 0, message: '已退出账本' };
  } catch (err) {
    console.error('Quit ledger error:', err);
    return { code: -1, message: '退出失败' };
  }
}

/**
 * 移除成员（仅创建者）
 */
async function removeMember(openid, { ledgerId, targetOpenid }) {
  if (!ledgerId || !targetOpenid) return { code: -1, message: '缺少参数' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };
    if (ledgerRes.data.ownerOpenid !== openid) {
      return { code: -1, message: '仅创建者可移除成员' };
    }
    if (targetOpenid === openid) {
      return { code: -1, message: '不能移除创建者' };
    }

    await db.collection(LEDGER_COLL).doc(ledgerId).update({
      data: { members: _.pull({ openid: targetOpenid }) },
    });

    return { code: 0, message: '已移除成员' };
  } catch (err) {
    console.error('Remove member error:', err);
    return { code: -1, message: '移除失败' };
  }
}

/**
 * 重生成邀请码（仅创建者）
 */
async function regenerateCode(openid, { ledgerId }) {
  if (!ledgerId) return { code: -1, message: '缺少账本ID' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };
    if (ledgerRes.data.ownerOpenid !== openid) {
      return { code: -1, message: '仅创建者可重生成邀请码' };
    }

    const codeRes = await generateInviteCode();
    if (typeof codeRes === 'object') return codeRes;

    await db.collection(LEDGER_COLL).doc(ledgerId).update({
      data: { inviteCode: codeRes },
    });

    return { code: 0, data: { inviteCode: codeRes } };
  } catch (err) {
    console.error('Regenerate code error:', err);
    return { code: -1, message: '重生成失败' };
  }
}

/**
 * 解散账本（仅创建者）：删除账本及其下所有账目与预算
 */
async function dissolveLedger(openid, { ledgerId }) {
  if (!ledgerId) return { code: -1, message: '缺少账本ID' };

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };
    if (ledgerRes.data.ownerOpenid !== openid) {
      return { code: -1, message: '仅创建者可解散账本' };
    }

    // 级联删除该账本的账目与预算，避免孤儿数据
    await db.collection('expenses').where({ ledgerId }).remove();
    await db.collection('budgets').where({ ledgerId }).remove();
    await db.collection(LEDGER_COLL).doc(ledgerId).remove();

    return { code: 0, message: '账本已解散' };
  } catch (err) {
    console.error('Dissolve ledger error:', err);
    return { code: -1, message: '解散失败' };
  }
}
