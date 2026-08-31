// pages/bill-detail/bill-detail.js — 账单详情与编辑
const { formatAmount, formatDate, getToday, getCategoryIcon } = require('../../utils/util');
const { expenseAPI, ledgerAPI } = require('../../utils/cloud');
const app = getApp();

Page({
  data: {
    id: '',
    ledgerId: '',       // 所属账本（共享账本必传）
    loading: true,
    saving: false,
    editing: false,   // 是否处于编辑模式

    // 账单数据
    bill: null,
    recorderName: '',   // 共享账本显示记账人
    categories: [],
    todayStr: getToday(),
  },

  onLoad(options) {
    if (options.id) {
      const ledgerId = options.ledgerId || '';
      this.setData({ id: options.id, ledgerId });
      this.loadDetail(options.id, ledgerId);
    } else {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    }
  },

  async loadDetail(id, ledgerId) {
    try {
      const data = await expenseAPI.detail(id, ledgerId);
      if (!data) {
        wx.showToast({ title: '账单不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }

      this.initCategories(data.type || 'expense');

      const patch = {
        bill: {
          ...data,
          _fmtAmount: formatAmount(data.amount),
          // 预计算分类图标：WXML 中不做函数调用
          _icon: getCategoryIcon(data.categoryId),
        },
        loading: false,
      };

      // 共享账本：拉取成员昵称，显示记账人
      if (ledgerId) {
        try {
          const detail = await ledgerAPI.detail(ledgerId);
          const map = {};
          (detail.members || []).forEach((m) => { map[m.openid] = m.nickname || '成员'; });
          patch.recorderName = map[data._openid] || '成员';
        } catch (e) {
          // ignore
        }
      }

      this.setData(patch);
    } catch (err) {
      console.error('[BillDetail] loadDetail error:', err);
      this.setData({ loading: false });
    }
  },

  initCategories(type) {
    const config = app.globalData.categoryConfig;
    const list = (config[type] || []).map((c) => ({
      ...c,
      icon: getCategoryIcon(c.id),
    }));
    this.setData({ categories: list });
  },

  // ==================== 编辑模式切换 ====================

  toggleEdit() {
    this.setData({ editing: !this.data.editing });
  },

  // ==================== 编辑操作 ====================

  // 切换收支类型
  switchType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.bill.type) return;
    this.initCategories(type);
    // 切换类型时默认选第一个分类
    const firstCat = (app.globalData.categoryConfig[type] || [])[0] || {};
    this.setData({
      'bill.type': type,
      'bill.categoryId': firstCat.id || '',
      'bill.categoryName': firstCat.name || '',
      'bill._icon': getCategoryIcon(firstCat.id || ''),
    });
  },

  // 金额输入
  onAmountInput(e) {
    const val = e.detail.value;
    // 只允许数字和小数点
    const cleaned = val.replace(/[^\d.]/g, '');
    this.setData({
      'bill._rawAmount': cleaned,
    });
  },

  // 金额失焦 — 转换为分
  onAmountBlur(e) {
    let val = parseFloat(e.detail.value) || 0;
    const cents = Math.round(val * 100);
    this.setData({
      'bill.amount': cents,
      'bill._fmtAmount': formatAmount(cents),
      'bill._rawAmount': '',
    });
  },

  // 分类选择
  selectCategory(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      'bill.categoryId': id,
      'bill.categoryName': name,
      'bill._icon': getCategoryIcon(id),
    });
  },

  // 日期选择
  onDateChange(e) {
    this.setData({ 'bill.date': e.detail.value });
  },

  // 备注
  onDescInput(e) {
    this.setData({ 'bill.description': e.detail.value });
  },

  // ==================== 保存 ====================

  async saveBill() {
    const { bill } = this.data;
    if (!bill) return;

    if (!bill.amount || bill.amount <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    try {
      await expenseAPI.update(bill._id, {
        amount: bill.amount,
        type: bill.type,
        categoryId: bill.categoryId,
        categoryName: bill.categoryName,
        date: bill.date,
        description: bill.description,
        ledgerId: this.data.ledgerId,
      });

      wx.showToast({ title: '保存成功', icon: 'success' });
      this.setData({ saving: false, editing: false });

      // 更新本地 bill 的格式化金额
      this.setData({
        'bill._fmtAmount': formatAmount(bill.amount),
      });
    } catch (err) {
      this.setData({ saving: false });
    }
  },

  // ==================== 删除 ====================

  deleteBill() {
    wx.showModal({
      title: '确认删除',
      content: '删除后不可恢复，确定删除这条账单吗？',
      confirmText: '删除',
      confirmColor: '#FA5151',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          try {
            await expenseAPI.delete(this.data.id, this.data.ledgerId);
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 1000);
          } catch (err) {
            // error handled in cloud.js
          }
        }
      },
    });
  },

  // ==================== 返回 ====================

  onShareAppMessage() {
    return {
      title: '语音记账，一句话搞定！',
      path: '/pages/index/index',
    };
  },
});
