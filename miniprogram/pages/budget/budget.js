// pages/budget/budget.js — 预算设置页
// 预算按账本隔离（个人账本 ledgerId=''，共享账本传 ledgerId），
// 读写两侧都必须带上当前账本，否则共享账本里设的预算会写进个人账本。
const { budgetAPI, statsAPI, currentLedgerId } = require('../../utils/cloud');
const { formatAmount } = require('../../utils/util');

Page({
  data: {
    monthlyBudget: '',   // 显示值（元）
    yearBudget: '',      // 显示值（元）
    saving: false,
    thisMonthExpense: 0,
    thisYearExpense: 0,
    _fmtMonthExpense: '0',
    _fmtYearExpense: '0',
    budgetPercent: 0,
    // 当前账本：让用户明确知道正在给哪个账本设预算
    currentLedgerName: '我的账本',
    isShared: false,
  },

  onLoad() {
    // onLoad 之后紧接着会触发一次 onShow，标记跳过以免首进重复请求
    this._skipNextShow = true;
    this.loadData();
  },

  onShow() {
    if (this._skipNextShow) {
      this._skipNextShow = false;
      return;
    }
    // 从账本管理页切换账本后返回：必须重新拉取，
    // 否则页面上留着的还是上一个账本的预算与消费数据
    this.loadData();
  },

  async loadData() {
    // 请求序号：切换账本时可能有多轮请求并发，慢返回的旧结果必须丢弃
    const seq = (this._dataSeq = (this._dataSeq || 0) + 1);
    const ledger = getApp().getCurrentLedger();
    const ledgerId = ledger.id || '';

    try {
      // 并行加载预算和统计（均按当前账本）
      const [budget, monthSummary, yearSummary] = await Promise.all([
        budgetAPI.get(ledgerId),
        statsAPI.summary('month', ledgerId),
        statsAPI.summary('year', ledgerId),
      ]);
      if (seq !== this._dataSeq) return; // 期间已切到别的账本，本次结果作废

      this.setData({
        currentLedgerName: ledger.name || '我的账本',
        isShared: ledger.type === 'shared',
        monthlyBudget: budget.monthlyBudget > 0 ? budget.monthlyBudget.toString() : '',
        yearBudget: budget.yearBudget > 0 ? budget.yearBudget.toString() : '',
        thisMonthExpense: monthSummary.totalExpense,
        thisYearExpense: yearSummary.totalExpense,
        _fmtMonthExpense: formatAmount(monthSummary.totalExpense),
        _fmtYearExpense: formatAmount(yearSummary.totalExpense),
        budgetPercent: budget.monthlyBudget > 0
          ? Math.round((monthSummary.totalExpense / 100 / budget.monthlyBudget) * 100)
          : 0,
      });
    } catch (err) {
      if (seq !== this._dataSeq) return;
      console.log('Budget page load error:', err);
    }
  },

  onMonthlyInput(e) {
    this.setData({ monthlyBudget: e.detail.value });
  },

  onYearInput(e) {
    this.setData({ yearBudget: e.detail.value });
  },

  async saveBudget() {
    const { monthlyBudget, yearBudget } = this.data;

    // 至少填一个
    if (!monthlyBudget && !yearBudget) {
      wx.showToast({ title: '请至少填写一项预算', icon: 'none' });
      return;
    }

    const monthly = parseFloat(monthlyBudget);
    const yearly = parseFloat(yearBudget);

    if (monthlyBudget && (isNaN(monthly) || monthly <= 0)) {
      wx.showToast({ title: '月度预算格式不正确', icon: 'none' });
      return;
    }
    if (yearBudget && (isNaN(yearly) || yearly <= 0)) {
      wx.showToast({ title: '年度预算格式不正确', icon: 'none' });
      return;
    }

    // 保存时再取一次当前账本：用户可能在页面上停留期间切过账本
    const ledgerId = currentLedgerId();
    const isShared = this.data.isShared;

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      await budgetAPI.set({
        monthlyBudget: monthlyBudget ? monthly : 0,
        yearBudget: yearBudget ? yearly : 0,
        // 关键：不传 ledgerId 会落到个人账本，导致共享账本预算「串」到个人
        ledgerId,
      });
      wx.hideLoading();
      wx.showToast({ title: isShared ? '共享账本预算已保存' : '预算已保存', icon: 'success' });

      // 重新加载最新消费数据
      setTimeout(() => this.loadData(), 500);
    } catch (err) {
      wx.hideLoading();
      console.error('Save budget error:', err);
    } finally {
      this.setData({ saving: false });
    }
  },
});
