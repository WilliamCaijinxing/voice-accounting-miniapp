// cloudfunctions/importData/xiaoyang-parse.js
// 解析「小羊记账」版式的 xlsx，产出扁平记录数组。
// 坐标推导全部来自 xiaoyang-layout.js（与导出同一份事实源，保证 round-trip 一致）。
//
// 关键设计：**日期按格子位置推导，不信任手写标签**。
// 模板里第 w 周第 i 天就是当月的第 (w*7+i+1) 日，这是一条硬约定；
// 而用户手写的日期标签可能被拖动、被合并、甚至写成「20256年」这种笔误。
// 相信位置、不信标签，解析才能稳。
const ExcelJS = require('exceljs');
const L = require('./xiaoyang-layout');

// 块内向下扫描上限 = 月块高度 - 1（标题行之后只剩 15 行：5 周 × 3 行）。
// 不能给更大的余量：写大会越界扫进下一个横带的月块（它的明细行会被当成
// 本块的第 6 个周组），沙箱里正是这么炸出来的。
const MAX_ROWS_PER_BLOCK = L.BLOCK_ROWS - 1;

/** 遍历上限：正常年表约 120 行 × 34 列，给手写文件的漂移留余量 */
const MAX_SCAN_ROWS = 400;
const MAX_SCAN_COLS = 80;

/**
 * 单元格文本（安全版）。
 *
 * ⚠️ exceljs 读**合并单元格的非左上角成员**时，cell.text 会抛
 *   TypeError: Cannot read properties of null (reading 'toString')
 * （MergeValue.toString 拿到 master.value === null 就直接炸）。
 * 而 ws.eachRow/eachCell 恰恰会把这些成员也遍历出来 —— 沙箱里发现这一点后，
 * 全部读取改走这个 try/catch 版本，避免整个解析因为一个空格子挂掉。
 */
function safeText(ws, row, col) {
  if (row < 1 || col < 1) return '';
  try {
    const v = ws.getCell(row, col).text;
    return v == null ? '' : String(v);
  } catch (err) {
    return '';
  }
}

/** 单元格文本：合并单元格取左上角值，其余情况兜底为空串 */
function cellText(ws, row, col) {
  return safeText(ws, row, col);
}

/** 从一行文本里取出金额（"21«" 这类脏输入也能取到 21） */
function parseAmountLine(line) {
  const m = /^-?\d+(\.\d+)?/.exec(String(line).trim());
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 解析一个月块。
 * @returns {{ records: Array, warnings: Array<string> }}
 */
function parseMonthBlock(ws, blockRow, blockCol, year, month) {
  const records = [];
  const warnings = [];
  const dim = daysInMonth(year, month);

  let weekIdx = -1;
  for (let r = 1; r <= MAX_ROWS_PER_BLOCK; r++) {
    const label = cellText(ws, blockRow + r, blockCol).trim();
    if (label !== L.LABEL_ITEMS) continue;
    weekIdx += 1;
    const week = weekIdx + 1;
    if (week > L.WEEKS_PER_BLOCK) {
      // 超过 5 个周组：不是本模板的月块（可能扫描到了别的内容），停止
      warnings.push(`${year}-${pad2(month)} 周组超过 ${L.WEEKS_PER_BLOCK} 组，已忽略多余部分`);
      break;
    }

    for (let i = 0; i < L.DAYS_PER_WEEK; i++) {
      const day = (week - 1) * L.DAYS_PER_WEEK + i + 1;
      if (day > dim) continue;

      const nameCol = blockCol + 1 + i * 2;
      const priceCol = nameCol + 1;
      const names = cellText(ws, blockRow + r, nameCol).split('\n');
      const prices = cellText(ws, blockRow + r, priceCol).split('\n');

      const date = `${year}-${pad2(month)}-${pad2(day)}`;

      if (names.length !== prices.length) {
        warnings.push(`${date} 名称 ${names.length} 行 / 金额 ${prices.length} 行 数量不等，按较短的一边对齐`);
      }
      const pairs = Math.min(names.length, prices.length);
      for (let k = 0; k < pairs; k++) {
        const desc = String(names[k] || '').trim();
        const amount = parseAmountLine(prices[k]);
        if (!desc && (amount === null || amount === 0)) continue; // 整行空白
        if (amount === null) {
          warnings.push(`${date} 第 ${k + 1} 行金额无法解析：「${String(prices[k]).trim()}」，该行已跳过`);
          continue;
        }
        if (amount === 0) continue; // 0 元行无意义
        records.push({ date, desc, amount, type: 'expense' });
      }
    }
  }

  return { records, warnings };
}

/** 在整张表里找出所有月块标题 → [{ row, col, year, month }]（行列 1-based） */
function findMonthBlocks(ws, sheetYear) {
  const blocks = [];
  const maxRow = Math.min(ws.rowCount || 0, MAX_SCAN_ROWS);
  const maxCol = Math.min(ws.columnCount || 0, MAX_SCAN_COLS);
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber++) {
    for (let colNumber = 1; colNumber <= maxCol; colNumber++) {
      const text = safeText(ws, rowNumber, colNumber);
      if (!text) continue;
      const m = L.TITLE_RE.exec(text);
      if (!m) continue;
      const month = Number(m[2]);
      if (month < 1 || month > 12) continue;
      // 年份以**子表名**为准：手写的标题年份会出错（真实模板里就有
      // 「20256年小羊记账月表-1月」这种笔误），信任标题就会把整本账导入到错误的年份
      const titleYear = Number(m[1]);
      const year = sheetYear || titleYear;
      if (!year) continue;
      blocks.push({ row: rowNumber, col: colNumber, year, month });
    }
  }
  return blocks;
}

