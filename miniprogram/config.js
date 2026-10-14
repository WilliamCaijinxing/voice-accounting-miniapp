// config.js — 项目级配置（单一事实源）
//
// 云环境 ID 此前直接写死在 app.js 里（P1-21），切换/新增环境时只能靠全局搜索，
// 也容易与部署文档各说各话。集中到这里后改环境只需动一处。

// 微信云开发数据库自动生成的文档 _id 是 **32 位**十六进制（不是 MongoDB 的 24 位），
// 曾经按 24 位假设导致所有真实共享账本 id 被判「不可用」：
// 前端把用户挡在共享账本门外，云函数回「参数非法」。
// 必须与云函数 _shared/ledger-guard.js 的 LEDGER_ID_RE 保持同一口径 ——
// 两边不一致就会出现「前端认为账本可用、云函数回『参数非法』」的错位。
const LEDGER_ID_RE = /^[a-f0-9]{24,32}$/i;

/**
 * 判断一个账本对象是否可用。
 *
 * 为什么要前端也校验：ledgerId 来自 wx.getStorageSync 的本地缓存，
 * 而缓存里可能躺着旧版本写入的、手工改过的、或从别的环境带过来的脏值。
 * app.js 的恢复逻辑此前只看了 ledger.type 就放行，脏 id 会一路传到每个
 * 云函数请求，最终被 guard 回一句「参数非法」，而用户完全不知道问题出在哪。
 *
 * @param {*} ledger 账本对象
 * @returns {boolean} 个人账本恒可用；共享账本必须带合法 hex id（24~32 位）
 */
function isUsableLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') return false;
  if (ledger.type === 'personal') return true;
  return typeof ledger.id === 'string' && LEDGER_ID_RE.test(ledger.id);
}

module.exports = {
  /**
   * 小程序前端版本号。每次上传体验版/正式版时递增。
   * 真机跑的是上传出去的那份代码，本地改动不会自动生效 —— 排查问题时先看
   * 启动日志里的这一行，就能确认真机跑的到底是哪一版，不必再靠猜。
   * 对应 git 提交见下方注释。
   */
  APP_VERSION: '1.0.4', // 2026-10-14 修复 _id 位数误判（32位hex），共享账本恢复可用

  /**
   * 微信云开发环境 ID。
   * 获取方式：微信开发者工具 → 云开发 → 设置 → 环境 ID。
   * 换环境时改这一处即可（云函数侧无需改动，它们跑在同一个环境里）。
   */
  CLOUD_ENV: 'cloud1-d5gk2s5v9147776de',

  LEDGER_ID_RE,
  isUsableLedger,
};
