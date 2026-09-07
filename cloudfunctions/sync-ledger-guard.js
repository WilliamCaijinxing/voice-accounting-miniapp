// cloudfunctions/sync-ledger-guard.js
// 把 _shared/ledger-guard.js 同步到各云函数目录（微信云函数按目录独立部署，无法跨目录 require）。
// 用法：cd cloudfunctions && node sync-ledger-guard.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '_shared', 'ledger-guard.js');
const TARGETS = ['expenseCRUD', 'statistics', 'budgetCRUD', 'exportData'];

const content = fs.readFileSync(SRC, 'utf8');
for (const dir of TARGETS) {
  const dest = path.join(__dirname, dir, 'ledger-guard.js');
  fs.writeFileSync(dest, content, 'utf8');
  console.log('synced ->', path.relative(__dirname, dest));
}
console.log('done. 副本与源文件一致：', TARGETS.every((d) => fs.readFileSync(path.join(__dirname, d, 'ledger-guard.js'), 'utf8') === content));
