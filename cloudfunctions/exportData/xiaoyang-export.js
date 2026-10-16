// cloudfunctions/exportData/xiaoyang-export.js
// 把账本数据渲染成「小羊记账」版式的 Excel 工作簿。
// 版式规格全部来自 xiaoyang-layout.js（唯一事实源），这里只做「往格子里填数据 + 样式」。
//
// 样式规格逆向自星提供的模板文件（小羊记账xlsx.xlsx）：
//   标题     宋体 22pt 加粗 红色(FFFF0000) 居中，合并整个月块
//   日期行   宋体 12pt 加粗 居中，细边框，每日合并 2 列
//   明细行   浅灰底(FFF2F2F2) 自动换行 居中，名称列/价格列相邻
//   日合行   宋体 14pt 加粗 红色 居中，每日合并 2 列
//   周合     标签 14pt 加粗；值 18pt，纵向合并明细+日合两行；第五周放月合计
//   行高     标题 27.5pt / 日期 17.5pt / 明细 135pt / 日合 17.5pt
//   列宽     标签列 10.5 / 名称列 17 / 价格列 9 / 周合列 10
const ExcelJS = require('exceljs');
const L = require('./xiaoyang-layout');

const FONT = '宋体';
const RED = 'FFFF0000';
const GRAY_BG = 'FFF2F2F2';
const WEEK_LABELS = ['一周合', '二周合', '三周合', '四周合', '五周合'];

const THIN_BORDER = { style: 'thin' };
const BORDER_ALL = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

const ROW_HEIGHT = { title: 27.5, date: 17.5, items: 135, total: 17.5 };
const COL_WIDTH = { label: 10.5, name: 17, price: 9, weekTotal: 10 };

/** 分 → 元（去掉尾随零：3500→3.5? 不——3500分=35元→"35"；1250分→12.5） */
function fenToYuanNumber(fen) {
  return Number((fen / 100).toFixed(2));
}

/** 一天的记录 → 名称行 / 价格行（多条按创建时间排序后逐行对齐） */
function dayLines(records) {
  const sorted = records.slice().sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });
  const names = [];
  const prices = [];
  let sum = 0;
  for (const r of sorted) {
    // 名称优先用描述，没有描述用分类名 —— 模板里名称是自由文本，
    // 导入时这格会原样回到 description
    names.push(r.description || r.categoryName || '支出');
    prices.push(String(fenToYuanNumber(r.amount)));
    sum += r.amount;
  }
  return { names: names.join('\n'), prices: prices.join('\n'), sum };
}

function styleCell(cell, opts) {
  cell.font = {
    name: FONT,
    size: opts.size || 12,
    bold: !!opts.bold,
    color: opts.color ? { argb: opts.color } : undefined,
  };
  cell.alignment = {
    horizontal: 'center',
    vertical: 'middle',
    wrapText: !!opts.wrap,
  };
  cell.border = BORDER_ALL;
  if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
}

