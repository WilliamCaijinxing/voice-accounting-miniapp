// pages/ledger/ledger.js — 共享账本管理（列表 / 创建 / 加入 / 成员 / 邀请码 / 退出）
const { ledgerAPI } = require('../../utils/cloud');
const app = getApp();

Page({
  data: {
    // 共享账本列表
    ledgers: [],
    myOpenid: '',
    loading: true,

    // 详情弹层（成员 / 邀请码 / 操作）
    showDetail: false,
    detail: null,        // { _id, name, ownerOpenid, inviteCode, members, isOwner }

    // 创建弹层
    showCreate: false,
    newLedgerName: '',

    // 邀请码加入弹层
    showJoin: false,
    joinCode: '',
  },

  onLoad() {
    this.setData({ myOpenid: app.globalData.openid || '' });
  },

  onShow() {
    this.loadLedgers();
  },

  async loadLedgers() {
    this.setData({ loading: true });
    try {
      const res = await ledgerAPI.list();
      const list = (res && res.list) || [];
      this.setData({
        ledgers: list,
        myOpenid: app.globalData.openid || this.data.myOpenid,
        loading: false,
      });
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  // ============ 创建账本 ============
  openCreate() {
    this.setData({ showCreate: true, newLedgerName: '' });
  },
  closeCreate() {
    this.setData({ showCreate: false });
  },
  onLedgerNameInput(e) {
    this.setData({ newLedgerName: e.detail.value });
  },
  async confirmCreate() {
    const name = this.data.newLedgerName.trim();
    if (!name) {
      wx.showToast({ title: '请输入账本名称', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '创建中...' });
    try {
      const userInfo = app.globalData.userInfo || {};
      const ledger = await ledgerAPI.create(name, userInfo.nickName || '', userInfo.avatarUrl || '');
      wx.hideLoading();
      this.setData({ showCreate: false });
      // 创建后自动切换为该账本
      app.setCurrentLedger({ id: ledger._id, name: ledger.name, type: 'shared' });
      wx.showToast({ title: '创建成功', icon: 'success' });
      this.loadLedgers();
    } catch (err) {
      wx.hideLoading();
    }
  },

  // ============ 邀请码加入 ============
  openJoin() {
    this.setData({ showJoin: true, joinCode: '' });
  },
  closeJoin() {
    this.setData({ showJoin: false });
  },
  onJoinCodeInput(e) {
    this.setData({ joinCode: (e.detail.value || '').toUpperCase() });
  },
  async confirmJoin() {
    const code = this.data.joinCode.trim().toUpperCase();
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '加入中...' });
    try {
      const userInfo = app.globalData.userInfo || {};
      const ledger = await ledgerAPI.joinByCode(code, userInfo.nickName || '', userInfo.avatarUrl || '');
      wx.hideLoading();
      this.setData({ showJoin: false });
      app.setCurrentLedger({ id: ledger._id, name: ledger.name, type: 'shared' });
      wx.showToast({ title: '已加入账本', icon: 'success' });
      this.loadLedgers();
    } catch (err) {
      wx.hideLoading();
    }
  },

  // ============ 详情 / 成员 ============
  async openDetail(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.showLoading({ title: '加载中...' });
    try {
      const detail = await ledgerAPI.detail(id);
      this.setData({
        showDetail: true,
        detail: this.normalizeDetail(detail),
        loading: false,
      });
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
    }
  },

  /** 规整成员展示字段 */
  normalizeDetail(detail) {
    if (!detail) return null;
    const members = (detail.members || []).map((m) => ({
      ...m,
      displayName: m.nickname || (m.openid === detail.ownerOpenid ? '创建者' : '成员'),
      isOwner: m.openid === detail.ownerOpenid,
    }));
    return { ...detail, members };
  },

  closeDetail() {
    this.setData({ showDetail: false, detail: null });
  },

  // 切换到该账本（设为当前）
  switchToLedger(e) {
    const { id, name } = e.currentTarget.dataset;
    app.setCurrentLedger({ id, name, type: 'shared' });
    wx.showToast({ title: '已切换到该账本', icon: 'success' });
    this.closeDetail();
  },

  // 复制邀请码
  copyInviteCode() {
    const code = this.data.detail && this.data.detail.inviteCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
    });
  },

  // 重生成邀请码（仅创建者）
  async regenerateCode() {
    const detail = this.data.detail;
    if (!detail || !detail.isOwner) return;
    wx.showLoading({ title: '生成中...' });
    try {
      const res = await ledgerAPI.regenerateCode(detail._id);
      wx.hideLoading();
      this.setData({ 'detail.inviteCode': res.inviteCode });
      wx.showToast({ title: '已重生成', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
    }
  },

  // 移除成员（仅创建者）
  async removeMember(e) {
    const { openid, name } = e.currentTarget.dataset;
    if (!openid) return;
    const detail = this.data.detail;
    if (!detail || !detail.isOwner) return;
    wx.showModal({
      title: '移除成员',
      content: `确定将「${name || '该成员'}」移出账本？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '移除中...' });
        try {
          await ledgerAPI.removeMember(detail._id, openid);
          wx.hideLoading();
          wx.showToast({ title: '已移除', icon: 'success' });
          const updated = await ledgerAPI.detail(detail._id);
          this.setData({ detail: this.normalizeDetail(updated) });
          this.loadLedgers();
        } catch (err) {
          wx.hideLoading();
        }
      },
    });
  },

  // 退出账本（成员）
  async quitLedger() {
    const detail = this.data.detail;
    if (!detail || detail.isOwner) {
      wx.showToast({ title: '创建者请解散账本', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '退出账本',
      content: `确定退出「${detail.name}」？退出后将不再看到该账本的数据。`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '退出中...' });
        try {
          await ledgerAPI.quit(detail._id);
          wx.hideLoading();
          this.setData({ showDetail: false, detail: null });
          wx.showToast({ title: '已退出', icon: 'success' });
          this.loadLedgers();
        } catch (err) {
          wx.hideLoading();
        }
      },
    });
  },

  // 解散账本（仅创建者）
  async dissolveLedger() {
    const detail = this.data.detail;
    if (!detail || !detail.isOwner) return;
    wx.showModal({
      title: '解散账本',
      content: `确定解散「${detail.name}」？账本内所有成员、账目与预算将被删除，且不可恢复。`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '解散中...' });
        try {
          await ledgerAPI.dissolve(detail._id);
          wx.hideLoading();
          this.setData({ showDetail: false, detail: null });
          // 若当前正使用该账本，回退到个人账本
          const cur = app.getCurrentLedger();
          if (cur.type === 'shared' && cur.id === detail._id) {
            app.setCurrentLedger({ id: '', name: '我的账本', type: 'personal' });
          }
          wx.showToast({ title: '已解散', icon: 'success' });
          this.loadLedgers();
        } catch (err) {
          wx.hideLoading();
        }
      },
    });
  },

  noop() {},

  // ============ 分享给微信好友（分享卡片含 ledgerId，对方点开即加入） ============
  onShareAppMessage() {
    const detail = this.data.detail;
    if (detail) {
      return {
        title: `邀请你加入「${detail.name}」一起记账`,
        path: `/pages/index/index?ledgerId=${detail._id}&invite=1`,
      };
    }
    return {
      title: '语音记账，一句话搞定！',
      path: '/pages/index/index',
    };
  },
});
