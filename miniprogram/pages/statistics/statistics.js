// pages/statistics/statistics.js — 统计报表页（日/周/月/年 四维度）
const { formatAmount, getCategoryIcon, formatDate } = require('../../utils/util');
const { statsAPI, budgetAPI, expenseAPI, currentLedgerId } = require('../../utils/cloud');

const pad = (n) => String(n).padStart(2, '0');

Page({
  data: {
    // 时间维度切换：日/周/月/年
    activeRange: 'day',  // day | week | month | year
    rangeTabs: [
      { key: 'day', label: '日' },
      { key: 'week', label: '周' },
      { key: 'month', label: '月' },
      { key: 'year', label: '年' },
    ],

    // 多维度汇总
    summary: {
      totalExpense: 0, totalIncome: 0, recordCount: 0, balance: 0,
      label: '今日', startDate: '', endDate: '',
      _fmtTotalExpense: '0', _fmtTotalIncome: '0', _fmtBalance: '0',
      _balanceClass: 'income', _balanceSign: '+',
    },

    // ============ 日视图：日历 / 走势（同一张卡片切换） ============
    dayViewMode: 'calendar',   // calendar | trend
    dayViewTabs: [
      { key: 'calendar', label: '看日历' },
      { key: 'trend', label: '看走势' },
    ],
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth() + 1,
    calTitle: '',
    calWeekdays: ['一', '二', '三', '四', '五', '六', '日'],
    calDays: [],           // 42 格
    calMonthExpense: '0',  // 当月支出合计（日历底部小结）
    calMonthIncome: '0',   // 当月收入合计
    lineChart: null,       // 每日支出折线图几何数据（单位 rpx，WXML 直接渲染）
    daySheet: { visible: false, date: '', loading: false, list: [], totalExpense: '0', totalIncome: '0' },

    // ============ 周视图 ============
    weekView: 'recent',    // recent(近12周) | year(全年52周)
    weekYear: new Date().getFullYear(),
    recentWeeks: [],
    maxRecentExpense: 0,
    yearWeeks: [],
    maxYearWeekExpense: 0,

    // ============ 月视图 ============
    monthOffset: 0,        // 0=最近12个月，1=再往前12个月…
    monthTitle: '',
    monthBars: [],
    maxMonthExpense: 0,
    monthSheet: { visible: false, ym: '', title: '', categories: [], totalAmount: '0' },

    // ============ 年视图 ============
    yearBars: [],
    maxYearExpense: 0,

    // ============ 共用：支出分类饼图 ============
    categoryStats: [],          // [{categoryId, categoryName, amount, percentage, _fmtAmount}]
    totalCategoryExpense: 0,
    _fmtTotalCategory: '0',
    _pieGradient: '',           // conic-gradient 内联样式字符串
    _categoryLabel: '支出分类',  // 卡片标题（今日/本周/本月/本年）

    // ============ 月维度：预算 ============
    monthStats: { totalExpense: 0, totalIncome: 0, recordCount: 0, daysWithRecords: 0, avgDailyExpense: 0, balance: 0 },
    budget: null,
    budgetUsed: 0,
    budgetRemaining: 0,
    budgetPercent: 0,
    advices: [],

    loading: true,

    // 当前统计所属账本（反映全局选择的账本）
    currentLedgerName: '我的账本',
    isShared: false,
  },

  onLoad() {
    this.init();
  },

  onShow() {
    this.init();
  },

  /** 当前全局账本 id / 名称（统计页只读展示，切换在首页完成） */
  syncCurrentLedger() {
    const ledger = getApp().getCurrentLedger();
    this.setData({ currentLedgerName: ledger.name, isShared: ledger.type === 'shared' });
    return currentLedgerId();
  },

  async init() {
    const ledgerId = this.syncCurrentLedger();
    const [statsOk, budgetOk] = await Promise.all([
      this.loadAll(ledgerId).then(() => true).catch(() => false),
      this.loadBudget(ledgerId).then(() => true).catch(() => false),
    ]);
    if (statsOk && this.data.activeRange === 'month') {
      const budget = budgetOk ? this.data.budget : null;
      this.updateBudgetAnalysis(this.data.summary.totalExpense, budget);
    }
  },

  // ==================== 维度切换 ====================

  switchRange(e) {
    const range = e.currentTarget.dataset.range;
    if (range === this.data.activeRange) return;
    this.setData({ activeRange: range });
    this.loadAll();
  },

  // ==================== 总加载 ====================

  async loadAll(ledgerId = currentLedgerId()) {
    this.setData({ loading: true });
    const { activeRange } = this.data;

    try {
      const rangeMap = { day: 'today', week: 'week', month: 'month', year: 'year' };
      const summary = await statsAPI.summary(rangeMap[activeRange], ledgerId);
      const fmtSummary = {
        ...summary,
        _fmtTotalExpense: formatAmount(summary.totalExpense),
        _fmtTotalIncome: formatAmount(summary.totalIncome),
        _fmtBalance: formatAmount(Math.abs(summary.balance)),
        _balanceClass: summary.balance >= 0 ? 'income' : 'expense',
        _balanceSign: summary.balance >= 0 ? '+' : '-',
      };
      this.setData({ summary: fmtSummary, loading: false });

      if (activeRange === 'day') await this.loadDayView(ledgerId);
      else if (activeRange === 'week') await this.loadWeekView(ledgerId);
      else if (activeRange === 'month') await this.loadMonthView(ledgerId);
      else if (activeRange === 'year') await this.loadYearView(ledgerId);
    } catch (err) {
      console.error('Stats load error:', err);
      this.setData({ loading: false });
    }
  },

  // ==================== 日视图：日历/走势（同一卡片切换）+ 分类 ====================

  async loadDayView(ledgerId = currentLedgerId()) {
    const { calYear, calMonth } = this.data;
    const todayStr = formatDate(new Date());

    const [cal, trend, catRes] = await Promise.all([
      statsAPI.calendar(calYear, calMonth, ledgerId),
      statsAPI.dailyTrend(calYear, calMonth, ledgerId),
      statsAPI.categoryStats(todayStr, todayStr, 'expense', ledgerId),
    ]);

    const days = this.buildCalendarGrid((cal && cal.days) || [], calYear, calMonth);
    const chart = this.buildLineChart((trend && trend.days) || []);

    // 当月收支合计（日历底部小结）
    let monthExpense = 0;
    let monthIncome = 0;
    days.forEach((d) => {
      if (d.empty) return;
      monthExpense += d.expense || 0;
      monthIncome += d.income || 0;
    });

    const catData = this.processCategoryData(catRes, '今日支出分类');
    this.setData({
      calTitle: `${calYear}年${calMonth}月`,
      calDays: days,
      lineChart: chart,
      calMonthExpense: formatAmount(monthExpense),
      calMonthIncome: formatAmount(monthIncome),
      ...catData,
    });
  },

  /** 日视图子模式切换：看日历 / 看走势 */
  switchDayView(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.dayViewMode) return;
    this.setData({ dayViewMode: mode });
  },

  // ==================== 折线图 ====================

  /**
   * 构建折线图几何数据。
   * WXML 不能调用函数，所以坐标、角度、长度全部在这里算好。
   * 统一使用 rpx：旋转角度与长度都基于同一坐标系，换算后视觉一致。
   */
  buildLineChart(days) {
    const list = (days || []).filter(Boolean);
    if (list.length === 0) return null;

    const COL_W = 56;    // 每天占用宽度（rpx）
    const PLOT_H = 200;  // 绘图区净高（rpx）
    const TOP_PAD = 48;  // 顶部留白，给数值气泡留空间（rpx）
    const DOT = 12;      // 数据点直径（rpx）

    const values = list.map((d) => Number(d.expense) || 0);
    const hasData = values.some((v) => v > 0);
    const max = this.niceCeil(Math.max(...values, 0));
    const totalW = list.length * COL_W;

    const points = list.map((d, i) => {
      const v = Number(d.expense) || 0;
      const x = i * COL_W + COL_W / 2;
      const y = max > 0 ? (v / max) * PLOT_H : 0;
      return {
        day: d.day,
        date: d.date,
        value: v,
        x,
        y,
        dotLeft: x - DOT / 2,
        dotBottom: y - DOT / 2,
        labelLeft: x - COL_W / 2,
        _fmt: v > 0 ? this.shortenAmount(v) : '',
      };
    });

    // 线段：以起点为旋转原点，长度与角度在 rpx 坐标系下计算
    // 注意 y 轴向上为正，而屏幕/CSS 的 y 轴向下为正，故角度取负
    const segments = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dyUp = b.y - a.y;
      segments.push({
        key: `seg-${i}`,
        left: a.x,
        bottom: a.y,
        width: Math.sqrt(dx * dx + dyUp * dyUp),
        rotate: (Math.atan2(-dyUp, dx) * 180) / Math.PI,
        active: a.value > 0 || b.value > 0,
      });
    }

    // 面积填充：从折线到绘图区底部闭合（clip-path 百分比坐标）
    const areaPts = points.map((p) => (
      `${((p.x / totalW) * 100).toFixed(2)}% ${(100 - (p.y / PLOT_H) * 100).toFixed(2)}%`
    ));
    const areaPath = `polygon(0% 100%, ${areaPts.join(', ')}, 100% 100%)`;

    // Y 轴刻度：4 档（0 / 1/3 / 2/3 / 1）
    const yLabels = [1, 2 / 3, 1 / 3, 0].map((r, idx) => ({
      key: `y-${idx}`,
      bottom: r * PLOT_H,
      _text: this.shortenAmount(Math.round(max * r)),
    }));

    return {
      width: totalW,
      colWidth: COL_W,
      plotHeight: PLOT_H,
      topPad: TOP_PAD,
      totalHeight: PLOT_H + TOP_PAD,
      max,
      hasData,
      points,
      segments,
      areaPath,
      yLabels,
    };
  },

  /** 把最大值向上取整到「好看」的刻度（单位：分），避免出现 ¥123.45 这种上限 */
  niceCeil(max) {
    if (!max || max <= 0) return 100; // 兜底 1 元，防止除零
    const steps = [1, 1.1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const exp = Math.floor(Math.log10(max));
    const base = Math.pow(10, exp);
    const n = max / base;
    const step = steps.find((s) => n <= s + 1e-9) || 10;
    return Math.max(100, Math.round(step * base)); // 最小刻度 1 元
  },

  /** 构建 42 格日历网格（周一开头），金额缩略显示 */
  buildCalendarGrid(days, year, month) {
    const dayMap = {};
    (days || []).forEach((d) => { dayMap[d.day] = d; });

    const startOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 周一=0
    const lastDay = new Date(year, month, 0).getDate();
    const todayStr = formatDate(new Date());
    const cells = [];

    for (let i = 0; i < startOffset; i++) {
      cells.push({ key: `pre-${i}`, empty: true });
    }
    for (let d = 1; d <= lastDay; d++) {
      const g = dayMap[d] || { expense: 0, income: 0 };
      const dateStr = `${year}-${pad(month)}-${pad(d)}`;
      const expense = Number(g.expense) || 0;
      const income = Number(g.income) || 0;
      cells.push({
        key: dateStr,
        day: d,
        date: dateStr,
        inMonth: true,
        isToday: dateStr === todayStr,
        // 原始值必须带上，WXML 才能用 item.expense > 0 判断是否渲染
        expense,
        income,
        hasData: expense > 0 || income > 0,
        // 是否「支出多于收入」：决定这天主色
        netIncome: income > expense,
        _fmtExpense: this.shortenAmount(expense),
        _fmtIncome: this.shortenAmount(income),
      });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ key: `tail-${cells.length}`, empty: true });
    }
    return cells;
  },

  /** 金额缩略：>10000 显示 "1.2万"，>1000 显示 "1.2k"，用于日历格子与坐标轴 */
  shortenAmount(amount) {
    const yuan = (Number(amount) || 0) / 100;
    if (yuan <= 0) return '0';
    if (yuan >= 10000) return (yuan / 10000).toFixed(1) + '万';
    if (yuan >= 1000) return (yuan / 1000).toFixed(1) + 'k';
    return yuan >= 10 ? yuan.toFixed(0) : yuan.toFixed(1);
  },

  prevCalMonth() {
    let { calYear, calMonth } = this.data;
    calMonth -= 1;
    if (calMonth < 1) { calMonth = 12; calYear -= 1; }
    this.setData({ calYear, calMonth });
    this.loadDayView();
  },

  nextCalMonth() {
    let { calYear, calMonth } = this.data;
    const now = new Date();
    if (calYear === now.getFullYear() && calMonth >= now.getMonth() + 1) return;
    calMonth += 1;
    if (calMonth > 12) { calMonth = 1; calYear += 1; }
    this.setData({ calYear, calMonth });
    this.loadDayView();
  },

  backToToday() {
    const now = new Date();
    this.setData({ calYear: now.getFullYear(), calMonth: now.getMonth() + 1 });
    this.loadDayView();
  },

  /** 点击日历某天 → 当天明细弹窗 */
  async tapCalDay(e) {
    const { date } = e.currentTarget.dataset;
    if (!date) return;
    this.setData({ 'daySheet.visible': true, 'daySheet.date': date, 'daySheet.loading': true, 'daySheet.list': [] });
    try {
      const res = await expenseAPI.list({ startDate: date, endDate: date, pageSize: 100, ledgerId: currentLedgerId() });
      const list = (res.list || []).map((item) => ({
        ...item,
        _icon: getCategoryIcon(item.categoryId),
        _sign: item.type === 'income' ? '+' : '-',
        _fmtAmount: formatAmount(item.amount),
        _time: item.createdAt ? new Date(item.createdAt).toTimeString().slice(0, 5) : '',
      }));
      let totalExpense = 0, totalIncome = 0;
      list.forEach((i) => { if (i.type === 'income') totalIncome += i.amount; else totalExpense += i.amount; });
      this.setData({
        'daySheet.list': list,
        'daySheet.totalExpense': formatAmount(totalExpense),
        'daySheet.totalIncome': formatAmount(totalIncome),
        'daySheet.loading': false,
      });
    } catch (err) {
      console.error('Day detail error:', err);
      this.setData({ 'daySheet.loading': false });
    }
  },

  closeDaySheet() {
    this.setData({ 'daySheet.visible': false });
  },

  noop() {},

  // ==================== 周视图 ====================

  async loadWeekView(ledgerId = currentLedgerId()) {
    const { weekView, weekYear } = this.data;

    // 计算本周日期范围
    const now = new Date();
    const dayNum = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayNum + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const weekStart = formatDate(monday);
    const weekEnd = formatDate(sunday);

    if (weekView === 'recent') {
      const [res, catRes] = await Promise.all([
        statsAPI.trend({ range: 'week', recent: 12, ledgerId }),
        statsAPI.categoryStats(weekStart, weekEnd, 'expense', ledgerId),
      ]);
      const weeks = (res && res.weeks) || [];
      const max = weeks.reduce((m, w) => Math.max(m, w.expense), 0);
      const bars = weeks.map((w) => ({
        ...w,
        barHeight: w.expense > 0 ? Math.max(8, (w.expense / (max || 1)) * 160) : 4,
        _fmtExpense: formatAmount(w.expense),
      }));
      const catData = this.processCategoryData(catRes, '本周支出分类');
      this.setData({ recentWeeks: bars, maxRecentExpense: max, ...catData });
    } else {
      const [res, catRes] = await Promise.all([
        statsAPI.trend({ range: 'week', year: weekYear, ledgerId }),
        statsAPI.categoryStats(weekStart, weekEnd, 'expense', ledgerId),
      ]);
      const weeks = (res && res.weeks) || [];
      const max = weeks.reduce((m, w) => Math.max(m, w.expense), 0);
      const bars = weeks.map((w) => ({
        barHeight: w.expense > 0 ? Math.max(6, (w.expense / (max || 1)) * 130) : 3,
        _fmtExpense: formatAmount(w.expense),
      }));
      const catData = this.processCategoryData(catRes, '本周支出分类');
      this.setData({ yearWeeks: bars, maxYearWeekExpense: max, ...catData });
    }
  },

  switchWeekView(e) {
    const view = e.currentTarget.dataset.view;
    if (view === this.data.weekView) return;
    this.setData({ weekView: view });
    this.loadWeekView();
  },

  prevWeekYear() {
    this.setData({ weekYear: this.data.weekYear - 1 });
    this.loadWeekView();
  },

  nextWeekYear() {
    const now = new Date();
    if (this.data.weekYear >= now.getFullYear()) return;
    this.setData({ weekYear: this.data.weekYear + 1 });
    this.loadWeekView();
  },

  // ==================== 月视图：月度趋势 + 分类 + 预算 ====================

  async loadMonthView(ledgerId = currentLedgerId()) {
    const { monthOffset } = this.data;
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const monthEnd = formatDate(now);

    const [trend, monthData, catStats] = await Promise.all([
      statsAPI.trend({ range: 'month', offset: monthOffset, ledgerId }),
      statsAPI.monthly(now.getFullYear(), now.getMonth() + 1, ledgerId),
      statsAPI.categoryStats(monthStart, monthEnd, 'expense', ledgerId),
    ]);

    const months = (trend && trend.months) || [];
    const max = months.reduce((m, x) => Math.max(m, x.expense), 0);
    const bars = months.map((x) => ({
      ...x,
      barHeight: x.expense > 0 ? Math.max(8, (x.expense / (max || 1)) * 160) : 4,
      _fmtExpense: formatAmount(x.expense),
    }));

    const catData = this.processCategoryData(catStats, '本月支出分类');

    const fmtMonthStats = {
      ...monthData,
      _fmtTotalExpense: formatAmount(monthData.totalExpense),
      _fmtTotalIncome: formatAmount(monthData.totalIncome),
      _fmtAvgDaily: formatAmount(monthData.avgDailyExpense),
    };

    this.setData({
      monthTitle: `${trend.startYm || ''} ~ ${trend.endYm || ''}`,
      monthBars: bars,
      maxMonthExpense: max,
      monthStats: fmtMonthStats,
      ...catData,
    });
  },

  prevMonthPage() {
    this.setData({ monthOffset: this.data.monthOffset + 1 });
    this.loadMonthView();
  },

  nextMonthPage() {
    if (this.data.monthOffset <= 0) return;
    this.setData({ monthOffset: this.data.monthOffset - 1 });
    this.loadMonthView();
  },

  /** 点击月份柱子 → 该月分类弹窗 */
  async tapMonthBar(e) {
    const { ym } = e.currentTarget.dataset;
    if (!ym) return;
    const [y, m] = ym.split('-').map(Number);
    const startDate = `${ym}-01`;
    const endDate = `${ym}-${pad(new Date(y, m, 0).getDate())}`;
    this.setData({ 'monthSheet.visible': true, 'monthSheet.ym': ym, 'monthSheet.title': `${y}年${m}月支出分类` });

    try {
      const res = await statsAPI.categoryStats(startDate, endDate, 'expense', currentLedgerId());
      const cats = ((res && res.categories) || []).map((c) => ({
        ...c,
        _fmtAmount: formatAmount(c.amount),
        _color: this.getCategoryColor(c.categoryId),
      }));
      const total = (res && res.totalAmount) || 0;
      this.setData({ 'monthSheet.categories': cats, 'monthSheet.totalAmount': formatAmount(total) });
    } catch (err) {
      console.error('Month category error:', err);
      this.setData({ 'monthSheet.categories': [], 'monthSheet.totalAmount': '0' });
    }
  },

  closeMonthSheet() {
    this.setData({ 'monthSheet.visible': false });
  },

  // ==================== 年视图 ====================

  async loadYearView(ledgerId = currentLedgerId()) {
    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [res, catRes] = await Promise.all([
      statsAPI.trend({ range: 'year', ledgerId }),
      statsAPI.categoryStats(yearStart, yearEnd, 'expense', ledgerId),
    ]);

    const years = (res && res.years) || [];
    const max = years.reduce((m, y) => Math.max(m, y.expense), 0);
    const bars = years.map((y) => ({
      ...y,
      barHeight: y.expense > 0 ? Math.max(10, (y.expense / (max || 1)) * 180) : 4,
      _fmtExpense: formatAmount(y.expense),
    }));

    const catData = this.processCategoryData(catRes, '本年支出分类');
    this.setData({ yearBars: bars, maxYearExpense: max, ...catData });
  },

  // ==================== 共用：分类饼图数据处理 ====================

  /** 处理分类统计返回，生成饼图渐变和格式化字段 */
  processCategoryData(res, label) {
    const cats = ((res && res.categories) || []).map((c) => ({
      ...c,
      _fmtAmount: formatAmount(c.amount),
      // 颜色预计算：WXML 里调用 Page 方法并非官方支持，且每次渲染都会重复求值
      _color: this.getCategoryColor(c.categoryId),
    }));
    const total = (res && res.totalAmount) || cats.reduce((s, c) => s + c.amount, 0);
    const gradient = this.buildPieGradient(cats);
    return {
      categoryStats: cats,
      totalCategoryExpense: total,
      _fmtTotalCategory: formatAmount(total),
      _pieGradient: gradient,
      _categoryLabel: label,
    };
  },

  /** 构建 conic-gradient 字符串，用于饼图内联样式 */
  buildPieGradient(categories) {
    if (!categories || categories.length === 0) return '';
    const parts = [];
    let acc = 0;
    categories.forEach((cat) => {
      const color = this.getCategoryColor(cat.categoryId);
      const start = acc;
      const pct = Number(cat.percentage) || 0;
      acc += pct;
      if (pct > 0) {
        parts.push(`${color} ${start}% ${acc}%`);
      }
    });
    if (parts.length === 0) return '';
    return `conic-gradient(${parts.join(', ')})`;
  },

  // ==================== 预算 ====================

  async loadBudget(ledgerId = currentLedgerId()) {
    const budget = await budgetAPI.get(ledgerId);
    if (budget && budget.monthlyBudget > 0) {
      this.setData({ budget });
    }
    return budget;
  },

  updateBudgetAnalysis(expense, budget) {
    const b = budget || this.data.budget;
    if (!b || !b.monthlyBudget) {
      this.setData({ advices: this.generateAdvices(expense, null) });
      return;
    }

    const budgetYuan = b.monthlyBudget;
    const used = expense / 100;
    const remaining = budgetYuan - used;
    const percent = budgetYuan > 0 ? Math.round((used / budgetYuan) * 100) : 0;

    this.setData({
      budgetUsed: used,
      budgetRemaining: remaining,
      budgetPercent: percent,
      advices: this.generateAdvices(expense, budgetYuan),
    });
  },

  generateAdvices(expense, budget) {
    const advices = [];
    const expenseYuan = expense / 100;
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyAvg = expenseYuan / dayOfMonth;
    const projected = dailyAvg * daysInMonth;

    const cats = this.data.categoryStats;
    if (cats && cats.length > 0) {
      const topCat = cats[0];
      const topPct = topCat.percentage;
      if (topPct > 40) {
        advices.push({
          icon: '⚠️',
          text: `${topCat.categoryName}占比${topPct}%，消费过于集中，建议适当控制${topCat.categoryName}支出`,
        });
      } else if (topPct > 25) {
        advices.push({
          icon: '💡',
          text: `${topCat.categoryName}是本月最大支出项（占比${topPct}%），可关注是否有优化空间`,
        });
      }
    }

    if (budget && budget > 0) {
      const percent = Math.round((expenseYuan / budget) * 100);

      if (percent > 100) {
        advices.push({
          icon: '🚨',
          text: `本月已超支¥${(expenseYuan - budget).toFixed(2)}（预算¥${budget}），建议下月减少非必要支出`,
        });
      } else if (percent > 80) {
        const leftDays = daysInMonth - dayOfMonth;
        const dailyCap = leftDays > 0 ? ((budget - expenseYuan) / leftDays).toFixed(0) : '0';
        advices.push({
          icon: '⚡',
          text: `预算已使用${percent}%，接近上限${leftDays > 0 ? `，剩余${leftDays}天需控制日均支出在¥${dailyCap}以内` : '，今天是本月最后一天'}`,
        });
      } else if (percent > 50 && projected > budget) {
        advices.push({
          icon: '📈',
          text: `按当前节奏预计本月支出¥${projected.toFixed(0)}，将超出预算¥${(projected - budget).toFixed(0)}，建议适当控制`,
        });
      } else if (percent < 30 && dayOfMonth > 15) {
        advices.push({
          icon: '✅',
          text: `消费控制良好，预算使用${percent}%，预计本月可结余¥${(budget - projected).toFixed(0)}`,
        });
      } else {
        advices.push({
          icon: '📊',
          text: `预算使用${percent}%，日均支出¥${dailyAvg.toFixed(0)}，预计本月总支出约¥${projected.toFixed(0)}`,
        });
      }
    } else {
      if (dailyAvg > 200) {
        advices.push({
          icon: '💡',
          text: `日均支出¥${dailyAvg.toFixed(0)}，设置月度预算可以更好地控制开支`,
        });
      }
      advices.push({
        icon: '🎯',
        text: '点击下方「设置预算」开始智能消费管理',
      });
    }

    return advices;
  },

  goToBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' });
  },

  getCategoryColor(categoryId) {
    const colors = {
      food: '#FF6B6B', transport: '#4ECDC4', shopping: '#FF8E72',
      housing: '#6C5CE7', entertainment: '#A29BFE', medical: '#FF7675',
      education: '#74B9FF', social: '#FDCB6E', other: '#B2BEC3',
    };
    return colors[categoryId] || '#B2BEC3';
  },
});
