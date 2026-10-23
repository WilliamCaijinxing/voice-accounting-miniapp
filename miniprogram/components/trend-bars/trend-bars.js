// components/trend-bars/trend-bars.js — 收支趋势条形图（横向条形 + 独立金额列）
//
// 为什么是横向条形而不是竖向柱：
//   1. 金额要在柱子「旁边」独立成列——横向下柱子末端天然是数字列，竖向只能在柱顶堆字，
//      12 个月 × 2 条柱子的标签会横向打架；
//   2. 不需要横向 scroll-view，一屏看全 12 个月，趋势对比才成立；
//   3. 面积为零的月份也占一行，时间轴的连续性不会断。
//
// 所有数值（百分比宽度、格式化金额、零值标记）一律由调用方在 JS 侧算好后传入，
// 组件只负责渲染。WXML 的 Mustache 不支持调用方法/全局对象，写了会静默渲染为空。
Component({
  properties: {
    // [{ key, label, ym, expense, income, expPct, incPct,
    //    _fmtExpense, _fmtIncome, _zeroExpense, _zeroIncome }]
    list: { type: Array, value: [] },
    title: { type: String, value: '收支趋势' },
    tip: { type: String, value: '' },
    emptyIcon: { type: String, value: '📊' },
    emptyText: { type: String, value: '暂无数据' },

    // 传了 navTitle 才渲染 ‹ 标题 › 翻页条；年视图不需要翻页，留空即可
    navTitle: { type: String, value: '' },
    nextDisabled: { type: Boolean, value: false },

    // 行是否可点（点开该月的分类明细）
    tappable: { type: Boolean, value: false },
  },

  methods: {
    onRowTap(e) {
      if (!this.data.tappable) return;
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item) return;
      this.triggerEvent('itemtap', { item, index });
    },

    onPrev() {
      if (!this.data.navTitle) return;
      this.triggerEvent('prev');
    },

    onNext() {
      if (!this.data.navTitle || this.data.nextDisabled) return;
      this.triggerEvent('next');
    },
  },
});
