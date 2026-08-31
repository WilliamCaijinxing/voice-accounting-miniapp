// pages/budget/budget.js — 预算设置页
const { budgetAPI, statsAPI } = require('../../utils/cloud');
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
  },

  async onLoad() {
    await this.loadData();
  },

  async loadData() {
    try {
      // 并行加载预算和统计
      const [budget, monthSummary, yearSummary] = await Promise.all([
        budgetAPI.get(),
        statsAPI.summary('month'),
        statsAPI.summary('year'),
      ]);

      this.setData({
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

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      await budgetAPI.set({
        monthlyBudget: monthlyBudget ? monthly : 0,
        yearBudget: yearBudget ? yearly : 0,
      });
      wx.hideLoading();
      wx.showToast({ title: '预算已保存', icon: 'success' });

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
