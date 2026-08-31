// cloudfunctions/budgetCRUD/index.js
// 预算管理：查询/设置月度预算（支持个人账本与共享账本）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  switch (action) {
    case 'get': return getBudget(OPENID, event);
    case 'set': return setBudget(OPENID, event);
    default: return { code: -1, message: 'Unknown action: ' + action };
  }
};

/**
 * 获取预算（个人或共享账本）
 */
async function getBudget(openid, { ledgerId }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const ym = `${year}-${String(month).padStart(2, '0')}`;

  try {
    let monthRes, yearRes;

    if (ledgerId) {
      // 共享账本预算：按 ledgerId 查询
      monthRes = await db.collection('budgets')
        .where({ ledgerId, ym })
        .limit(1)
        .get();
      yearRes = await db.collection('budgets')
        .where({ ledgerId, type: 'year', year })
        .limit(1)
        .get();
    } else {
      // 个人账本预算：本人 + 无 ledgerId 字段
      monthRes = await db.collection('budgets')
        .where({ _openid: openid, ledgerId: _.exists(false), ym })
        .limit(1)
        .get();
      yearRes = await db.collection('budgets')
        .where({ _openid: openid, ledgerId: _.exists(false), type: 'year', year })
        .limit(1)
        .get();
    }

    const monthBudget = monthRes.data.length > 0 ? monthRes.data[0] : null;
    const yearBudget = yearRes.data.length > 0 ? yearRes.data[0] : null;

    return {
      code: 0,
      data: {
        monthlyBudget: monthBudget ? monthBudget.amount / 100 : 0,
        monthlyId: monthBudget ? monthBudget._id : null,
        yearBudget: yearBudget ? yearBudget.amount / 100 : 0,
        yearId: yearBudget ? yearBudget._id : null,
        ym,
        year,
      },
    };
  } catch (err) {
    console.error('Get budget error:', err);
    return { code: -1, message: '获取预算失败' };
  }
}

/**
 * 设置预算（支持月度预算和年度预算，个人或共享账本）
 * 金额以"元"传入，内部统一存储为分
 */
async function setBudget(openid, event) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const { ledgerId } = event;

  // 金额以"元"传入，内部统一存储为分
  const monthlyAmount = event.monthlyBudget !== undefined ? Math.round(Number(event.monthlyBudget) * 100) : null;
  const yearlyAmount = event.yearBudget !== undefined ? Math.round(Number(event.yearBudget) * 100) : null;

  try {
    const results = {};

    // ---- 设置月度预算 ----
    if (monthlyAmount !== null) {
      const cond = ledgerId
        ? { ledgerId, ym }
        : { _openid: openid, ledgerId: _.exists(false), ym };

      const exist = await db.collection('budgets')
        .where(cond)
        .limit(1)
        .get();

      if (exist.data.length > 0) {
        await db.collection('budgets').doc(exist.data[0]._id).update({
          data: { amount: monthlyAmount, updatedAt: db.serverDate() },
        });
        results.monthly = { id: exist.data[0]._id, amount: monthlyAmount };
      } else {
        const addDoc = ledgerId
          ? { ledgerId, type: 'month', ym, year, month, amount: monthlyAmount, createdAt: db.serverDate(), updatedAt: db.serverDate() }
          : { _openid: openid, type: 'month', ym, year, month, amount: monthlyAmount, createdAt: db.serverDate(), updatedAt: db.serverDate() };
        const addRes = await db.collection('budgets').add({ data: addDoc });
        results.monthly = { id: addRes._id, amount: monthlyAmount };
      }
    }

    // ---- 设置年度预算 ----
    if (yearlyAmount !== null) {
      const cond = ledgerId
        ? { ledgerId, type: 'year', year }
        : { _openid: openid, ledgerId: _.exists(false), type: 'year', year };

      const existYear = await db.collection('budgets')
        .where(cond)
        .limit(1)
        .get();

      if (existYear.data.length > 0) {
        await db.collection('budgets').doc(existYear.data[0]._id).update({
          data: { amount: yearlyAmount, updatedAt: db.serverDate() },
        });
        results.year = { id: existYear.data[0]._id, amount: yearlyAmount };
      } else {
        const addDoc = ledgerId
          ? { ledgerId, type: 'year', ym: `${year}-00`, year, month: 0, amount: yearlyAmount, createdAt: db.serverDate(), updatedAt: db.serverDate() }
          : { _openid: openid, type: 'year', ym: `${year}-00`, year, month: 0, amount: yearlyAmount, createdAt: db.serverDate(), updatedAt: db.serverDate() };
        const addRes = await db.collection('budgets').add({ data: addDoc });
        results.year = { id: addRes._id, amount: yearlyAmount };
      }
    }

    return { code: 0, data: results };
  } catch (err) {
    console.error('Set budget error:', err);
    return { code: -1, message: '保存预算失败' };
  }
}
