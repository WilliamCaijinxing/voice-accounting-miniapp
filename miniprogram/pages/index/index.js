// pages/index/index.js — 首页仪表盘
const { formatAmount, formatDate, getToday, getCategoryIcon } = require('../../utils/util');
const { expenseAPI, statsAPI, budgetAPI, ledgerAPI } = require('../../utils/cloud');

Page({
  data: {
    todayStats: { totalExpense: 0, totalIncome: 0, recordCount: 0, categoryBreakdown: [] },
    monthStats: null,
    recentList: [],
    todayText: '',
    currentMonth: new Date().getMonth() + 1,
    currentMonthDay: new Date().getDate(),
    loading: true,

    // 预算
    budget: null,
    budgetPercent: 0,
    budgetRemaining: 0,

    // 账本切换
    ledgers: [{ id: '', name: '我的账本', type: 'personal' }],
    currentLedgerId: '',
  },

  onLoad(options) {
    const now = new Date();
    this.setData({
      todayText: `${now.getMonth() + 1}月${now.getDate()}日 ${this.getWeekday(now.getDay())}`,
      currentMonth: now.getMonth() + 1,
    });
    // 通过分享卡片进入：自动加入共享账本
    if (options && options.ledgerId) {
      this.handleShareJoin(options.ledgerId);
    }
    this.refresh();
  },

  // 分享卡片携带 ledgerId 进入时，自动加入并切换
  async handleShareJoin(ledgerId) {
    try {
      const userInfo = getApp().globalData.userInfo || {};
      const ledger = await ledgerAPI.joinByShare(ledgerId, userInfo.nickName || '', userInfo.avatarUrl || '');
      getApp().setCurrentLedger({ id: ledger._id, name: ledger.name, type: 'shared' });
      wx.showToast({ title: '已加入共享账本', icon: 'success' });
    } catch (err) {
      // 已加入 / 账本不存在等情况静默处理
      console.warn('[Index] share join failed:', err);
    }
  },

  onShow() {
    // 每次切回首页都刷新数据（先刷新账本列表，再刷新数据）
    this.refresh();
  },

  // 刷新：先加载账本列表（含校验当前账本有效性），再加载数据
  async refresh() {
    await this.loadLedgers().catch(() => {});
    await this.loadData().catch(() => {});
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true });
    const app = getApp();
    const ledger = app.getCurrentLedger();
    const ledgerId = ledger.id || '';

    try {
      const [todayData, monthData, recentData] = await Promise.all([
        statsAPI.today(ledgerId),
        statsAPI.monthly(new Date().getFullYear(), new Date().getMonth() + 1, ledgerId),
        expenseAPI.list({ page: 1, pageSize: 10, ledgerId }),
      ]);

      const today = todayData || { totalExpense: 0, totalIncome: 0, recordCount: 0, categoryBreakdown: [] };
      const month = monthData || { totalExpense: 0, totalIncome: 0, recordCount: 0, daysWithRecords: 0, avgDailyExpense: 0, balance: 0 };
      const list = (recentData && recentData.list) || [];

      // 构建记账人昵称映射（仅共享账本需要显示"谁记的"）
      let openidMap = {};
      if (ledger.type === 'shared' && ledger.id) {
        try {
          const detail = await ledgerAPI.detail(ledger.id);
          (detail.members || []).forEach((m) => { openidMap[m.openid] = m.nickname || '成员'; });
        } catch (e) {
          console.warn('Ledger detail failed', e);
        }
      }

      // 预计算格式化字符串，不在 WXML 中调用函数
      this.setData({
        todayStats: {
          ...today,
          _fmtTotalExpense: formatAmount(today.totalExpense),
          _fmtTotalIncome: formatAmount(today.totalIncome),
        },
        monthStats: {
          ...month,
          _fmtTotalExpense: formatAmount(month.totalExpense),
          _fmtTotalIncome: formatAmount(month.totalIncome),
          _fmtBalance: formatAmount(Math.abs(month.balance || 0)),
          _balanceSign: (month.balance || 0) >= 0 ? '+' : '-',
          _balanceClass: (month.balance || 0) >= 0 ? 'income' : 'expense',
        },
        recentList: list.map(item => ({
          ...item,
          _fmtAmount: formatAmount(item.amount),
          _sign: item.type === 'income' ? '+' : '-',
          recorderName: ledger.type === 'shared' ? (openidMap[item._openid] || '成员') : '',
        })),
        loading: false,
      });

      // 并行加载预算信息（失败不影响主流程）
      this.loadBudgetInfo(month.totalExpense, ledgerId).catch(() => {});
    } catch (err) {
      console.error('[Index] loadData error:', err);
      this.setData({ loading: false });
    }
  },

  // 加载预算信息（共享账本传入 ledgerId）
  async loadBudgetInfo(monthExpense, ledgerId = '') {
    try {
      const budget = await budgetAPI.get(ledgerId);
      if (budget && budget.monthlyBudget > 0) {
        const percent = Math.round((monthExpense / 100 / budget.monthlyBudget) * 100);
        const remaining = budget.monthlyBudget - monthExpense / 100;
        // 本月剩余天数（含今天）
        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const remainingDays = daysInMonth - now.getDate() + 1;
        this.setData({
          budget: budget,
          budgetPercent: percent,
          budgetRemaining: remaining,
          _fmtBudgetRemaining: formatAmount(Math.max(0, remaining) * 100),
          _fmtBudgetOver: formatAmount(Math.max(0, -remaining) * 100),
          _dailyAvailable: remainingDays > 0 ? Math.max(0, remaining / remainingDays).toFixed(0) : '0',
        });
      } else {
        this.setData({ budget: null });
      }
    } catch (err) {
      this.setData({ budget: null });
    }
  },

  // 跳转预算设置
  goToBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' });
  },

  // 跳转语音记账页
  goToRecord() {
    wx.switchTab({ url: '/pages/record/record' });
  },

  // 跳转统计页
  goToStats() {
    wx.switchTab({ url: '/pages/statistics/statistics' });
  },

  // 跳转账本管理页
  goToLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' });
  },

  // 点击账单项 — 跳转到详情/编辑页（携带 ledgerId 以支持共享账本）
  onExpenseTap(e) {
    const { item } = e.detail;
    const ledger = getApp().getCurrentLedger();
    const ledgerId = ledger.type === 'shared' ? ledger.id : '';
    wx.navigateTo({
      url: `/pages/bill-detail/bill-detail?id=${item._id}${ledgerId ? `&ledgerId=${ledgerId}` : ''}`,
    });
  },

  // 分类颜色映射
  getCategoryColor(categoryId) {
    const colors = {
      food: '#FF6B6B', transport: '#4ECDC4', shopping: '#FF8E72',
      housing: '#6C5CE7', entertainment: '#A29BFE', medical: '#FF7675',
      education: '#74B9FF', social: '#FDCB6E', other: '#B2BEC3',
    };
    return colors[categoryId] || '#B2BEC3';
  },

  getWeekday(day) {
    const map = ['日', '一', '二', '三', '四', '五', '六'];
    return `星期${map[day]}`;
  },

  // 加载账本列表（个人 + 共享），并校验当前账本有效性
  async loadLedgers() {
    const app = getApp();
    const current = app.getCurrentLedger();
    try {
      const res = await ledgerAPI.list();
      const shared = (res && res.list) || [];
      const options = [
        { id: '', name: '我的账本', type: 'personal' },
        ...shared.map((l) => ({ id: l._id, name: l.name, type: 'shared' })),
      ];

      // 校验当前共享账本是否仍有效（可能已退出/被解散）
      let active = current;
      if (current.type === 'shared' && current.id && !shared.some((l) => l._id === current.id)) {
        active = { id: '', name: '我的账本', type: 'personal' };
        app.setCurrentLedger(active);
      }

      this.setData({ ledgers: options, currentLedgerId: active.id || '' });
    } catch (err) {
      this.setData({
        ledgers: [{ id: '', name: '我的账本', type: 'personal' }],
        currentLedgerId: '',
      });
    }
  },

  // 切换当前账本
  async switchLedger(e) {
    const { id, type, name } = e.currentTarget.dataset;
    const app = getApp();
    app.setCurrentLedger({ id: id || '', name, type });
    this.setData({ currentLedgerId: id || '' });
    await this.loadData().catch(() => {});
    wx.showToast({ title: `已切换到${name}`, icon: 'none' });
  },
});
