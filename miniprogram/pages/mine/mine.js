// pages/mine/mine.js — 我的页面
const { formatAmount } = require('../../utils/util');
const { userAPI, statsAPI, budgetAPI, currentLedgerId } = require('../../utils/cloud');

Page({
  data: {
    userInfo: {
      nickname: '',
      avatar: '',
      loginCount: 0,
    },
    openidTail: '',
    todayExpense: '0',
    monthExpense: '0',
    monthIncome: '0',
    budgetPercent: 0,
    hasBudget: false,
    budgetRemaining: '0',
    loading: true,

    // 当前账本（概览所属）
    currentLedgerName: '我的账本',
    isShared: false,
  },

  onShow() {
    this.init();
  },

  async init() {
    this.setData({ loading: true });
    const ledgerId = currentLedgerId();
    try {
      const [user, today, month, budget] = await Promise.all([
        userAPI.get().catch(() => null),
        statsAPI.summary('today', ledgerId).catch(() => null),
        statsAPI.summary('month', ledgerId).catch(() => null),
        budgetAPI.get(ledgerId).catch(() => null),
      ]);

      const app = getApp();
      if (user) {
        app.globalData.userInfo = user;
      }

      const openid = app.globalData.openid || (user && user._openid) || '';
      const percent = budget && budget.monthlyBudget > 0
        ? Math.min(100, Math.round(((month ? month.totalExpense : 0) / 100 / budget.monthlyBudget) * 100))
        : 0;
      const remaining = budget && budget.monthlyBudget > 0
        ? (budget.monthlyBudget - ((month ? month.totalExpense : 0) / 100)).toFixed(2)
        : '0';

      const ledger = app.getCurrentLedger();
      this.setData({
        userInfo: {
          nickname: user && user.nickname ? user.nickname : '',
          avatar: user && user.avatar ? user.avatar : '',
          loginCount: user ? user.loginCount || 0 : 0,
        },
        openidTail: openid ? openid.slice(-6) : '',
        currentLedgerName: ledger.name,
        isShared: ledger.type === 'shared',
        todayExpense: formatAmount(today ? today.totalExpense : 0),
        monthExpense: formatAmount(month ? month.totalExpense : 0),
        monthIncome: formatAmount(month ? month.totalIncome : 0),
        budgetPercent: percent,
        hasBudget: !!(budget && budget.monthlyBudget > 0),
        budgetRemaining: remaining,
        loading: false,
      });
    } catch (err) {
      console.error('Mine init error:', err);
      this.setData({ loading: false });
    }
  },

  /** 完善资料：优先微信授权头像昵称，拒绝则手动输入昵称 */
  async editProfile() {
    // 方式一：微信头像昵称填写能力（新版基础库）
    if (wx.getUserProfile) {
      try {
        const { userInfo } = await this.promisify(wx.getUserProfile)({
          desc: '用于完善记账用户资料',
        });
        if (userInfo && userInfo.nickName) {
          await this.saveProfile(userInfo.nickName, userInfo.avatarUrl);
          return;
        }
      } catch (err) {
        // 用户拒绝，走手动输入
      }
    }

    // 方式二：手动输入昵称
    this.setNickname();
  },

  /** 手动设置昵称 */
  setNickname() {
    const current = this.data.userInfo.nickname || '';
    wx.showModal({
      title: '设置昵称',
      editable: true,
      placeholderText: '请输入昵称（最多10个字）',
      content: current,
      success: async (res) => {
        if (res.confirm && res.content && res.content.trim()) {
          await this.saveProfile(res.content.trim(), this.data.userInfo.avatar);
        }
      },
    });
  },

  async saveProfile(nickname, avatar) {
    try {
      await userAPI.updateProfile({ nickname, avatar: avatar || '' });
      wx.showToast({ title: '资料已保存', icon: 'success' });
      this.init();
    } catch (err) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  goToBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' });
  },

  goToExport() {
    wx.navigateTo({ url: '/pages/export/export' });
  },

  goToStats() {
    wx.switchTab({ url: '/pages/statistics/statistics' });
  },

  goToLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' });
  },

  showAbout() {
    wx.showModal({
      title: '关于语音记账',
      content: '语音记账 v1.0\n说一句话就能记账，智能分类、预算管理、消费分析，帮你管好每一分钱。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  promisify(api) {
    return (options = {}) => new Promise((resolve, reject) => {
      api({ ...options, success: resolve, fail: reject });
    });
  },
});
