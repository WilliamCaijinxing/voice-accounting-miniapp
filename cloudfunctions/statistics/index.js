// cloudfunctions/statistics/index.js
// 记账统计聚合云函数（支持个人账本与共享账本）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;
const { guardLedgerAccess } = require('./ledger-guard');

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  // 统一入口守卫：statistics 全部 action 共享同一数据源（expenses by ledgerId），
  // 在此统一拦截非成员的共享账本访问 + ledgerId 类型注入（个人账本自动放行）。
  if (event.ledgerId) {
    const guard = await guardLedgerAccess(event.ledgerId, OPENID);
    if (guard.code !== 0) return guard;
  }

  switch (action) {
    case 'today': return getTodayStats(OPENID, event);
    case 'monthly': return getMonthlyStats(OPENID, event);
    case 'categoryStats': return getCategoryStats(OPENID, event);
    case 'dailyTrend': return getDailyTrend(OPENID, event);
    case 'summary': return getSummaryByRange(OPENID, event);
    case 'calendar': return getCalendar(OPENID, event);
    case 'trend': return getTrend(OPENID, event);
    default: return { code: -1, message: 'Unknown action: ' + action };
  }
};

/**
 * 构造查询范围：
 * - ledgerId 非空 → 共享账本（按账本查）
 * - ledgerId 为空 → 个人账本（本人 + 无 ledgerId 字段的历史记录）
 */
function buildScope(openid, ledgerId) {
  if (ledgerId) return { ledgerId };
  return { _openid: openid, ledgerId: _.exists(false) };
}

/**
 * 按日期分组拉取该范围的收支（expense/income 各一次聚合）
 * 返回 [{ date, expense, income, expenseCount, incomeCount, count }]
 * 注意：走聚合管道，不受云数据库 .get() 单次 100 条上限影响
 */
async function fetchGroupedByDate(openid, ledgerId, startDate, endDate) {
  const scope = buildScope(openid, ledgerId);
  const match = { ...scope };
  if (startDate && endDate) {
    match.date = _.gte(startDate).and(_.lte(endDate));
  }

  const [expRes, incRes] = await Promise.all([
    db.collection('expenses').aggregate()
      .match({ ...match, type: 'expense' })
      .group({ _id: '$date', total: $.sum('$amount'), count: $.sum(1) })
      .end(),
    db.collection('expenses').aggregate()
      .match({ ...match, type: 'income' })
      .group({ _id: '$date', total: $.sum('$amount'), count: $.sum(1) })
      .end(),
  ]);

  const map = {};
  const ensure = (k) => {
    if (!map[k]) map[k] = { date: k, expense: 0, income: 0, expenseCount: 0, incomeCount: 0, count: 0 };
    return map[k];
  };
  expRes.list.forEach((r) => {
    const row = ensure(r._id);
    row.expense = r.total;
    row.expenseCount = r.count;
  });
  incRes.list.forEach((r) => {
    const row = ensure(r._id);
    row.income = r.total;
    row.incomeCount = r.count;
  });

  return Object.values(map).map((r) => ({ ...r, count: r.expenseCount + r.incomeCount }));
}

/**
 * 聚合该范围的收支总额与笔数（聚合管道，无 100 条上限）
 * 返回 { expense, income, expenseCount, incomeCount, recordCount }
 */
async function fetchTotals(openid, ledgerId, startDate, endDate) {
  const scope = buildScope(openid, ledgerId);
  const match = { ...scope };
  if (startDate && endDate) {
    match.date = _.gte(startDate).and(_.lte(endDate));
  }

  const res = await db.collection('expenses').aggregate()
    .match(match)
    .group({ _id: '$type', total: $.sum('$amount'), count: $.sum(1) })
    .end();

  const out = { expense: 0, income: 0, expenseCount: 0, incomeCount: 0 };
  res.list.forEach((r) => {
    if (r._id === 'income') {
      out.income = r.total;
      out.incomeCount = r.count;
    } else {
      out.expense += r.total;
      out.expenseCount += r.count;
    }
  });
  out.recordCount = out.expenseCount + out.incomeCount;
  return out;
}

/**
 * 按分类聚合（聚合管道，无 100 条上限）
 * 返回 [{ categoryId, categoryName, amount, count }]，未排序
 */
