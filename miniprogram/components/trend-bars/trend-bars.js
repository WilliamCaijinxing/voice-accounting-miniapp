// components/trend-bars/trend-bars.js — 收支趋势分组柱状图（竖向双柱 + Y 轴刻度 + 点选浮层）
//
// 为什么不用 canvas：只有 12 组柱子，纯 CSS/flex 就能精确控制柱高与对齐，
// 还免掉 canvas 的 DPR 换算、尺寸测量、重绘时机与层级覆盖问题。
//
// 所有数值（Y 轴刻度、柱高百分比、格式化金额、标签是否显示）一律由调用方
// 在 JS 侧算好后传入，组件只负责渲染与交互。
// WXML 的 Mustache 不支持调用方法/全局对象，写了会静默渲染为空。
Component({
  properties: {
    // [{ key, label, showLabel, expense, income, expPct, incPct,
    //    _fmtExpense, _fmtIncome, _zeroExpense, _zeroIncome }]
    list: { type: Array, value: [] },
    // [{ label, pct, isBase, key }]，从高到低排列（含 0 值刻度）
    yTicks: { type: Array, value: [] },

    title: { type: String, value: '收支趋势' },
    tip: { type: String, value: '' },
    emptyIcon: { type: String, value: '📊' },
    emptyText: { type: String, value: '暂无数据' },

    // 传了 navTitle 才渲染 ‹ 标题 › 翻页条；年视图不需要翻页，留空即可
    navTitle: { type: String, value: '' },
    nextDisabled: { type: Boolean, value: false },

    // 浮层里是否给「查看分类」入口（月视图需要，周/年没有分类弹窗）
    showDetailLink: { type: Boolean, value: false },
  },

  data: {
    empty: true,
    // 点选浮层。leftPct 是相对绘图区宽度的百分比（组中心，也就是指示线位置）；
    // side 决定浮层贴在指示线的哪一侧——永远放在"外侧"，
    // 保证不遮住用户正在看的那组柱子。
    tooltip: {
      visible: false,
      index: -1,
      leftPct: 50,
      side: 'right',
      label: '',
      _fmtIncome: '0',
      _fmtExpense: '0',
    },
  },

  observers: {
    list(list) {
      this.setData({ empty: !list || list.length === 0 });
    },
    // 数据换了（翻页/切账本）就把浮层收掉，否则会停在上一个区间的数字上
    yTicks() {
      if (this.data.tooltip.visible) {
        this.setData({ 'tooltip.visible': false });
      }
    },
  },

  methods: {
    /** 点某一组柱子：没选中就弹浮层，已选中则收起 */
    onGroupTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item) return;

      if (this.data.tooltip.visible && this.data.tooltip.index === index) {
        this.setData({ 'tooltip.visible': false });
        return;
      }

      const n = this.data.list.length || 1;
      // 组中心 = 指示线位置。下标落在左半区时浮层放右侧，反之放左侧，
      // 这样浮层始终在指示线的"外侧"，不会盖住选中的柱子。
      const leftPct = ((index + 0.5) / n) * 100;
      const side = index + 0.5 < n / 2 ? 'right' : 'left';

      this.setData({
        tooltip: {
          visible: true,
          index,
          leftPct,
          side,
          label: item.label || '',
          _fmtIncome: item._fmtIncome,
          _fmtExpense: item._fmtExpense,
        },
      });
    },

    /** 点空白处收起浮层 */
    onPlotTap() {
      if (this.data.tooltip.visible) {
        this.setData({ 'tooltip.visible': false });
      }
    },

    /** 浮层上的「查看分类」：把选中项抛给页面 */
    onDetail() {
      const index = this.data.tooltip.index;
      const item = this.data.list[index];
      if (!item) return;
      this.triggerEvent('itemtap', { item, index });
    },

    /** 浮层内部点击不冒泡到 onPlotTap */
    noop() {},

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
