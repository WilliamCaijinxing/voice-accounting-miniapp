// utils/util.js — 通用工具函数
// getApp() 懒加载，避免模块顶层调用时 App 尚未初始化
let _app = null;
const getAppInstance = () => {
  if (!_app) _app = getApp();
  return _app;
};

/**
 * 格式化金额显示
 * @param {number} amount 金额（分）
 * @returns {string} 格式化后的金额字符串
 */
const formatAmount = (amount) => {
  if (amount === undefined || amount === null || Number.isNaN(amount)) return '0';
  const yuan = (Number(amount) / 100).toFixed(2);
  return yuan.replace(/\.00$/, '');
};

/**
 * 格式化日期
 * @param {Date|string|number} date 日期
 * @param {string} format 格式 ('YYYY-MM-DD' | 'MM-DD' | 'MM月DD日')
 * @returns {string}
 */
const formatDate = (date, format = 'YYYY-MM-DD') => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  const map = {
    'YYYY': year,
    'MM': month,
    'DD': day,
    'M': d.getMonth() + 1,
    'D': d.getDate(),
  };

  return format.replace(/YYYY|MM|DD|M|D/g, (match) => map[match]);
};

/**
 * 获取今天的日期字符串 YYYY-MM-DD
 */
const getToday = () => formatDate(new Date());

/**
 * 获取本月第一天
 */
const getMonthStart = () => {
  const d = new Date();
  d.setDate(1);
  return formatDate(d);
};

/**
 * 获取本月最后一天
 */
const getMonthEnd = () => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  return formatDate(d);
};

/**
 * 根据分类ID获取分类信息
 */
const getCategoryById = (categoryId, type = 'expense') => {
  const app = getAppInstance();
  const categories = app && app.globalData ? (app.globalData.categoryConfig[type] || []) : [];
  return categories.find((c) => c.id === categoryId) || null;
};

/**
 * 获取分类emoji图标
 */
const getCategoryIcon = (categoryId) => {
  const iconMap = {
    food: '🍜', transport: '🚗', shopping: '🛍️', housing: '🏠',
    entertainment: '🎮', medical: '💊', education: '📚', social: '🎁', other: '📌',
    salary: '💰', freelance: '💼', investment: '📈', refund: '↩️', other_income: '💵',
  };
  return iconMap[categoryId] || '📌';
};

/**
 * 防抖
 */
const debounce = (fn, delay = 300) => {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
};

/**
 * 节流
 */
const throttle = (fn, delay = 300) => {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= delay) {
      last = now;
      fn.apply(this, args);
    }
  };
};

module.exports = {
  formatAmount,
  formatDate,
  getToday,
  getMonthStart,
  getMonthEnd,
  getCategoryById,
  getCategoryIcon,
  debounce,
  throttle,
};