/** 渲染一个月块 */
function renderMonthBlock(ws, year, month, recordsByDay, monthBudgetYuan) {
  const origin = L.blockOrigin(month);
  const r0 = origin.row;
  const c0 = origin.col;

  // ---- 标题行 ----
  ws.mergeCells(r0 + 1, c0 + 1, r0 + 1, c0 + L.BLOCK_COLS); // exceljs 1-based
  const titleCell = ws.getCell(r0 + 1, c0 + 1);
  titleCell.value = L.blockTitle(year, month);
  styleCell(titleCell, { size: 22, bold: true, color: RED });
  ws.getRow(r0 + 1).height = ROW_HEIGHT.title;

  const dim = new Date(year, month, 0).getDate();
  let monthTotal = 0;

  for (let w = 0; w < L.WEEKS_PER_BLOCK; w++) {
    const rows = L.weekRows(w);
    const dateRow = r0 + rows.dateRow + 1;   // 转 1-based
    const itemsRow = r0 + rows.itemsRow + 1;
    const totalRow = r0 + rows.totalRow + 1;

    ws.getRow(dateRow).height = ROW_HEIGHT.date;
    ws.getRow(itemsRow).height = ROW_HEIGHT.items;
    ws.getRow(totalRow).height = ROW_HEIGHT.total;

    // 行标签
    const dateLabel = ws.getCell(dateRow, c0 + 1);
    dateLabel.value = L.LABEL_DATE;
    styleCell(dateLabel, { size: 12, bold: true });
    const itemsLabel = ws.getCell(itemsRow, c0 + 1);
    itemsLabel.value = L.LABEL_ITEMS;
    styleCell(itemsLabel, { size: 12, bg: GRAY_BG });
    const totalLabel = ws.getCell(totalRow, c0 + 1);
    totalLabel.value = L.LABEL_TOTAL;
    styleCell(totalLabel, { size: 14, bold: true, color: RED });

    let weekTotal = 0;
    const invalidSlots = []; // 本月不存在的日期槽（留给月计划便签）

    for (let i = 0; i < L.DAYS_PER_WEEK; i++) {
      const day = w * L.DAYS_PER_WEEK + i + 1;
      const nameCol = c0 + 2 + i * 2;   // 1-based
      const priceCol = nameCol + 1;

      if (day > dim) {
        invalidSlots.push(i);
        continue;
      }

      // 日期格：合并 2 列
      ws.mergeCells(dateRow, nameCol, dateRow, priceCol);
      const dateCell = ws.getCell(dateRow, nameCol);
      dateCell.value = `${month}月${day}日`;
      styleCell(dateCell, { size: 12, bold: true });

      // 明细格：名称 + 价格
      const records = recordsByDay[day] || [];
      const lines = dayLines(records);
      const nameCell = ws.getCell(itemsRow, nameCol);
      nameCell.value = lines.names || '';
      styleCell(nameCell, { size: 12, bg: GRAY_BG, wrap: true });
      const priceCell = ws.getCell(itemsRow, priceCol);
      priceCell.value = lines.prices || '';
      styleCell(priceCell, { size: 12, bg: GRAY_BG, wrap: true });

      // 日合：合并 2 列，有数据才写值
      ws.mergeCells(totalRow, nameCol, totalRow, priceCol);
      const totalCell = ws.getCell(totalRow, nameCol);
      if (records.length) totalCell.value = fenToYuanNumber(lines.sum);
      styleCell(totalCell, { size: 14, bold: true, color: RED });

      weekTotal += lines.sum;
      monthTotal += lines.sum;
    }

    // 本周不存在的日期槽：涂成明细灰底/边框保持网格感
    // （第 5 周的剩余槽位稍后会整体合并成月计划便签）
    for (const i of invalidSlots) {
      const nameCol = c0 + 2 + i * 2;
      styleCell(ws.getCell(dateRow, nameCol), { size: 12, bold: true });
      styleCell(ws.getCell(dateRow, nameCol + 1), { size: 12, bold: true });
      styleCell(ws.getCell(itemsRow, nameCol), { size: 12, bg: GRAY_BG, wrap: true });
      styleCell(ws.getCell(itemsRow, nameCol + 1), { size: 12, bg: GRAY_BG, wrap: true });
      styleCell(ws.getCell(totalRow, nameCol), { size: 14, bold: true, color: RED });
      styleCell(ws.getCell(totalRow, nameCol + 1), { size: 14, bold: true, color: RED });
    }

    // 第 5 周：把不存在的日期槽合并成「月计划支出」便签（模板原样）
    if (w === L.WEEKS_PER_BLOCK - 1 && invalidSlots.length) {
      const firstCol = c0 + 2 + invalidSlots[0] * 2;
      const lastCol = c0 + 2 + 6 * 2 + 1;
      ws.mergeCells(dateRow, firstCol, itemsRow, lastCol);
      const noteCell = ws.getCell(dateRow, firstCol);
      noteCell.value = monthBudgetYuan
        ? `月计划支出\n合  计：${monthBudgetYuan}`
        : '';
      styleCell(noteCell, { size: 12, wrap: true });
      ws.mergeCells(totalRow, firstCol, totalRow, lastCol);
      styleCell(ws.getCell(totalRow, firstCol), { size: 14, bold: true, color: RED });
    }

    // 周合列：标签 + 值（值纵向合并明细/日合两行；第五周写月合计，与模板一致）
    const labelCell = ws.getCell(dateRow, c0 + L.COL_WEEK_TOTAL + 1);
    labelCell.value = WEEK_LABELS[w];
    styleCell(labelCell, { size: 14, bold: true });
    ws.mergeCells(itemsRow, c0 + L.COL_WEEK_TOTAL + 1, totalRow, c0 + L.COL_WEEK_TOTAL + 1);
    const totalValue = ws.getCell(itemsRow, c0 + L.COL_WEEK_TOTAL + 1);
    const display = w === L.WEEKS_PER_BLOCK - 1 ? monthTotal : weekTotal;
    if (display > 0) totalValue.value = fenToYuanNumber(display);
    styleCell(totalValue, { size: 18 });
  }

  return monthTotal;
}

