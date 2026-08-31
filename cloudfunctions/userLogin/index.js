// cloudfunctions/userLogin/index.js
// 用户静默登录 — 通过 wx.login code 换取 openid
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const USERS_COLL = 'users';

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
      if (event.nickname !== undefined) update.nickname = String(event.nickname).slice(0, 30);
      if (event.avatar !== undefined) update.avatar = String(event.avatar).slice(0, 500);

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

      const updated = await db.collection(USERS_COLL).doc(res.data[0]._id).get();
      return { code: 0, data: updated.data };
    }

    return { code: -1, message: 'Unknown action: ' + action };
  } catch (err) {
    console.error('Login error:', err);
    return { code: -1, message: '登录失败', error: err.message };
  }
};

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
