// pages/statistics/statistics.js — 统计报表页（日 / 月 / 年 三维度）
// 「周」不再是独立维度，降级为月视图里的「近12周支出」小图，少一层嵌套切换。
const { formatAmount, getCategoryIcon, formatDate } = require('../../utils/util');
const { statsAPI, budgetAPI, expenseAPI, currentLedgerId } = require('../../utils/cloud');

const pad = (n) => String(n).padStart(2, '0');

Page({
  data: {
    // 时间维度切换：日/月/年
    activeRange: 'day',  // day | month | year
    rangeTabs: [
      { key: 'day', label: '日' },
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

    // ============ 日视图：日历（走势图已移除，与日历功能重复） ============
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth() + 1,
    calTitle: '',
    calWeekdays: ['一', '二', '三', '四', '五', '六', '日'],
    calDays: [],           // 42 格
    calMonthExpense: '0',  // 当月支出合计（日历底部小结）
    calMonthIncome: '0',   // 当月收入合计
    daySheet: { visible: false, date: '', loading: false, list: [], totalExpense: '0', totalIncome: '0' },

    // ============ 近12周（展示在月视图内） ============
    // 每项: { key, label, expense, income, expPct, incPct,
    //        _fmtExpense, _fmtIncome, _zeroExpense, _zeroIncome }
    recentWeeks: [],

    // ============ 月视图 ============
    monthOffset: 0,        // 0=最近12个月，1=再往前12个月…
    monthTitle: '',
    monthBars: [],
    monthSheet: { visible: false, ym: '', title: '', categories: [], totalAmount: '0' },

    // ============ 年视图 ============
    yearBars: [],

    // ============ 共用：支出分类饼图 ============
    categoryStats: [],          // [{categoryId, categoryName, amount, percentage, _fmtAmount}]
    totalCategoryExpense: 0,
    _fmtTotalCategory: '0',
    _pieGradient: '',           // conic-gradient 内联样式字符串
    _categoryLabel: '支出分类',  // 卡片标题（日视图为「今日」，月/年视图为该区间）

    // ============ 月维度：预算 ============
    monthStats: { totalExpense: 0, totalIncome: 0, recordCount: 0, daysWithRecords: 0, avgDailyExpense: 0, balance: 0 },
    budget: null,
    budgetUsed: 0,
    budgetRemaining: 0,
    budgetPercent: 0,
    advices: [],

    loading: true,
    // 本次刷新是否失败。失败时必须显式告知：此前异常被 catch 后只打日志，
    // 页面继续显示上一轮数据，用户看到的是「静默过期的数字」
    loadError: false,

    // 当前统计所属账本（反映全局选择的账本）
    currentLedgerName: '我的账本',
    isShared: false,
  },

  onLoad() {
    // onLoad 后紧接着会触发一次 onShow，标记跳过以免首进统计页重复发一轮请求
    this._skipNextShow = true;
    this.init();
  },

  onShow() {
    if (this._skipNextShow) {
      this._skipNextShow = false;
      return;
    }
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

    // 账本切换后，月视图的分页偏移必须归零，否则翻的仍是上一个账本的月份区间
    if (this._lastLedgerId !== ledgerId) {
      this._lastLedgerId = ledgerId;
      if (this.data.monthOffset !== 0) this.setData({ monthOffset: 0 });
    }

    // 本轮请求序号：账本切换 / 多次 onShow 并发时，旧结果必须丢弃
    const seq = (this._dataSeq = (this._dataSeq || 0) + 1);

    const [statsOk, budgetOk] = await Promise.all([
      this.loadAll(ledgerId, seq).then(() => true).catch(() => false),
      this.loadBudget(ledgerId, seq).then(() => true).catch(() => false),
    ]);
    if (seq !== this._dataSeq) return; // 已被更新的请求取代
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
    this.loadAll().catch((err) => this.handleLoadError(err));
  },

  // ==================== 总加载 ====================

  async loadAll(ledgerId = currentLedgerId(), seq) {
    // 未显式传入 seq（如切换「日/月/年」标签）时另起一轮，作废在途的旧请求
    if (seq === undefined) seq = (this._dataSeq = (this._dataSeq || 0) + 1);

    this.setData({ loading: true, loadError: false });
    const { activeRange } = this.data;

    try {
      const rangeMap = { day: 'today', month: 'month', year: 'year' };
      const summary = await statsAPI.summary(rangeMap[activeRange], ledgerId);
      if (seq !== this._dataSeq) return; // 已切换维度或账本，旧结果丢弃

      // 云函数成功返回但数据为空：视为本次加载失败。
      // 此前直接对 null 取属性会抛 TypeError，被下面 catch 后静默保留上一轮数据。
      if (!summary) {
        this.setData({ loading: false, loadError: true });
        return;
      }

      const fmtSummary = {
        ...summary,
        _fmtTotalExpense: formatAmount(summary.totalExpense),
        _fmtTotalIncome: formatAmount(summary.totalIncome),
        _fmtBalance: formatAmount(Math.abs(summary.balance || 0)),
        _balanceClass: (summary.balance || 0) >= 0 ? 'income' : 'expense',
        _balanceSign: (summary.balance || 0) >= 0 ? '+' : '-',
      };
      this.setData({ summary: fmtSummary, loading: false });

      if (activeRange === 'day') await this.loadDayView(ledgerId, seq);
      else if (activeRange === 'month') await this.loadMonthView(ledgerId, seq);
      else if (activeRange === 'year') await this.loadYearView(ledgerId, seq);
    } catch (err) {
      if (seq !== this._dataSeq) return;
      console.error('Stats load error:', err);
      // 不再静默停在旧数据：明确告知本次刷新失败，并给出重试入口
      this.setData({ loading: false, loadError: true });
    }
  },

  // ==================== 加载失败与重试 ====================

  /**
   * 局部刷新失败的统一出口。
   * 翻月份 / 翻日历这类操作是「直接调用」加载方法的，此前没有 catch，
   * 一旦失败就是未捕获的 Promise 拒绝 + 页面看不出任何异常。
   */
  handleLoadError(err) {
    console.error('[Statistics] 刷新失败:', err);
    this.setData({ loading: false, loadError: true });
  },

  /** 错误条上的重试按钮：走一遍完整加载，成功后错误态自动清除 */
  retryLoad() {
    this.setData({ loadError: false });
    this.init();
  },

  // ==================== 日视图：日历 + 分类 ====================

  async loadDayView(ledgerId = currentLedgerId(), seq) {
    // 直接调用（如快速连翻月份）时另起一轮，保证最后一次点击胜出
    if (seq === undefined) seq = (this._dataSeq = (this._dataSeq || 0) + 1);

    const { calYear, calMonth } = this.data;
    const todayStr = formatDate(new Date());

    const [cal, catRes] = await Promise.all([
      statsAPI.calendar(calYear, calMonth, ledgerId),
      statsAPI.categoryStats(todayStr, todayStr, 'expense', ledgerId),
    ]);
    if (seq !== this._dataSeq) return; // 已翻到别的月份或切换账本，丢弃

    const days = this.buildCalendarGrid((cal && cal.days) || [], calYear, calMonth);

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

      calMonthExpense: formatAmount(monthExpense),
      calMonthIncome: formatAmount(monthIncome),
      ...catData,
    });
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
    this.loadDayView().catch((err) => this.handleLoadError(err));
  },

  nextCalMonth() {
    let { calYear, calMonth } = this.data;
    const now = new Date();
    if (calYear === now.getFullYear() && calMonth >= now.getMonth() + 1) return;
    calMonth += 1;
    if (calMonth > 12) { calMonth = 1; calYear += 1; }
    this.setData({ calYear, calMonth });
    this.loadDayView().catch((err) => this.handleLoadError(err));
  },

  backToToday() {
    const now = new Date();
    this.setData({ calYear: now.getFullYear(), calMonth: now.getMonth() + 1 });
    this.loadDayView().catch((err) => this.handleLoadError(err));
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

  // ==================== 共用：趋势条形图数据 ====================

  /**
   * 把云函数的趋势数据加工成 trend-bars 组件需要的行数据。
   *
   * keyField 是该维度的唯一键（月=ym，周=date，年=year），wx:key 需要它。
   * 百分比一律在这里算：WXML 的 Mustache 不支持调用方法，也不能做较复杂运算。
   *
   * 关键点：支出与收入**共用同一个分母**（两者的最大值）。
   * 如果各自归一化，同一个月里「收入 10 元」和「支出 1 万元」会一样长，
   * 两根柱子的长度就失去可比性——这是双数据柱图最容易犯的错。
   */
  buildTrendRows(raw, keyField) {
    const items = raw || [];
    let max = 0;
    items.forEach((x) => {
      max = Math.max(max, Number(x.expense) || 0, Number(x.income) || 0);
    });
    if (max <= 0) max = 1;

    // 非零值至少给 2% 宽度，否则几块钱的记录在图上完全看不见，
    // 用户会以为那段时间没记账。
    const pct = (v) => {
      const n = Number(v) || 0;
      if (n <= 0) return 0;
      return Math.max(2, Math.round((n / max) * 100));
    };

    return items.map((x, i) => {
      const expense = Number(x.expense) || 0;
      const income = Number(x.income) || 0;
      const rawKey = x[keyField];
      return {
        key: rawKey != null && rawKey !== '' ? String(rawKey) : `i${i}`,
        ym: x.ym || '',
        label: x.label || '',
        expense,
        income,
        expPct: pct(expense),
        incPct: pct(income),
        _fmtExpense: formatAmount(expense),
        _fmtIncome: formatAmount(income),
        _zeroExpense: expense <= 0,
        _zeroIncome: income <= 0,
      };
    });
  },

  // ==================== 月视图：月度趋势 + 分类 + 预算 ====================

  async loadMonthView(ledgerId = currentLedgerId(), seq) {
    if (seq === undefined) seq = (this._dataSeq = (this._dataSeq || 0) + 1);

    const { monthOffset } = this.data;
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const monthEnd = formatDate(now);

    const [trend, monthData, catStats, weekTrend] = await Promise.all([
      statsAPI.trend({ range: 'month', offset: monthOffset, ledgerId }),
      statsAPI.monthly(now.getFullYear(), now.getMonth() + 1, ledgerId),
      statsAPI.categoryStats(monthStart, monthEnd, 'expense', ledgerId),
      statsAPI.trend({ range: 'week', recent: 12, ledgerId }),
    ]);
    if (seq !== this._dataSeq) return; // 已翻到别的月份区间或切换账本，丢弃

    // 支出与收入共用同一分母（见 buildTrendRows 注释），所以这里不再各自算 max
    const bars = this.buildTrendRows((trend && trend.months) || [], 'ym');

    // 近12周（原「周」维度降级为月视图内的小图）
    const recentWeeks = this.buildTrendRows((weekTrend && weekTrend.weeks) || [], 'date');

    // 空响应兜底：云函数返回 null 时按空数据处理，不让 null 进入后续取属性的路径
    const catData = this.processCategoryData(catStats, '本月支出分类');

    const fmtMonthStats = {
      ...(monthData || {}),
      _fmtTotalExpense: formatAmount((monthData || {}).totalExpense),
      _fmtTotalIncome: formatAmount((monthData || {}).totalIncome),
      _fmtAvgDaily: formatAmount((monthData || {}).avgDailyExpense),
    };

    this.setData({
      monthTitle: `${(trend && trend.startYm) || ''} ~ ${(trend && trend.endYm) || ''}`,
      monthBars: bars,
      recentWeeks,
      monthStats: fmtMonthStats,
      ...catData,
    });
  },

  prevMonthPage() {
    this.setData({ monthOffset: this.data.monthOffset + 1 });
    this.loadMonthView().catch((err) => this.handleLoadError(err));
  },

  nextMonthPage() {
    if (this.data.monthOffset <= 0) return;
    this.setData({ monthOffset: this.data.monthOffset - 1 });
    this.loadMonthView().catch((err) => this.handleLoadError(err));
  },

  /** 点击某个时段的行 → 该月分类弹窗（事件由 trend-bars 组件抛出） */
  async tapMonthBar(e) {
    const item = (e && e.detail && e.detail.item) || null;
    if (!item || !item.ym) return;
    const ym = item.ym;
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

  async loadYearView(ledgerId = currentLedgerId(), seq) {
    if (seq === undefined) seq = (this._dataSeq = (this._dataSeq || 0) + 1);

    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [res, catRes] = await Promise.all([
      statsAPI.trend({ range: 'year', ledgerId }),
      statsAPI.categoryStats(yearStart, yearEnd, 'expense', ledgerId),
    ]);
    if (seq !== this._dataSeq) return; // 已切换账本或维度，丢弃

    const bars = this.buildTrendRows((res && res.years) || [], 'year');

    const catData = this.processCategoryData(catRes, '本年支出分类');
    this.setData({ yearBars: bars, ...catData });
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

  async loadBudget(ledgerId = currentLedgerId(), seq) {
    const budget = await budgetAPI.get(ledgerId);
    if (seq !== undefined && seq !== this._dataSeq) return budget;

    const hasBudget = !!(budget && budget.monthlyBudget > 0);
    // 必须无条件写入：从「有预算的账本」切到「没预算的账本」时，
    // 旧预算若不清掉，页面会继续显示上一个账本的预算条（P0-6 同类问题）
    this.setData({ budget: hasBudget ? budget : null });
    if (!hasBudget) {
      this.setData({ budgetUsed: 0, budgetRemaining: 0, budgetPercent: 0 });
    }
    return budget;
  },

  updateBudgetAnalysis(expense, budget) {
    const b = budget || this.data.budget;
    if (!b || !b.monthlyBudget) {
      // 当前账本没有预算：预算相关数字一并清零，避免残留上一账本的用量
      this.setData({
        budgetUsed: expense / 100,
        budgetRemaining: 0,
        budgetPercent: 0,
        advices: this.generateAdvices(expense, null),
      });
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
