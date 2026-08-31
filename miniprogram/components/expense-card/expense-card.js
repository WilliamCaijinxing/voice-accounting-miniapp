// components/expense-card/expense-card.js
const { formatAmount, formatDate, getToday, getCategoryIcon } = require('../../utils/util');

Component({
  properties: {
    item: {
      type: Object,
      value: {},
      observer: function (newVal) {
        if (newVal) {
          this.setData({
            icon: getCategoryIcon(newVal.categoryId),
            formattedAmount: formatAmount(newVal.amount),
            sign: newVal.type === 'income' ? '+' : '-',
            formattedDate: this.formatDateStr(newVal.date),
          });
        }
      },
    },
  },

  data: {
    icon: '📌',
    formattedAmount: '0',
    sign: '-',
    formattedDate: '',
  },

  methods: {
    onTap() {
      this.triggerEvent('tap', { item: this.properties.item });
    },

    formatDateStr(dateStr) {
      if (!dateStr) return '';
      // 显示 今天/昨天/前天/MM-DD
      const today = getToday();
      if (dateStr === today) return '今天';

      const d = new Date();
      d.setDate(d.getDate() - 1);
      if (dateStr === formatDate(d)) return '昨天';

      d.setDate(d.getDate() - 1);
      if (dateStr === formatDate(d)) return '前天';

      return formatDate(dateStr, 'MM-DD');
    },
  },
});
