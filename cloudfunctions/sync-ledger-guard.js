// cloudfunctions/sync-ledger-guard.js
// 把 _shared/ 下的共享模块同步到需要它的云函数目录
// （微信云函数按目录独立部署，无法跨目录 require，只能每个目录放一份副本）。
// 用法：cd cloudfunctions && node sync-ledger-guard.js
//
// 注意：只改 _shared/ 里的源文件，不要直接改云函数目录内的副本。
const fs = require('fs');
const path = require('path');

const SYNC_PLAN = [
  {
    // 账本访问守卫 + 角色模型（P0-1 / P1-8 的唯一事实源）
    // groupCRUD 在列：它要用 roleOf 下发「我的角色」，不能自己复制一份角色逻辑
    // （角色语义一旦有两份实现必然漂移 —— P1-19 记录过的教训）。
    src: 'ledger-guard.js',
    targets: ['expenseCRUD', 'statistics', 'budgetCRUD', 'exportData', 'groupCRUD', 'importData'],
  },
  {
    // 「小羊记账」Excel 布局规格：导出按它摆格子、导入按它找格子，
    // 共用同一套坐标推导才能保证 round-trip 一致。
    src: 'xiaoyang-layout.js',
    targets: ['exportData', 'importData'],
  },
];

let allOk = true;
for (const { src, targets } of SYNC_PLAN) {
  const srcPath = path.join(__dirname, '_shared', src);
  const content = fs.readFileSync(srcPath, 'utf8');
  for (const dir of targets) {
    const destDir = path.join(__dirname, dir);
    if (!fs.existsSync(destDir)) {
      console.log('skip（目录不存在）->', dir);
      allOk = false;
      continue;
    }
    const dest = path.join(destDir, src);
    fs.writeFileSync(dest, content, 'utf8');
    console.log('synced ->', path.relative(__dirname, dest));
  }
  const consistent = targets
    .filter((d) => fs.existsSync(path.join(__dirname, d)))
    .every((d) => fs.readFileSync(path.join(__dirname, d, src), 'utf8') === content);
  console.log(`${src} 副本一致：`, consistent);
  allOk = allOk && consistent;
}
console.log('done. 全部一致：', allOk);
process.exit(allOk ? 0 : 1);
