#!/usr/bin/env node
/**
 * 小程序模板静态三查 —— 查的都是「不报错但功能静默失效」的三类问题：
 *
 *   1. WXML 里 bind* / catch* 绑定的处理器，在对应 .js 里找不到定义
 *      → 点了没反应，控制台一声不吭。
 *   2. Mustache {{}} 里出现了函数调用（含 Math.random() 等全局对象）
 *      → 渲染成空字符串，不报错，极难发现。
 *   3. WXML 用到的静态 class 在 wxss 里没有定义
 *      → 样式静默失效。
 *
 * 样式隔离要点：自定义组件是 isolated 的，app.wxss 与页面 wxss 都不作用于组件内部，
 * 所以组件的合法类名只来自它自己的 wxss；页面则可以用 app.wxss + 自己的 wxss。
 *
 * 用法：node tools/check-wxml.js
 * 退出码：有 1/2 类问题（真 bug）时为 1，仅第 3 类（样式缺口）时为 0。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');

const walk = (dir, ext, acc = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
};

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const appWxss = read(path.join(ROOT, 'app.wxss'));

// 从 wxss 里抽类名。跳过注释，避免把注释里的示例类名当成已定义。
const classesOf = (cssSrc) => {
  const clean = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  for (const m of clean.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]);
  return out;
};
const appClasses = classesOf(appWxss);

const errors = [];
const warnings = [];
const templates = walk(ROOT, '.wxml');

for (const wxmlPath of templates) {
  const file = wxmlPath.replace(/\.wxml$/, '');
  const name = rel(wxmlPath);
  const wxml = read(wxmlPath);

  // ---- 1. 事件处理器是否定义 ----
  if (fs.existsSync(`${file}.js`)) {
    const js = read(`${file}.js`);
    const handlers = new Set();
    for (const m of wxml.matchAll(/(?:bind|catch)(?::)?[A-Za-z]+\s*=\s*"([^"{}]+)"/g)) {
      const h = m[1].trim();
      if (h) handlers.add(h);
    }
    for (const h of handlers) {
      // 允许普通方法、async 方法、箭头函数属性三种写法
      const defined = new RegExp(`(^|[\\s,{])(async\\s+)?${h}\\s*[:(]`, 'm').test(js);
      if (!defined) errors.push(`${name} → 绑定的处理器 ${h} 在 JS 里未定义`);
    }
  }

  // ---- 2. Mustache 里是否出现函数调用 ----
  // 先剥掉引号内字符串，否则 '收入' 这类字面量会被误判成调用
  const stripped = wxml.replace(/'[^']*'|"[^"]*"/g, "''");
  for (const m of stripped.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 裸标识符后跟左括号即视为调用（a.b.c 属性访问不算）
    if (/(^|[^.\w])([A-Za-z_$][\w$]*)\s*\(/.test(m[1])) {
      errors.push(`${name} → Mustache 内出现函数调用：{{${m[1].trim()}}}`);
    }
  }

  // ---- 3. class 是否有样式定义 ----
  const isComponent = name.startsWith('components/');
  const ownWxss = fs.existsSync(`${file}.wxss`) ? classesOf(read(`${file}.wxss`)) : new Set();
  const defined = isComponent ? ownWxss : new Set([...appClasses, ...ownWxss]);

  const missing = new Set();
  for (const m of wxml.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    const raw = m[1];
    // 静态部分
    raw.replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => { if (!defined.has(c)) missing.add(c); });
    // 三元/逻辑表达式里的字符串字面量
    for (const expr of raw.matchAll(/\{\{[\s\S]*?\}\}/g)) {
      for (const lit of expr[0].matchAll(/'([a-z][\w-]*)'/g)) {
        const before = expr[0].slice(Math.max(0, lit.index - 4), lit.index);
        if (/[=!]==?\s*$/.test(before)) continue; // 'left' === x 这类比较的左值不是类名
        if (!defined.has(lit[1])) missing.add(lit[1]);
      }
    }
  }
  for (const c of missing) warnings.push(`${name} → class "${c}" 无样式定义`);
}

const line = (s) => console.log('  ' + s);

console.log(`检查范围：${templates.length} 个模板（页面 + 组件）\n`);

if (errors.length) {
  console.log(`✗ 功能性缺陷 ${errors.length} 处（会导致点击无响应 / 渲染为空）：`);
  errors.forEach(line);
  console.log('');
}

if (warnings.length) {
  console.log(`△ 样式缺口 ${warnings.length} 处（不影响功能，但那段样式不会生效）：`);
  warnings.forEach(line);
  console.log('');
}

if (!errors.length && !warnings.length) console.log('✓ 三查全部通过');

process.exit(errors.length ? 1 : 0);
