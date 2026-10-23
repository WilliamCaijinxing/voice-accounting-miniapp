// cloudfunctions/groupCRUD/index.js
// 共享账本 / 群组管理：创建、加入（邀请码/分享）、列表、成员、退出、移除、重生成邀请码
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const LEDGER_COLL = 'ledgers';
const USERS_COLL = 'users';
// roleOf / isValidRole / 角色常量来自守卫（唯一事实源，随本函数一同部署）
const { roleOf, isValidRole, ROLE_OWNER, ROLE_EDITOR, ROLE_VIEWER } = require('./ledger-guard');

// 邀请凭证有效期（P0-3）：原先邀请码永久有效、分享卡片裸传 ledgerId，转发即成为永久成员。
// 现在改为「一次性邀请码 + 限时分享令牌」，两者均 72 小时有效，创建者重置即全部失效。
const CODE_TTL_MS = 72 * 60 * 60 * 1000;
const SHARE_TTL_MS = 72 * 60 * 60 * 1000;

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
    case 'setMemberRole': return setMemberRole(OPENID, event);
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
 * 生成 32 位十六进制分享令牌（128bit 随机，无法被枚举猜测）
 */
function generateInviteToken() {
  const chars = '0123456789abcdef';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

/** 把 Date / 数字 / 字符串时间统一转成毫秒时间戳；无法解析返回 0 */
function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 是否已过期。**无有效期字段一律视为已过期**（安全默认）——
 * P0-3 之前创建的存量账本没有 expireAt，不能让它们继续凭永久邀请码入账，
 * 创建者打开一次账本管理页即会自动签发新凭证。
 */
function isExpiredAt(value, nowMs) {
  const t = toMillis(value);
  return !t || t <= nowMs;
}

/**
 * 签发一套全新邀请凭证：
 * - inviteCode     6 位码，**一次性**（用掉即 inviteCodeUsed=true）
 * - inviteToken    32 位 hex，分享卡片用，有效期内可多人使用（一个群分享给多人的场景）
 * - 两者都有 72 小时有效期，重置时同步轮换
 * 失败时返回 { code, message }（与凭证对象以是否含 code 字段区分）。
 */
async function issueInviteCredentials(nowMs) {
  const code = await generateInviteCode();
  if (typeof code === 'object') return code; // 生成失败

  return {
    inviteCode: code,
    inviteCodeExpireAt: new Date(nowMs + CODE_TTL_MS),
    inviteCodeUsed: false,
    inviteCodeUsedBy: '',
    inviteCodeUsedAt: null,
    inviteToken: generateInviteToken(),
    inviteTokenExpireAt: new Date(nowMs + SHARE_TTL_MS),
  };
}

/** 创建者手上的凭证是否需要重新签发（缺失 / 已用掉 / 已过期） */
function needRenewCredentials(ledger, nowMs) {
  return !ledger.inviteCode
    || ledger.inviteCodeUsed === true
    || isExpiredAt(ledger.inviteCodeExpireAt, nowMs)
    || !ledger.inviteToken
    || isExpiredAt(ledger.inviteTokenExpireAt, nowMs);
}

/**
 * 成员变动（被移除 / 主动退出）后轮换邀请凭证。
 * 成员在离开前已能从账本详情读到邀请码与分享令牌，若不轮换，
 * 他就能凭记下的令牌在有效期内重新入账 —— 等于「移除成员」形同虚设。
 * 仅当当前凭证仍可用时才写库，避免无谓更新。
 */
async function rotateCredentialsIfActive(ledgerId, ledger) {
  const now = Date.now();
  const codeActive = !!ledger.inviteCode
    && ledger.inviteCodeUsed !== true
    && !isExpiredAt(ledger.inviteCodeExpireAt, now);
  const tokenActive = !!ledger.inviteToken
    && !isExpiredAt(ledger.inviteTokenExpireAt, now);
  if (!codeActive && !tokenActive) return;

  const credentials = await issueInviteCredentials(now);
  if (credentials.code !== undefined) return; // 生成失败则保持原凭证，不阻断主流程

  await db.collection(LEDGER_COLL).doc(ledgerId).update({ data: credentials });
}

/** 返回给前端的凭证视图（时间戳形式，便于前端直接格式化展示） */
function inviteView(ledger) {
  return {
    inviteCode: ledger.inviteCode || '',
    inviteCodeExpireAt: toMillis(ledger.inviteCodeExpireAt),
    inviteCodeUsed: ledger.inviteCodeUsed === true,
    inviteToken: ledger.inviteToken || '',
    inviteTokenExpireAt: toMillis(ledger.inviteTokenExpireAt),
  };
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
 * 用 users 集合的当前昵称补齐 members 里的空快照。
 *
 * 为什么需要：ledgers.members[].nickname 是「加入那一刻」的快照。早期三个入账本的入口
 * 写的都是微信授权返回的 nickName 字段，而 users 集合里实际叫 nickname —— 于是那批
 * 老成员的快照全是空串。首页 / 账单详情按 openid 映射昵称时拿不到值，一律落到「成员」，
 * 用户改完昵称也还是「成员」，看起来像改名没生效。
 *
 * 口径：快照有值就保留（可能是成员在账本里的自定义称谓），空了才用 users 的当前昵称兜。
 * 只读不改库 —— 整数组回写会和「改角色」这类并发写互相覆盖，得不偿失。
 */
async function fillMemberNicknames(members) {
  const list = Array.isArray(members) ? members : [];
  const pending = list.filter((m) => m && m.openid && !m.nickname);
  if (!pending.length) return list;

  try {
    const res = await db.collection(USERS_COLL)
      .where({ _openid: _.in(pending.map((m) => m.openid)) })
      .limit(100)
      .get();

    const nameMap = {};
    (res.data || []).forEach((u) => {
      if (u && u._openid && u.nickname) nameMap[u._openid] = u.nickname;
    });

    return list.map((m) => (
      m && m.openid && !m.nickname && nameMap[m.openid]
        ? { ...m, nickname: nameMap[m.openid] }
        : m
    ));
  } catch (err) {
    // 补不上不影响主流程：前端会退化成「成员」，至少账本能正常打开
    console.error('Fill member nicknames error:', err);
    return list;
  }
}

/**
 * 创建共享账本
 */
async function createLedger(openid, { name, nickname, avatar }) {
  try {
    const credentials = await issueInviteCredentials(Date.now());
    if (credentials.code !== undefined) return credentials; // 生成失败

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
      ...credentials,
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

    // 列表页不返回邀请凭证：前端用不到，且凭证属于管理信息，只在详情接口按需下发
    const list = res.data.map((l) => ({
      _id: l._id,
      name: l.name,
      ownerOpenid: l.ownerOpenid,
      memberCount: (l.members || []).length,
      isOwner: l.ownerOpenid === openid,
      // 我在该账本的角色（P1-8）：首页据此决定是否显示语音记账入口
      myRole: roleOf(l, openid) || ROLE_EDITOR,
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

    let ledger = ledgerRes.data;
    const isOwner = ledger.ownerOpenid === openid;

    // 创建者打开管理页时惰性续期：邀请码已用掉/已过期、或分享令牌缺失/已过期，
    // 立即轮换一整套新凭证（旧凭证同步失效）。这样创建者手上永远有可用凭证，
    // 不必手动点「重置」；一次性语义不受影响，因为新码只下发给创建者本人。
    if (isOwner && needRenewCredentials(ledger, Date.now())) {
      const credentials = await issueInviteCredentials(Date.now());
      if (credentials.code === undefined) {
        await db.collection(LEDGER_COLL).doc(ledgerId).update({ data: credentials });
        ledger = { ...ledger, ...credentials };
      }
      // 生成失败则不阻断详情返回，前端会据 inviteView 显示"已失效"
    }

    return {
      code: 0,
      data: {
        _id: ledger._id,
        name: ledger.name,
        ownerOpenid: ledger.ownerOpenid,
        // 成员昵称先补齐空快照（见 fillMemberNicknames），再统一经 roleOf 归一
        // （存量成员的 'member'/缺失值都会落成 editor），
        // 前端可直接按 role 渲染，不必自己猜缺省语义
        members: (await fillMemberNicknames(ledger.members)).map((m) => ({
          ...m,
          role: roleOf(ledger, m.openid) || ROLE_EDITOR,
        })),
        myRole: roleOf(ledger, openid) || ROLE_EDITOR,
        isOwner,
        createdAt: ledger.createdAt,
        ...inviteView(ledger),
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
  if (!code || typeof code !== 'string') return { code: -1, message: '请输入邀请码' };

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
    if (ledger.inviteCodeUsed === true) {
      return { code: -1, message: '该邀请码已被使用，请向创建者索要新的邀请码' };
    }
    if (isExpiredAt(ledger.inviteCodeExpireAt, Date.now())) {
      return { code: -1, message: '邀请码已过期，请向创建者索要新的邀请码' };
    }

    const member = {
      openid,
      nickname: nickname || '',
      avatar: avatar || '',
      // 新成员默认 editor：能记账、能改删自己的记录；
      // 想限制对方就由创建者在管理页改成 viewer
      role: 'editor',
      joinedAt: db.serverDate(),
    };

    // 一次性核销与入账放在**同一次条件更新**里完成：
    // 条件 inviteCodeUsed != true 保证两个并发请求只有一个命中，另一个 updated=0 被拒，
    // 避免"两人同时用同一邀请码"都通过上面检查而重复入账。
    const claim = await db.collection(LEDGER_COLL)
      // 除「未被核销」外，还显式要求有效期字段存在：MongoDB 的 $ne 对缺失字段也判定为真，
      // 钉住「凭证字段成套存在」这一前提，避免将来出现局部写入的账本被绕过。
      .where({
        _id: ledger._id,
        inviteCodeUsed: _.neq(true),
        inviteCodeExpireAt: _.exists(true),
      })
      .update({
        data: {
          members: _.push(member),
          inviteCodeUsed: true,
          inviteCodeUsedBy: openid,
          inviteCodeUsedAt: db.serverDate(),
        },
      });

    if (!claim.stats || claim.stats.updated === 0) {
      return { code: -1, message: '该邀请码已被使用，请向创建者索要新的邀请码' };
    }

    return { code: 0, data: { ...ledger, members: [...(ledger.members || []), member] } };
  } catch (err) {
    console.error('Join by code error:', err);
    return { code: -1, message: '加入失败' };
  }
}

/**
 * 通过微信分享卡片进入并加入（分享卡片 path 带 ledgerId）
 */
async function joinByShare(openid, { ledgerId, token, nickname, avatar }) {
  if (!ledgerId || typeof ledgerId !== 'string') return { code: -1, message: '缺少账本ID' };

  // 仅有 ledgerId 不再能入账：必须携带创建者签发的分享令牌
  if (!token || typeof token !== 'string') {
    return { code: -1, message: '邀请链接已失效，请让创建者重新分享' };
  }

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    if (!ledgerRes.data) return { code: -1, message: '账本不存在' };

    const ledger = ledgerRes.data;
    if (isMember(ledger, openid)) {
      return { code: 0, data: ledger, message: '你已在该账本中' };
    }
    if (!ledger.inviteToken || ledger.inviteToken !== token) {
      return { code: -1, message: '邀请链接已失效，请让创建者重新分享' };
    }
    if (isExpiredAt(ledger.inviteTokenExpireAt, Date.now())) {
      return { code: -1, message: '邀请链接已过期，请让创建者重新分享' };
    }

    const member = {
      openid,
      nickname: nickname || '',
      avatar: avatar || '',
      // 新成员默认 editor：能记账、能改删自己的记录；
      // 想限制对方就由创建者在管理页改成 viewer
      role: 'editor',
      joinedAt: db.serverDate(),
    };

    // 分享令牌在有效期内可被多人使用（一个群分享的场景），
    // 但仍用条件更新拦住「已在成员列表里的人」并发重复 push。
    const added = await db.collection(LEDGER_COLL)
      .where({ _id: ledgerId, 'members.openid': _.neq(openid) })
      .update({ data: { members: _.push(member) } });

    if (!added.stats || added.stats.updated === 0) {
      return { code: 0, data: ledger, message: '你已在该账本中' };
    }

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

    // 退出者同样知道当前凭证，轮换后旧令牌立即失效，避免「退出再悄悄回来」
    await rotateCredentialsIfActive(ledgerId, ledgerRes.data);

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

    // 被移除者此前可能已读到邀请码/分享令牌，立即轮换，否则他能凭旧凭证重新入账
    await rotateCredentialsIfActive(ledgerId, ledgerRes.data);

    return { code: 0, message: '已移除成员' };
  } catch (err) {
    console.error('Remove member error:', err);
    return { code: -1, message: '移除失败' };
  }
}

/**
 * 调整成员角色（P1-8 信任底座，仅创建者可用）
 * - 目标角色只允许 editor / viewer；owner 不可被授予或变更
 * - 变更即时生效：被改为 viewer 的成员后续写操作会被 ledger-guard 拦下
 */
async function setMemberRole(openid, { ledgerId, targetOpenid, role }) {
  if (!ledgerId) return { code: -1, message: '缺少账本ID' };
  if (!targetOpenid || typeof targetOpenid !== 'string') {
    return { code: -1, message: '缺少目标成员' };
  }
  if (!isValidRole(role) || role === ROLE_OWNER) {
    return { code: -1, message: '角色非法（仅支持「可记账」或「仅查看」，创建者不可变更）' };
  }

  try {
    const ledgerRes = await db.collection(LEDGER_COLL).doc(ledgerId).get();
    const ledger = ledgerRes.data;
    if (!ledger) return { code: -1, message: '账本不存在' };
    if (ledger.ownerOpenid !== openid) {
      return { code: -1, message: '只有创建者可以调整成员角色' };
    }
    if (targetOpenid === ledger.ownerOpenid) {
      return { code: -1, message: '不能修改创建者的角色' };
    }
    if (!(ledger.members || []).some((m) => m && m.openid === targetOpenid)) {
      return { code: -1, message: '该成员不在账本中' };
    }

    // 整体覆盖而非按下标改：微信云数据库不支持 MongoDB 的数组位置操作符 `$.`，
    // 而 pull + push 会把成员排到末尾。家庭/朋友规模下成员变更是低频人工操作，
    // 读改写整体覆盖的并发风险可接受（真出并发也只是角色被上一次的快照覆盖，
    // 创建者重新设置一次即可，不会越权）。
    const currentRole = roleOf(ledger, targetOpenid);
    if (currentRole === role) {
      return { code: 0, data: { _id: ledgerId, targetOpenid, role } };
    }

    const members = (ledger.members || []).map((m) => (
      (m && m.openid === targetOpenid) ? { ...m, role } : m
    ));
    await db.collection(LEDGER_COLL).doc(ledgerId).update({
      data: { members, updatedAt: db.serverDate() },
    });

    return { code: 0, data: { _id: ledgerId, targetOpenid, role } };
  } catch (err) {
    console.error('Set member role error:', err);
    return { code: -1, message: '设置失败' };
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

    // 重置 = 轮换整套凭证：旧邀请码与旧分享链接立即全部失效（这是唯一的撤销手段）
    const credentials = await issueInviteCredentials(Date.now());
    if (credentials.code !== undefined) return credentials;

    await db.collection(LEDGER_COLL).doc(ledgerId).update({ data: credentials });

    return { code: 0, data: inviteView(credentials) };
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
