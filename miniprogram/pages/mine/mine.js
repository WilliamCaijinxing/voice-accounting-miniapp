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

    // ============ 资料编辑 ============
    // 微信已废弃 wx.getUserProfile（2022-10-25 起只返回灰色头像和"微信用户"），
    // 现在正确的做法是 chooseAvatar 按钮 + type="nickname" 输入框，所以改成页内编辑面板。
    editing: false,
    saving: false,
    form: { nickname: '', avatar: '', avatarIsLocal: false },
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

  // ==================== 资料编辑 ====================

  /** 打开资料编辑面板 */
  openEdit() {
    this.setData({
      editing: true,
      saving: false,
      form: {
        nickname: this.data.userInfo.nickname || '',
        avatar: this.data.userInfo.avatar || '',
        avatarIsLocal: false,
      },
    });
  },

  closeEdit() {
    if (this.data.saving) return;
    this.setData({ editing: false });
  },

  onNicknameInput(e) {
    this.setData({ 'form.nickname': e.detail.value });
  },

  /**
   * 微信昵称填写能力只在失焦时给出最终值，input 事件拿到的可能是中间态，
   * 两个事件都以 blur 的值为准，避免用户点了「使用微信昵称」后没生效。
   */
  onNicknameBlur(e) {
    const value = e.detail && e.detail.value;
    if (value !== undefined) this.setData({ 'form.nickname': value });
  },

  /** 头像选择：拿到的是本地临时文件，等保存时才上传云存储 */
  onChooseAvatar(e) {
    const avatarUrl = e.detail && e.detail.avatarUrl;
    if (!avatarUrl) return;
    this.setData({ 'form.avatar': avatarUrl, 'form.avatarIsLocal': true });
  },

  async saveEdit() {
    if (this.data.saving) return;

    const nickname = String(this.data.form.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    if (nickname.length > 12) {
      wx.showToast({ title: '昵称最多 12 个字', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    try {
      let avatar = this.data.form.avatar || '';
      // 选过新头像：本地临时路径必须先传到云存储，否则杀进程后就是裂图
      if (this.data.form.avatarIsLocal && avatar) {
        avatar = await this.uploadAvatar(avatar);
      }

      await userAPI.updateProfile({ nickname, avatar });

      const app = getApp();
      app.globalData.userInfo = { ...(app.globalData.userInfo || {}), nickname, avatar };

      this.setData({ editing: false, saving: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.init();
    } catch (err) {
      console.error('[Mine] 保存资料失败:', err);
      this.setData({ saving: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },

  /** 把临时头像文件传到云存储，返回可直接用于 <image src> 的 fileID */
  async uploadAvatar(localPath) {
    const match = String(localPath).match(/\.(\w+)$/);
    let ext = match ? match[1].toLowerCase() : 'jpg';
    if (ext === 'jpeg') ext = 'jpg';

    const openid = getApp().globalData.openid || 'anon';
    const cloudPath = `avatars/${openid}_${Date.now()}.${ext}`;
    const res = await wx.cloud.uploadFile({ cloudPath, filePath: localPath });
    return res.fileID;
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
      content: '语音记账 v1.1\n说一句话就能记账，智能分类、预算管理、消费分析，帮你管好每一分钱。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
