// cloudfunctions/userLogin/index.js
// 用户静默登录 — 通过 wx.login code 换取 openid
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const USERS_COLL = 'users';
const LEDGER_COLL = 'ledgers';

exports.main = async (event) => {
  const { OPENID, APPID } = cloud.getWXContext();
  const { action } = event;

  if (!OPENID) {
    return { code: -1, message: '获取用户标识失败' };
  }

  try {
    // 静默登录（默认）
    if (!action || action === 'login') {
      return await doLogin(OPENID);
    }

    // 获取最新用户信息
    if (action === 'get') {
      const res = await db.collection(USERS_COLL)
        .where({ _openid: OPENID })
        .limit(1)
        .get();
      if (res.data.length === 0) {
        return await doLogin(OPENID); // 未注册则先注册
      }
      return { code: 0, data: res.data[0] };
    }

    // 更新资料（昵称/头像）
    if (action === 'updateProfile') {
      const update = {};
      if (event.nickname !== undefined) {
        const nickname = String(event.nickname).trim().slice(0, 20);
        if (!nickname) return { code: -1, message: '昵称不能为空' };
        update.nickname = nickname;
      }
      if (event.avatar !== undefined) {
        // 头像只会是云存储 fileID（cloud://...）或 https 链接，
        // 其它形态一律拒绝，避免把任意字符串塞进 <image src>
        const avatar = String(event.avatar);
        if (avatar && !/^(cloud:\/\/|https:\/\/)/.test(avatar)) {
          return { code: -1, message: '头像格式不正确' };
        }
        update.avatar = avatar.slice(0, 500);
      }

      const res = await db.collection(USERS_COLL)
        .where({ _openid: OPENID })
        .limit(1)
        .get();

      if (res.data.length === 0) {
        return await doLogin(OPENID);
      }

      await db.collection(USERS_COLL).doc(res.data[0]._id).update({
        data: { ...update, updatedAt: db.serverDate() },
      });

      // 账本里的成员昵称是「加入当时的快照」，必须回写一次，
      // 否则用户改名后，共享账本账单里显示的仍是旧名字。
      const synced = await syncLedgerMemberProfile(OPENID, update);

      const updated = await db.collection(USERS_COLL).doc(res.data[0]._id).get();
      return { code: 0, data: updated.data, syncedLedgers: synced };
    }

    return { code: -1, message: 'Unknown action: ' + action };
  } catch (err) {
    console.error('Login error:', err);
    // 不回传 err.message（P1-18）：数据库原始报错会暴露集合名/字段等内部结构。
    // 完整错误已由上面的 console.error 落到云函数日志。
    return { code: -1, message: '登录失败，请重试', error: 'LOGIN_FAILED' };
  }
};

/**
 * 把昵称/头像同步到该用户已加入的所有共享账本。
 *
 * ledgers.members 存的是「加入当时」的昵称快照，首页/账单详情的"谁记的"
 * 都从 members 取，所以改名后不回写就等于没改。
 *
 * 微信云开发不支持 MongoDB 的 positional operator（members.$.nickname），
 * 只能整数组替换；单个用户参与的账本数量很少，代价可以接受。
 *
 * 同步失败不回滚资料保存：用户至少能看到"已保存"，旧昵称下次改名时会再同步一次。
 */
async function syncLedgerMemberProfile(openid, patch) {
  if (!patch || (patch.nickname === undefined && patch.avatar === undefined)) return 0;
  try {
    const res = await db.collection(LEDGER_COLL)
      .where({ 'members.openid': openid })
      .limit(100)
      .get();

    let synced = 0;
    for (const ledger of res.data || []) {
      const members = ledger.members || [];
      if (!members.some((m) => m && m.openid === openid)) continue;

      const next = members.map((m) => {
        if (!m || m.openid !== openid) return m;
        const merged = { ...m };
        if (patch.nickname !== undefined) merged.nickname = patch.nickname;
        if (patch.avatar !== undefined) merged.avatar = patch.avatar;
        return merged;
      });

      await db.collection(LEDGER_COLL).doc(ledger._id).update({ data: { members: next } });
      synced += 1;
    }
    return synced;
  } catch (err) {
    console.error('Sync ledger member profile failed:', err);
    return 0;
  }
}

/**
 * 静默登录：查询或创建用户
 */
async function doLogin(openid) {
  // 查询用户是否已存在
  const userRes = await db.collection(USERS_COLL)
    .where({ _openid: openid })
    .limit(1)
    .get();

  let userInfo;

  if (userRes.data.length > 0) {
    // 老用户 — 更新最后登录时间
    userInfo = userRes.data[0];
    await db.collection(USERS_COLL).doc(userInfo._id).update({
      data: {
        lastLoginAt: db.serverDate(),
        loginCount: db.command.inc(1),
      },
    });
  } else {
    // 新用户 — 创建记录
    const newDoc = await db.collection(USERS_COLL).add({
      data: {
        _openid: openid,
        nickname: '',
        avatar: '',
        createdAt: db.serverDate(),
        lastLoginAt: db.serverDate(),
        loginCount: 1,
      },
    });
    userInfo = { _id: newDoc._id, _openid: openid };
  }

  return {
    code: 0,
    openid,
    userInfo,
  };
}
