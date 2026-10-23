// components/category-pie/category-pie.js — 分类饼图（支出 / 收入可切换）
//
// 统计页日 / 月 / 年三个视图共用。数据（颜色 _color、金额 _fmtAmount、百分比、
// conic-gradient）一律由调用方在 JS 侧算好传进来 —— WXML 不支持调用方法，
// 计算必须提前完成，否则静默渲染为空。
//
// 收支切换是「受控」的：组件自己不存状态，展示哪一侧由调用方的 type 属性决定，
// 点切换器只抛 change 事件。理由是这个切换器要画在两处 —— 卡片模式画在卡片头里，
// 弹窗模式画在弹窗标题栏右上角（外壳由调用方提供）。组件内部再存一份状态必然漂移。
Component({
  properties: {
    // 支出侧数据：{ list: [], total: '0', gradient: '' }
    expense: { type: Object, value: { list: [], total: '0', gradient: '' } },
    // 收入侧数据，结构与 expense 相同
    income: { type: Object, value: { list: [], total: '0', gradient: '' } },
    // 当前展示哪一侧：'expense' | 'income'
    type: { type: String, value: 'expense' },
    // 卡片标题（仅卡片模式使用），如「本月分类」
    label: { type: String, value: '分类' },
    // 是否渲染自带的收支切换器。弹窗模式由调用方画在标题栏里，传 false
    showTabs: { type: Boolean, value: true },
    // 无卡片外壳：供底部弹窗内嵌使用（弹窗本身已经是白底面板）
    plain: { type: Boolean, value: false },
    // 标题前的图标，跟着视图变化（今日 / 本月 / 本年）
    icon: { type: String, value: '🍩' },
  },

  data: {
    tabs: [
      { key: 'expense', label: '支出' },
      { key: 'income', label: '收入' },
    ],
    // 由 refresh 计算出的当前展示侧
    view: {
      list: [],
      total: '0',
      gradient: '',
      empty: true,
      totalLabel: '总支出',
      isIncome: false,
    },
  },

  observers: {
    'expense, income, type': function () {
      this.refresh();
    },
  },

  lifetimes: {
    attached() {
      this.refresh();
    },
  },

  methods: {
    /**
     * 把当前侧的数据摊平成渲染用的 view。
     * 「空」的判断必须在 JS 侧做：WXML 既不能调用方法，也不能对未定义属性做可靠判断。
     */
    refresh() {
      const isIncome = this.data.type === 'income';
      const src = (isIncome ? this.properties.income : this.properties.expense) || {};
      const list = Array.isArray(src.list) ? src.list : [];
      this.setData({
        view: {
          list,
          total: src.total || '0',
          gradient: src.gradient || '',
          empty: list.length === 0,
          totalLabel: isIncome ? '总收入' : '总支出',
          emptyText: isIncome ? '该时间段还没有收入记录' : '该时间段还没有支出记录',
          isIncome,
        },
      });
    },

    /** 点切换器：只抛事件，状态归调用方管（受控组件） */
    onSwitch(e) {
      const next = e.currentTarget.dataset.type;
      if (!next || next === this.data.type) return;
      this.triggerEvent('change', { type: next });
    },
  },
});
