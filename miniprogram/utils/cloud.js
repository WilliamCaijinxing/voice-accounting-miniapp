// utils/cloud.js — 云函数调用封装
const app = getApp();

/**
 * 封装 wx.cloud.callFunction，统一错误处理
 * 每次 setData 都跨双线程桥 — 在调用层做最小 payload 提取
 */
const callCloud = async (name, data = {}) => {
  try {
    const res = await wx.cloud.callFunction({ name, data });
    if (res.result && res.result.code === 0) {
      return res.result.data;
    }
    throw { code: res.result?.code || -1, message: res.result?.message || '云函数调用失败' };
  } catch (err) {
    console.error(`[Cloud] ${name} error:`, err);
    wx.showToast({ title: err.message || '网络异常', icon: 'none' });
    throw err;
  }
};

/** 当前账本 ledgerId（个人账本为空字符串） */
const currentLedgerId = () => {
  const ledger = (app && app.globalData && app.globalData.currentLedger) || { id: '' };
  return ledger.id || '';
};

/**
 * 账目相关 API
 */
const expenseAPI = {
  // 创建账目（data 可含 ledgerId）
  create: (data) => callCloud('expenseCRUD', { action: 'create', ...data }),

  // 获取列表（分页）；params.ledgerId 可选
  list: (params = {}) => callCloud('expenseCRUD', {
    action: 'list',
    page: params.page || 1,
    pageSize: params.pageSize || 20,
    startDate: params.startDate || '',
    endDate: params.endDate || '',
    categoryId: params.categoryId || '',
    type: params.type || '',
    ledgerId: params.ledgerId || '',
  }),

  // 获取单条（ledgerId 可选）
  detail: (id, ledgerId = '') => callCloud('expenseCRUD', { action: 'detail', id, ledgerId }),

  // 更新（data 可含 ledgerId）
  update: (id, data) => {
    const { ledgerId, ...rest } = data;
    return callCloud('expenseCRUD', { action: 'update', id, ledgerId: ledgerId || '', ...rest });
  },

  // 删除（ledgerId 可选）
  delete: (id, ledgerId = '') => callCloud('expenseCRUD', { action: 'delete', id, ledgerId }),
};

/**
 * 统计相关 API
 */
const statsAPI = {
  // 月度汇总（ledgerId 可选）
  monthly: (year, month, ledgerId = '') => callCloud('statistics', {
    action: 'monthly',
    year: year || new Date().getFullYear(),
    month: month || new Date().getMonth() + 1,
    ledgerId,
  }),

  // 今日汇总
  today: (ledgerId = '') => callCloud('statistics', { action: 'today', ledgerId }),

  // 分类统计
  categoryStats: (startDate, endDate, type = 'expense', ledgerId = '') =>
    callCloud('statistics', { action: 'categoryStats', startDate, endDate, type, ledgerId }),

  // 每日趋势
  dailyTrend: (year, month, ledgerId = '') => callCloud('statistics', {
    action: 'dailyTrend',
    year: year || new Date().getFullYear(),
    month: month || new Date().getMonth() + 1,
    ledgerId,
  }),

  // 多维度汇总（today/week/month/year）
  summary: (range, ledgerId = '') => callCloud('statistics', { action: 'summary', range, ledgerId }),

  // 日历数据：某年某月每天收支
  calendar: (year, month, ledgerId = '') => callCloud('statistics', {
    action: 'calendar',
    year: year || new Date().getFullYear(),
    month: month || new Date().getMonth() + 1,
    ledgerId,
  }),

  // 趋势数据（周/月/年聚合）；params 可含 ledgerId
  trend: (params = {}) => callCloud('statistics', { action: 'trend', ...params }),
};

/**
 * 用户相关 API
 */
const userAPI = {
  // 静默登录（app.js 已调用，这里供手动触发）
  login: (code) => callCloud('userLogin', { action: 'login', code }),

  // 获取用户信息
  get: () => callCloud('userLogin', { action: 'get' }),

  // 更新资料（昵称/头像）
  updateProfile: (data) => callCloud('userLogin', { action: 'updateProfile', ...data }),
};

/**
 * 预算相关 API
 */
const budgetAPI = {
  // 获取预算（ledgerId 可选）
  get: (ledgerId = '') => callCloud('budgetCRUD', { action: 'get', ledgerId }),
  // 设置预算（data 可含 ledgerId）
  set: (data) => callCloud('budgetCRUD', { action: 'set', ...data }),
};

/**
 * 账本/群组相关 API（groupCRUD）
 */
const ledgerAPI = {
  // 创建账本
  create: (name, nickname = '', avatar = '') =>
    callCloud('groupCRUD', { action: 'create', name, nickname, avatar }),

  // 我的账本列表（个人账本 + 共享账本）
  list: () => callCloud('groupCRUD', { action: 'list' }),

  // 账本详情（成员列表）
  detail: (ledgerId) => callCloud('groupCRUD', { action: 'detail', ledgerId }),

  // 邀请码加入
  joinByCode: (code, nickname = '', avatar = '') =>
    callCloud('groupCRUD', { action: 'joinByCode', code, nickname, avatar }),

  // 分享卡片加入（token 为创建者签发的限时分享令牌，仅有 ledgerId 不再能入账）
  joinByShare: (ledgerId, token, nickname = '', avatar = '') =>
    callCloud('groupCRUD', { action: 'joinByShare', ledgerId, token, nickname, avatar }),

  // 退出账本
  quit: (ledgerId) => callCloud('groupCRUD', { action: 'quit', ledgerId }),

  // 移除成员（仅创建者）
  removeMember: (ledgerId, targetOpenid) =>
    callCloud('groupCRUD', { action: 'removeMember', ledgerId, targetOpenid }),

  // 重生成邀请码（仅创建者）
  regenerateCode: (ledgerId) => callCloud('groupCRUD', { action: 'regenerateCode', ledgerId }),

  // 解散账本（仅创建者）
  dissolve: (ledgerId) => callCloud('groupCRUD', { action: 'dissolve', ledgerId }),
};

/**
 * 导出 API
 */
const exportAPI = {
  // 导出 CSV
  exportCSV: (params) => callCloud('exportData', { action: 'exportCSV', ...params }),
};

/**
 * 语音解析 API
 */
const voiceAPI = {
  // 解析语音文本为结构化账目
  parse: (text) => callCloud('parseVoice', { action: 'parse', text }),

  // 语音识别一体化：ASR + NLP 解析一次云函数调用完成（base64 直传，无需云存储）
  // 返回完整 result（含 fallback/asr_empty/parseFailed 分支），不走 callCloud 过滤
  recognize: (audioBase64, voiceFormat = 'mp3') => new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'voiceToText',
      data: { audioBase64, voiceFormat },
      success: (res) => resolve(res.result || {}),
      fail: (err) => {
        console.error('[Cloud] voiceToText error:', err);
        reject(err);
      },
    });
  }),
};

module.exports = {
  callCloud,
  expenseAPI,
  statsAPI,
  voiceAPI,
  budgetAPI,
  exportAPI,
  userAPI,
  ledgerAPI,
  currentLedgerId,
};