/** 底部年度汇总：A 列月份、B 列月合计，最后合计行 */
function renderYearSummary(ws, monthlyTotals) {
  const start = L.SUMMARY_START_ROW + 1; // 1-based，首行留空
  let yearTotal = 0;
  for (let m = 1; m <= 12; m++) {
    const row = start + m;
    const label = ws.getCell(row, 1);
    label.value = `${m}月`;
    styleCell(label, { size: 12, bold: true });
    const value = ws.getCell(row, 2);
    const t = monthlyTotals[m] || 0;
    if (t > 0) value.value = fenToYuanNumber(t);
    styleCell(value, { size: 12, bold: true });
    yearTotal += t;
  }
  const sumLabel = ws.getCell(start + 13, 1);
  sumLabel.value = '合计';
  styleCell(sumLabel, { size: 12, bold: true, color: RED });
  const sumValue = ws.getCell(start + 13, 2);
  if (yearTotal > 0) sumValue.value = fenToYuanNumber(yearTotal);
  styleCell(sumValue, { size: 14, bold: true, color: RED });
}

/** 设置一个月块占用的 16 列列宽 */
function applyBlockWidths(ws, c0) {
  ws.getColumn(c0 + 1).width = COL_WIDTH.label;
  for (let i = 0; i < L.DAYS_PER_WEEK; i++) {
    ws.getColumn(c0 + 2 + i * 2).width = COL_WIDTH.name;
    ws.getColumn(c0 + 3 + i * 2).width = COL_WIDTH.price;
  }
  ws.getColumn(c0 + L.COL_WEEK_TOTAL + 1).width = COL_WIDTH.weekTotal;
}

/** 收入子表：简单流水（模板没有收入区，这是导出侧自定义的补充表） */
function renderIncomeSheet(wb, year, incomes) {
  const ws = wb.addWorksheet(L.incomeSheetName(year));
  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 12;

  const header = ws.getRow(1);
  L.INCOME_HEADERS.forEach((h, i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    styleCell(cell, { size: 12, bold: true, bg: GRAY_BG });
  });
  header.height = 20;

  incomes
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .forEach((r, idx) => {
      const row = ws.getRow(idx + 2);
      const c1 = row.getCell(1);
      c1.value = r.date;
      styleCell(c1, { size: 12 });
      const c2 = row.getCell(2);
      c2.value = r.description || r.categoryName || '收入';
      styleCell(c2, { size: 12 });
      c2.alignment = { horizontal: 'left', vertical: 'middle' };
      const c3 = row.getCell(3);
      c3.value = fenToYuanNumber(r.amount);
      styleCell(c3, { size: 12 });
    });
}

/**
 * 生成工作簿。
 * @param {Object} opts
 *   expenses: 支出记录数组（amount 单位：分，date 'YYYY-MM-DD'）
 *   incomes:  收入记录数组
 *   budgetsByYm: { 'YYYY-MM': 预算金额（元） }，写进月计划便签
 * @returns {Promise<Buffer>} xlsx 文件内容
 */
async function buildWorkbook({ expenses, incomes, budgetsByYm }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '小羊记账';
  wb.created = new Date();

  // 按 年 → 月 → 日 分组
  const byYear = {}; // { 2026: { 1: { 3: [records] } } }
  for (const r of expenses) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date || '');
    if (!m) continue;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!byYear[y]) byYear[y] = {};
    if (!byYear[y][mo]) byYear[y][mo] = {};
    if (!byYear[y][mo][d]) byYear[y][mo][d] = [];
    byYear[y][mo][d].push(r);
  }
  const incomeByYear = {};
  for (const r of incomes) {
    const y = Number(String(r.date || '').slice(0, 4));
    if (!y) continue;
    if (!incomeByYear[y]) incomeByYear[y] = [];
    incomeByYear[y].push(r);
  }

  const years = Array.from(new Set([...Object.keys(byYear), ...Object.keys(incomeByYear)]))
    .map(Number)
    .sort();

  for (const year of years) {
    const yearMonths = byYear[year] || {};
    // 支出子表（该年有支出才建；纯收入年只建收入表）
    if (Object.keys(yearMonths).length) {
      const ws = wb.addWorksheet(`${year}年`);
      applyBlockWidths(ws, 0);
      applyBlockWidths(ws, L.BLOCK_COLS);
      const monthlyTotals = {};
      for (let month = 1; month <= 12; month++) {
        const budget = budgetsByYm[`${year}-${String(month).padStart(2, '0')}`] || 0;
        monthlyTotals[month] = renderMonthBlock(ws, year, month, yearMonths[month] || {}, budget);
      }
      renderYearSummary(ws, monthlyTotals);
    }
    // 收入子表
    if (incomeByYear[year] && incomeByYear[year].length) {
      renderIncomeSheet(wb, year, incomeByYear[year]);
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbook, fenToYuanNumber };