async function fetchGroupedByCategory(openid, ledgerId, startDate, endDate, type) {
  const scope = buildScope(openid, ledgerId);
  const match = { ...scope, type };
  if (startDate && endDate) {
    match.date = _.gte(startDate).and(_.lte(endDate));
  }

  const res = await db.collection('expenses').aggregate()
    .match(match)
    .group({
      _id: '$categoryId',
      amount: $.sum('$amount'),
      count: $.sum(1),
      categoryName: $.first('$categoryName'),
    })
    .end();

  return res.list.map((r) => ({
    categoryId: r._id,
    categoryName: r.categoryName,
    amount: r.amount,
    count: r.count,
  }));
}

/**
 * 日历数据：某年某月每天的收入/支出/笔数
 * range: calendar
 */
async function getCalendar(openid, { year, month, ledgerId }) {
  const y = year || new Date().getFullYear();
  const m = month || new Date().getMonth() + 1;
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  const startDate = `${ym}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${ym}-${String(lastDay).padStart(2, '0')}`;

  try {
    const grouped = await fetchGroupedByDate(openid, ledgerId, startDate, endDate);
    const dayMap = {};
    grouped.forEach((g) => { dayMap[g.date] = g; });

    // 初始化该月每一天（含 0 值），保证日历网格完整
    const days = [];
    for (let d = 1; d <= lastDay; d++) {
      const key = `${ym}-${String(d).padStart(2, '0')}`;
      const g = dayMap[key] || { date: key, expense: 0, income: 0 };
      days.push({ ...g, day: d, count: (g.expense > 0 || g.income > 0) ? 1 : 0 });
    }

    return { code: 0, data: { year: y, month: m, days } };
  } catch (err) {
    console.error('Calendar error:', err);
    return { code: -1, message: '日历数据获取失败' };
  }
}

/**
 * 趋势数据（周/月/年聚合）
 * range: trend
 */
async function getTrend(openid, event) {
  const { range, ledgerId } = event;

  try {
    if (range === 'week') return await getWeeklyTrend(openid, event);
    if (range === 'month') return await getMonthlyTrend(openid, event);
    if (range === 'year') return await getYearlyTrend(openid, ledgerId);
    return { code: -1, message: 'Unknown trend range: ' + range };
  } catch (err) {
    console.error('Trend error:', err);
    return { code: -1, message: '趋势数据获取失败' };
  }
}

/**
 * ISO 周号（周一为一周开始，跨年周按 ISO 规则）
 */
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayNum = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - dayNum); // 移到本周四
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayNum = d.getDay() || 7;
  d.setDate(d.getDate() - dayNum + 1);
  return formatDate(d);
}

/**
 * 周趋势：按年查看全年 52 周 / 最近 N 周滚动
 */
async function getWeeklyTrend(openid, { year, recent, ledgerId }) {
  const now = new Date();

  if (recent) {
    // 最近 N 周：从今天往前推 N-1 个周一（用本地时间计算，避免时区偏移）
    const n = Math.min(Math.max(Number(recent) || 12, 4), 52);
    const thisMonday = getMonday(formatDate(now));
    const startTs = new Date(thisMonday + 'T00:00:00').getTime() - (n - 1) * 7 * 86400000;
    const startDate = getMonday(formatDate(new Date(startTs)));
    const endDate = formatDate(now);

    const grouped = await fetchGroupedByDate(openid, ledgerId, startDate, endDate);
    const weekMap = {};
    grouped.forEach((g) => {
      const monday = getMonday(g.date);
      if (!weekMap[monday]) weekMap[monday] = { date: monday, expense: 0, income: 0 };
      weekMap[monday].expense += g.expense;
      weekMap[monday].income += g.income;
    });

    // 补齐从 startDate 到本周的每一周（即使 0 消费）
    const weeks = [];
    for (let i = 0; i < n; i++) {
      const monday = new Date(new Date(startDate + 'T00:00:00').getTime() + i * 7 * 86400000);
      const key = formatDate(monday);
      const g = weekMap[key] || { date: key, expense: 0, income: 0 };
      weeks.push({ ...g, label: `${key.slice(5).replace('-', '/')}` });
    }

    return { code: 0, data: { range: 'week', recent: true, startDate, endDate, weeks } };
  }

  // 按年查看：该年 1/1 ~ 12/31，聚合到 ISO 周
  const y = year || now.getFullYear();
  const startDate = `${y}-01-01`;
  const endDate = `${y}-12-31`;

  const grouped = await fetchGroupedByDate(openid, ledgerId, startDate, endDate);
  const weekMap = {};
  grouped.forEach((g) => {
    const w = isoWeek(g.date);
    if (!weekMap[w]) weekMap[w] = { week: w, expense: 0, income: 0, count: 0 };
    weekMap[w].expense += g.expense;
    weekMap[w].income += g.income;
  });

  // 补齐全年周数（52 或 53）
  const weeksInYear = isoWeek(`${y}-12-28`);
  const weeks = [];
  for (let w = 1; w <= weeksInYear; w++) {
    const g = weekMap[w] || { week: w, expense: 0, income: 0 };
    weeks.push({ ...g, label: `W${w}` });
  }

  return { code: 0, data: { range: 'week', year: y, weeks } };
}

