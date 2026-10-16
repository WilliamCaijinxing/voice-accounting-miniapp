// cloudfunctions/_shared/xiaoyang-layout.js
// 「小羊记账」Excel 格式的布局规格 —— 唯一事实源。
// 导出（exportData）按它摆格子，导入（importData）按它找格子，
// 两边共用同一套坐标推导，保证「导出 → 再导入」能无损往返（round-trip）。
//
// 修改本文件后，在 cloudfunctions 目录执行：node sync-ledger-guard.js
// （该脚本已泛化为共享文件分发，会把本文件同步到 exportData / importData）。

/* ============================================================================
 * 布局总览（所有坐标 0-based，行列均从 0 起）
 *
 * 一个年份一个子表。子表内 12 个月块：两个一行带，共 6 个横带。
 * 月块 = 16 列 × 16 行：
 *
 *   列：  [0]=行标签  [1..14]=7 天 × (名称列, 价格列)  [15]=周合
 *   行：  [0]=标题（合并 16 列）
 *         [1+3w]=日期行   [2+3w]=开销/价格行   [3+3w]=日合行   （w = 0..4 共 5 周）
 *
 * 第 w 周第 i 天（i=0..6）对应每月第 (w*7+i+1) 日；
 * 该日不存在（如 2 月第 29 日以后）时，对应格子在导出侧留空并并入「月计划」便签区。
 *
 * 年度汇总在 SUMMARY_START_ROW 起：A 列月份标签、B 列月合计，最后「合计」行。
 * ========================================================================== */

const BLOCK_COLS = 16;        // 月块宽度（列）
const BLOCK_ROWS = 16;        // 月块高度（行）
const MONTHS_PER_BAND = 2;    // 每个横带放两个月
const WEEK_ROWS = 3;          // 每周 3 行（日期/明细/日合）
const WEEKS_PER_BLOCK = 5;    // 每月固定 5 个周组（1-7, 8-14, 15-21, 22-28, 29-月末）
const DAYS_PER_WEEK = 7;

const COL_LABEL = 0;          // 行标签列（日期 / 开销·价格 / 日合）
const COL_WEEK_TOTAL = 15;    // 周合列（第五周此位置放月合计）

const SUMMARY_START_ROW = 102; // 6 个横带 ×16 行 = 96，空几行后放年度汇总（与原模板一致）
const SUMMARY_ROWS = 14;       // 空行 + 12 个月 + 合计

/** 月块左上角坐标 */
function blockOrigin(month) {
  const idx = month - 1; // 0-based
  return {
    row: Math.floor(idx / MONTHS_PER_BAND) * BLOCK_ROWS,
    col: (idx % MONTHS_PER_BAND) * BLOCK_COLS,
  };
}

/** 月块内第 w 周（0-based）的三行行号（相对月块左上角） */
function weekRows(weekIdx) {
  const dateRow = 1 + weekIdx * WEEK_ROWS;
  return { dateRow, itemsRow: dateRow + 1, totalRow: dateRow + 2 };
}

/**
 * 月块内某天（dayOfMonth，1-based）对应的单元格坐标（相对月块左上角）。
 * 返回 null 表示该月没有这一天（如 2 月 30 日）。
 */
function dayCellRect(year, month, dayOfMonth) {
  const dim = new Date(year, month, 0).getDate(); // month 1-based 时取当月天数
  if (dayOfMonth < 1 || dayOfMonth > dim) return null;
  const weekIdx = Math.floor((dayOfMonth - 1) / DAYS_PER_WEEK);
  const dayIdx = (dayOfMonth - 1) % DAYS_PER_WEEK;
  const rows = weekRows(weekIdx);
  return {
    weekIdx,
    dateRow: rows.dateRow,
    itemsRow: rows.itemsRow,
    totalRow: rows.totalRow,
    nameCol: 1 + dayIdx * 2,   // 名称列
    priceCol: 2 + dayIdx * 2,  // 价格列
  };
}

/** 行标签文案（导入解析时按它识别行类型；只允许这三种 + 标题） */
const LABEL_DATE = '日期';
const LABEL_ITEMS = '开销/价格';
const LABEL_TOTAL = '日合';

/** 月块标题文案与解析 */
function blockTitle(year, month) {
  return `${year}年小羊记账月表-${month}月`;
}
// 手写文件里标题年份可能有笔误（如「20256年」），月份以「-X月」为准、年份以子表名为准
const TITLE_RE = /(\d{4})年.*?月表-(\d{1,2})月/;
const SHEET_YEAR_RE = /(\d{4})年/;

/** 收入子表（导出侧自定义的简单流水表，导入侧按表头解析） */
const INCOME_SHEET_SUFFIX = '年收入';
const INCOME_HEADERS = ['日期', '名称', '金额(元)'];
function incomeSheetName(year) {
  return `${year}年${INCOME_SHEET_SUFFIX}`;
}

module.exports = {
  BLOCK_COLS,
  BLOCK_ROWS,
  MONTHS_PER_BAND,
  WEEK_ROWS,
  WEEKS_PER_BLOCK,
  DAYS_PER_WEEK,
  COL_LABEL,
  COL_WEEK_TOTAL,
  SUMMARY_START_ROW,
  SUMMARY_ROWS,
  blockOrigin,
  weekRows,
  dayCellRect,
  LABEL_DATE,
  LABEL_ITEMS,
  LABEL_TOTAL,
  blockTitle,
  TITLE_RE,
  SHEET_YEAR_RE,
  INCOME_SHEET_SUFFIX,
  INCOME_HEADERS,
  incomeSheetName,
};
