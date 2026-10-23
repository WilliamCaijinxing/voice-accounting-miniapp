const fs=require('fs'),path=require('path');let fail=0;
const err=(m)=>{fail++;console.log('FAIL '+m);};
const P=(p)=>path.join(__dirname,p);
const wxml=fs.readFileSync(P('miniprogram/components/trend-bars/trend-bars.wxml'),'utf8');
const js=fs.readFileSync(P('miniprogram/components/trend-bars/trend-bars.js'),'utf8');
const css=fs.readFileSync(P('miniprogram/components/trend-bars/trend-bars.wxss'),'utf8')+fs.readFileSync(P('miniprogram/app.wxss'),'utf8');
let m;const seen=new Set();
const re=/(?:bind|catch)(?::)?[a-zA-Z]+\s*=\s*"([^"{}]+)"/g;
while((m=re.exec(wxml))){const h=m[1].trim();if(!h||seen.has(h))continue;seen.add(h);
  if(!new RegExp('(^|[\\s,{])'+h+'\\s*[:(]','m').test(js))err('绑定 '+h+' 未定义');}
console.log('  处理器: '+seen.size);
// Mustache 函数调用（先剥字符串，再剥三元里的字面量）
const stripped=wxml.replace(/'[^']*'|"[^"]*"/g,"''");
const re2=/\{\{([\s\S]*?)\}\}/g;
while((m=re2.exec(stripped))){if(/(^|[^.\w])([A-Za-z_$][\w$]*)\s*\(/.test(m[1]))err('Mustache 函数调用: '+m[1].trim());}
// class 定义
const defined=new Set();const reDef=/\.([A-Za-z0-9_-]+)/g;let d;
while((d=reDef.exec(css)))defined.add(d[1]);
const missing=new Set();
const reAttr=/class\s*=\s*"([^"]*)"/g;let a;
while((a=reAttr.exec(wxml))){
  a[1].replace(/\{\{[\s\S]*?\}\}/g,' ').split(/\s+/).filter(Boolean).forEach(c=>{if(!c.includes('{')&&!c.includes('}')&&!defined.has(c))missing.add(c);});
  // 三元里的类名
  const t=/\{\{[\s\S]*?\}\}/g;let tt;
  while((tt=t.exec(a[1]))){const r=/'([a-z][\w-]*)'/g;let r2;while((r2=r.exec(tt[0]))){const before=tt[0].slice(Math.max(0,r2.index-3),r2.index);if(/[=!]==?\s*$/.test(before))continue;if(!defined.has(r2[1]))missing.add(r2[1]);}}
}
missing.forEach(c=>err('class "'+c+'" 无样式定义'));
console.log('  样式类缺失: '+missing.size);
console.log(fail===0?'ALL PASS':fail+' 个问题');
process.exit(fail===0?0:1);