/**
 * 月趋势：最近 12 个月，offset 翻页
 */
async function getMonthlyTrend(openid, { offset = 0, ledgerId }) {
  const now = new Date();
  const off = Math.max(0, Number(offset) || 0);

  // 目标区间：结束月份 = 当前月往前推 12*off 个月；区间长度 12 个月
  const endMonthDate = new Date(now.getFullYear(), now.getMonth() + 1 - 12 * off, 1);
  const startMonthDate = new Date(endMonthDate.getFullYear(), endMonthDate.getMonth() - 11, 1);
  const startY = startMonthDate.getFullYear();
  const startM = startMonthDate.getMonth() + 1;
  const endY = endMonthDate.getFullYear();
  const endM = endMonthDate.getMonth() + 1;

  const startDate = `${startY}-${String(startM).padStart(2, '0')}-01`;
  const endDate = `${endY}-${String(endM).padStart(2, '0')}-${String(new Date(endY, endM, 0).getDate()).padStart(2, '0')}`;

  const grouped = await fetchGroupedByDate(openid, ledgerId, startDate, endDate);

  // 按月聚合
  const monthMap = {};
  grouped.forEach((g) => {
    const ym = g.date.slice(0, 7);
    if (!monthMap[ym]) monthMap[ym] = { ym, expense: 0, income: 0 };
    monthMap[ym].expense += g.expense;
    monthMap[ym].income += g.income;
  });

  // 补齐 12 个月
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(startY, startM - 1 + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const g = monthMap[ym] || { ym, expense: 0, income: 0 };
    months.push({ ...g, label: `${d.getMonth() + 1}月`, year: d.getFullYear() });
  }

  return { code: 0, data: { range: 'month', offset: off, startYm: `${startY}-${String(startM).padStart(2, '0')}`, endYm: `${endY}-${String(endM).padStart(2, '0')}`, months } };
}

/**
 * 年趋势：历年消费对比
 */
async function getYearlyTrend(openid, ledgerId) {
  const grouped = await fetchGroupedByDate(openid, ledgerId);

  const yearMap = {};
  grouped.forEach((g) => {
    const y = g.date.slice(0, 4);
    if (!yearMap[y]) yearMap[y] = { year: y, expense: 0, income: 0 };
    yearMap[y].expense += g.expense;
    yearMap[y].income += g.income;
  });

  const years = Object.values(yearMap)
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((y) => ({ ...y, label: `${y.year}年` }));

  return { code: 0, data: { range: 'year', years } };
}

/**
 * 今日汇总
 */
