// pages/record/record.js
//
// 【已合并】原「记账页」的全部能力（录音 → 识别 → 确认 → 保存）已迁入首页
// pages/index/index，本页仅作为旧入口（分享链接、历史缓存、外部跳转）的兼容
// 重定向壳，进入后立即跳回首页。
//
// 确认无人引用后可直接删除整个 pages/record 目录，
// 并同步移除 app.json → pages 数组中的 "pages/record/record"。

Page({
  onLoad() {
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        // 极端兜底：switchTab 失败时退回重启动到首页
        wx.reLaunch({ url: '/pages/index/index' });
      },
    });
  },
});
