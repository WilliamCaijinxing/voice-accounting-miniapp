// cloudfunctions/statistics/index.js
// 记账统计聚合云函数（支持个人账本与共享账本）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

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
 * 返回 [{ date, expense, income }]
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
      .group({ _id: '$date', total: $.sum('$amount') })
      .end(),
    db.collection('expenses').aggregate()
      .match({ ...match, type: 'income' })
      .group({ _id: '$date', total: $.sum('$amount') })
      .end(),
  ]);

  const map = {};
  expRes.list.forEach((r) => {
    if (!map[r._id]) map[r._id] = { date: r._id, expense: 0, income: 0 };
    map[r._id].expense = r.total;
  });
  incRes.list.forEach((r) => {
    if (!map[r._id]) map[r._id] = { date: r._id, expense: 0, income: 0 };
    map[r._id].income = r.total;
  });

  return Object.values(map);
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
    const expenses = await db.collection('expenses')
      .where({ ...buildScope(openid, ledgerId), date: today })
      .get();

    const summary = expenses.data.reduce((acc, item) => {
      if (item.type === 'expense') {
        acc.totalExpense += item.amount;
        acc.expenseCount += 1;
      } else {
        acc.totalIncome += item.amount;
        acc.incomeCount += 1;
      }
      return acc;
    }, { totalExpense: 0, totalIncome: 0, expenseCount: 0, incomeCount: 0, recordCount: expenses.data.length });

    // 按分类汇总今日支出
    const categoryBreakdown = {};
    expenses.data
      .filter((item) => item.type === 'expense')
      .forEach((item) => {
        const key = item.categoryId;
        if (!categoryBreakdown[key]) {
          categoryBreakdown[key] = { categoryId: key, categoryName: item.categoryName, amount: 0, count: 0 };
        }
        categoryBreakdown[key].amount += item.amount;
        categoryBreakdown[key].count += 1;
      });

    return {
      code: 0,
      data: {
        ...summary,
        date: today,
        categoryBreakdown: Object.values(categoryBreakdown)
          .sort((a, b) => b.amount - a.amount),
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
    const expenses = await db.collection('expenses')
      .where({
        ...buildScope(openid, ledgerId),
        date: _.gte(startDate).and(_.lte(endDate)),
      })
      .get();

    const summary = {
      totalExpense: 0,
      totalIncome: 0,
      recordCount: expenses.data.length,
      daysWithRecords: new Set(expenses.data.map((e) => e.date)).size,
    };

    expenses.data.forEach((item) => {
      if (item.type === 'expense') summary.totalExpense += item.amount;
      else summary.totalIncome += item.amount;
    });

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
    const expenses = await db.collection('expenses')
      .where({
        ...buildScope(openid, ledgerId),
        type,
        date: _.gte(startDate).and(_.lte(endDate)),
      })
      .get();

    const categoryMap = {};
    let totalAmount = 0;

    expenses.data.forEach((item) => {
      const key = item.categoryId;
      if (!categoryMap[key]) {
        categoryMap[key] = { categoryId: key, categoryName: item.categoryName, amount: 0, count: 0 };
      }
      categoryMap[key].amount += item.amount;
      categoryMap[key].count += 1;
      totalAmount += item.amount;
    });

    const categories = Object.values(categoryMap)
      .map((cat) => ({
        ...cat,
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
    const expenses = await db.collection('expenses')
      .where({
        ...buildScope(openid, ledgerId),
        date: _.gte(startDate).and(_.lte(endDate)),
      })
      .get();

    // 按日期分组
    const dailyMap = {};
    // 初始化所有日期
    for (let d = 1; d <= lastDay; d++) {
      const key = `${ym}-${String(d).padStart(2, '0')}`;
      dailyMap[key] = { date: key, day: d, expense: 0, income: 0, count: 0 };
    }

    expenses.data.forEach((item) => {
      if (dailyMap[item.date]) {
        if (item.type === 'expense') dailyMap[item.date].expense += item.amount;
        else dailyMap[item.date].income += item.amount;
        dailyMap[item.date].count += 1;
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
    const expenses = await db.collection('expenses')
      .where({
        ...buildScope(openid, ledgerId),
        date: _.gte(startDate).and(_.lte(endDate)),
      })
      .get();

    const summary = {
      totalExpense: 0,
      totalIncome: 0,
      recordCount: expenses.data.length,
      range,
      label,
      startDate,
      endDate,
    };

    expenses.data.forEach((item) => {
      if (item.type === 'expense') summary.totalExpense += item.amount;
      else summary.totalIncome += item.amount;
    });

    summary.balance = summary.totalIncome - summary.totalExpense;

    return { code: 0, data: summary };
  } catch (err) {
    console.error('Summary error:', err);
    return { code: -1, message: '统计失败' };
  }
}
