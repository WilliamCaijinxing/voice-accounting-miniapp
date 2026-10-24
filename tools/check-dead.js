#!/usr/bin/env node
/**
 * 死代码静态扫描 —— check-wxml.js 查的是「写了但没定义」，这里查反过来那一半：
 *
 *   1. WXML 引用了 JS 里不存在的字段/方法
 *      → Mustache 静默渲染为空、bind 点了没反应。删 data 字段后最容易漏。
 *   2. WXSS 定义了但没有任何模板使用的类（死样式）
 *      → 删 UI 区块时最容易漏，越攒越多，后来人不敢删。
 *
 * check-wxml 的第 3 条（class 无定义）是「查漏」，本条是「查多」，两者互补。
 * 用法：node tools/check-dead.js
 * 退出码：有第 1 类问题时为 1（真 bug），仅第 2 类时仍为 0。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const appWxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8');

// app.wxss 里的类是全站的，页面用了不算死
const globalClasses = new Set(
  [...appWxss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\.(-?[A-Za-z_][\w-]*)/gm)].map((m) => m[1])
);

// 模板里的内置/局部标识符，不需要在 JS 里定义
const BUILTIN = new Set(['true', 'false', 'null', 'undefined', 'item', 'index', 'length']);

const walk = (dir, ext, acc = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
};

const errors = [];
const warnings = [];

for (const wxmlPath of walk(ROOT, '.wxml')) {
  const base = wxmlPath.replace(/\.wxml$/, '');
  const rel = path.relative(ROOT, wxmlPath).replace(/\\/g, '/');
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  if (!fs.existsSync(`${base}.js`)) continue;
  const js = fs.readFileSync(`${base}.js`, 'utf8');

  // ---- 1. 模板字段是否有来源 ----
  const ids = new Set();
  for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 剥掉字符串字面量，否则 '收入' 这类会被当成标识符
    const expr = m[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, "''");
    for (const t of expr.matchAll(/(^|[^.\w'"])([A-Za-z_$][\w$]*)/g)) {
      if (!BUILTIN.has(t[2])) ids.add(t[2]);
    }
  }
  const missing = [...ids].filter((w) => {
    if (new RegExp(`(^|[\\s,{])${w}\\s*:`, 'm').test(js)) return false;      // data 字段
    if (new RegExp(`(^|[\\s,{])${w}\\s*[:(]`, 'm').test(js)) return false;   // 方法
    if (new RegExp(`(const|let|var)\\s+${w}\\b`).test(js)) return false;     // 顶层变量
    return true;
  });
  for (const w of missing) errors.push(`${rel} → 模板引用了 JS 里不存在的 "${w}"`);

  // ---- 2. 死样式 ----
  if (!fs.existsSync(`${base}.wxss`)) continue;
  const css = [...fs.readFileSync(`${base}.wxss`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/^\.(-?[A-Za-z_][\w-]*)/gm)].map((m) => m[1]);

  const used = new Set();
  for (const m of wxml.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  // 三元表达式里的字符串字面量也可能是类名。
  // 注意字面量里可能有多个类（'card chart-card'），必须按空格拆开再加，
  // 否则会把整串当成一个不存在的类名，于是真正的 chart-card 被误判成死样式。
  for (const m of wxml.matchAll(/\{\{[\s\S]*?\}\}/g)) {
    for (const l of m[0].matchAll(/'([^']*)'/g)) {
      l[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    }
  }

  const dead = css.filter((c) => !used.has(c) && !globalClasses.has(c));
  if (dead.length) warnings.push(`${rel} → 未被使用的样式类：${dead.join(', ')}`);
}

const line = (s) => console.log('  ' + s);
if (errors.length) {
  console.log(`✗ 模板引用了不存在的字段 ${errors.length} 处（会静默渲染为空 / 点了没反应）：`);
  errors.forEach(line);
  console.log('');
}
if (warnings.length) {
  console.log(`△ 死样式 ${warnings.length} 处（定义了但没有任何模板使用）：`);
  warnings.forEach(line);
  console.log('');
}
if (!errors.length && !warnings.length) console.log('✓ 无死字段、无死样式');

process.exit(errors.length ? 1 : 0);