async function getTodayStats(openid, { ledgerId }) {
  const today = formatDate(new Date());

  try {
    const [totals, categories] = await Promise.all([
      fetchTotals(openid, ledgerId, today, today),
      fetchGroupedByCategory(openid, ledgerId, today, today, 'expense'),
    ]);

    // 按分类汇总今日支出
    const categoryBreakdown = categories
      .map((cat) => ({
        categoryId: cat.categoryId,
        categoryName: cat.categoryName,
        amount: cat.amount,
        count: cat.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    return {
      code: 0,
      data: {
        totalExpense: totals.expense,
        totalIncome: totals.income,
        expenseCount: totals.expenseCount,
        incomeCount: totals.incomeCount,
        recordCount: totals.recordCount,
        date: today,
        categoryBreakdown,
      },
    };
  } catch (err) {
    console.error('Today stats error:', err);
    return { code: -1, message: '统计失败' };
  }
}

/**
 * 月度汇总
 */
async function getMonthlyStats(openid, { year, month, ledgerId }) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${ym}-01`;
  // 计算月末
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${ym}-${String(lastDay).padStart(2, '0')}`;

  try {
    const [totals, grouped] = await Promise.all([
      fetchTotals(openid, ledgerId, startDate, endDate),
      fetchGroupedByDate(openid, ledgerId, startDate, endDate),
    ]);

    const summary = {
      totalExpense: totals.expense,
      totalIncome: totals.income,
      recordCount: totals.recordCount,
      daysWithRecords: grouped.filter((g) => g.expense > 0 || g.income > 0).length,
    };

    // 日均支出
    const daysInMonth = lastDay;
    summary.avgDailyExpense = summary.totalExpense / daysInMonth;

    // 余额
    summary.balance = summary.totalIncome - summary.totalExpense;

    return { code: 0, data: summary };
  } catch (err) {
    console.error('Monthly stats error:', err);
    return { code: -1, message: '统计失败' };
  }
}

/**
 * 分类统计（饼图数据）
 */
async function getCategoryStats(openid, { startDate, endDate, type = 'expense', ledgerId }) {
  if (!startDate || !endDate) {
    const now = new Date();
    startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    endDate = formatDate(now);
  }

  try {
    const grouped = await fetchGroupedByCategory(openid, ledgerId, startDate, endDate, type);

    let totalAmount = 0;
    grouped.forEach((cat) => {
      totalAmount += cat.amount;
    });

    const categories = grouped
      .map((cat) => ({
        categoryId: cat.categoryId,
        categoryName: cat.categoryName,
        amount: cat.amount,
        count: cat.count,
        percentage: totalAmount > 0 ? Math.round((cat.amount / totalAmount) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    return {
      code: 0,
      data: { categories, totalAmount, startDate, endDate },
    };
  } catch (err) {
    console.error('Category stats error:', err);
    return { code: -1, message: '统计失败' };
  }
}

/**
 * 每日趋势（折线图数据）
 */
async function getDailyTrend(openid, { year, month, ledgerId }) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${ym}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${ym}-${String(lastDay).padStart(2, '0')}`;

  try {
    const grouped = await fetchGroupedByDate(openid, ledgerId, startDate, endDate);

    // 按日期分组（初始化所有日期，保证折线图完整）
    const dailyMap = {};
    for (let d = 1; d <= lastDay; d++) {
      const key = `${ym}-${String(d).padStart(2, '0')}`;
      dailyMap[key] = { date: key, day: d, expense: 0, income: 0, count: 0 };
    }

    grouped.forEach((g) => {
      if (dailyMap[g.date]) {
        dailyMap[g.date].expense = g.expense;
        dailyMap[g.date].income = g.income;
        dailyMap[g.date].count = g.count;
      }
    });

    return {
      code: 0,
      data: {
        year,
        month,
        days: Object.values(dailyMap),
      },
    };
  } catch (err) {
    console.error('Daily trend error:', err);
    return { code: -1, message: '统计失败' };
  }
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 多维度汇总 — 日/周/月/年
 * range: today | week | month | year
 */
async function getSummaryByRange(openid, { range = 'month', ledgerId }) {
  const now = new Date();
  let startDate, endDate, label;

  switch (range) {
    case 'today':
      startDate = formatDate(now);
      endDate = startDate;
      label = '今日';
      break;
    case 'week': {
      // 本周（周一为一周开始）
      const day = now.getDay() || 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - day + 1);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      startDate = formatDate(monday);
      endDate = formatDate(sunday);
      label = '本周';
      break;
    }
    case 'year':
      startDate = `${now.getFullYear()}-01-01`;
      endDate = `${now.getFullYear()}-12-31`;
      label = '本年';
      break;
    case 'month':
    default: {
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      label = '本月';
      break;
    }
  }

  try {
    const totals = await fetchTotals(openid, ledgerId, startDate, endDate);

    const summary = {
      totalExpense: totals.expense,
      totalIncome: totals.income,
      recordCount: totals.recordCount,
      range,
      label,
      startDate,
      endDate,
    };

    summary.balance = summary.totalIncome - summary.totalExpense;

    return { code: 0, data: summary };
  } catch (err) {
    console.error('Summary error:', err);
    return { code: -1, message: '统计失败' };
  }
}
