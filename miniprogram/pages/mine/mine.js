// pages/mine/mine.js — 我的页面
const { userAPI } = require('../../utils/cloud');

Page({
  data: {
    userInfo: {
      nickname: '',
      avatar: '',
      loginCount: 0,
    },
    openidTail: '',
    loading: true,

    // 当前账本（「功能入口」里的「当前账本」一项要用）
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
    try {
      // 这里原来并发取 today / month / budget 三份数据（共 3 次云函数调用），
      // 只为了填「数据概览」卡。卡片删除后它们没有任何读取方，一并去掉。
      const user = await userAPI.get().catch(() => null);

      const app = getApp();
      if (user) {
        app.globalData.userInfo = user;
      }

      const openid = app.globalData.openid || (user && user._openid) || '';
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

  goToLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' });
  },

  /**
   * 记账技巧。语音记账真正的门槛是「怎么说」——首屏只有一行示例，
   * 用户第二次进来就记不住说什么能识别准，这里给一份常驻说明。
   * 不加后端、不加页面，就是一段静态文案。
   */
  showTips() {
    wx.showModal({
      title: '怎么说更准',
      content: [
        '1. 一句话只记一笔：说「午餐35元」，别把两笔连在一起说。',
        '2. 金额带上单位：说「35元」「35块」，只说「35」容易被当成日期。',
        '3. 分类会自动判断：「打车」「地铁」归交通，「午餐」「奶茶」归餐饮。',
        '4. 收入直接说：「工资15000」「收到红包200」会自动记为收入。',
        '5. 识别错了不用重说：确认卡片上点一下金额就能直接改。',
      ].join('\n'),
      showCancel: false,
      confirmText: '知道了',
    });
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