/** 解析收入流水子表（导出侧自定义格式，第一行表头） */
function parseIncomeSheet(ws, fallbackYear) {
  const records = [];
  const headers = {};
  const maxCol = Math.min(ws.columnCount || 0, MAX_SCAN_COLS);
  for (let col = 1; col <= maxCol; col++) {
    const h = safeText(ws, 1, col).trim();
    if (h) headers[h] = col;
  }
  const dateCol = headers['日期'];
  const nameCol = headers['名称'];
  const amountCol = headers['金额(元)'];
  if (!dateCol || !amountCol) return { records, warnings: [] };

  let emptyStreak = 0;
  for (let r = 2; r <= ws.rowCount && emptyStreak < 5; r++) {
    const rawDate = safeText(ws, r, dateCol).trim();
    const rawAmount = safeText(ws, r, amountCol).trim();
    if (!rawDate && !rawAmount) {
      emptyStreak += 1;
      continue;
    }
    emptyStreak = 0;
    const amount = parseAmountLine(rawAmount);
    let date = '';
    // 日期格可能是纯文本，也可能带数字格式（safeText 已给出格式化后的文本）
    const mDate = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(rawDate);
    if (mDate) {
      date = `${mDate[1]}-${pad2(mDate[2])}-${pad2(mDate[3])}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      date = rawDate;
    }
    if (!date || amount === null || amount === 0) continue;
    const desc = nameCol ? safeText(ws, r, nameCol).trim() : '';
    records.push({ date, desc, amount, type: 'income' });
  }
  return { records, warnings: [] };
}

/**
 * 解析整个工作簿。
 * @returns {{ records: Array, warnings: Array<string>, years: Array<number> }}
 */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const all = [];
  const warnings = [];
  const years = new Set();

  wb.worksheets.forEach((ws) => {
    const sheetName = ws.name || '';
    const yearMatch = L.SHEET_YEAR_RE.exec(sheetName);
    const sheetYear = yearMatch ? Number(yearMatch[1]) : null;
    const isIncomeSheet = sheetName.endsWith(L.INCOME_SHEET_SUFFIX);

    if (isIncomeSheet) {
      const { records } = parseIncomeSheet(ws, sheetYear);
      records.forEach((r) => {
        years.add(Number(r.date.slice(0, 4)));
        all.push(r);
      });
      return;
    }

    if (!sheetYear) return; // 认不出的子表：不猜，跳过（宁少勿错）

    const blocks = findMonthBlocks(ws, sheetYear);
    blocks.forEach((b) => {
      years.add(b.year);
      const { records, warnings: w } = parseMonthBlock(ws, b.row, b.col, b.year, b.month);
      all.push(...records);
      warnings.push(...w);
    });
  });

  // 同一天的多条记录保持稳定顺序
  all.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  return { records: all, warnings, years: Array.from(years).filter(Boolean) };
}

module.exports = { parseWorkbook, parseAmountLine, daysInMonth };
