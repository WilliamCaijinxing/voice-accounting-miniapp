// components/category-pie/category-pie.js — 支出分类饼图卡片
//
// 统计页日/月/年三个视图都用它，之前这段 WXML 被复制了 4 遍。
// 数据（颜色 _color、金额 _fmtAmount、百分比）一律由调用方在 JS 侧算好传进来，
// 组件本身只做渲染——WXML 不支持调用方法，计算必须提前完成。

Component({
  properties: {
    // [{ categoryId, categoryName, amount, percentage, _fmtAmount, _color }]
    list: { type: Array, value: [] },
    // 中心显示的总支出（已格式化）
    total: { type: String, value: '0' },
    // 卡片标题，如「本月支出分类」
    label: { type: String, value: '支出分类' },
    // conic-gradient 字符串，由调用方生成
    gradient: { type: String, value: '' },
  },

  data: {
    empty: true,
  },

  observers: {
    'list': function (list) {
      this.setData({ empty: !list || list.length === 0 });
    },
  },
});
