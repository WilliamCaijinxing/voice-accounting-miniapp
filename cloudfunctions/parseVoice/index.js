// cloudfunctions/parseVoice/index.js
// 语音文本 NLP 解析 → 提取金额、分类、描述、日期
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ============ 分类关键词库 ============
const CATEGORY_RULES = [
  // 支出分类
  { id: 'food', name: '餐饮', type: 'expense',
    keywords: ['吃饭', '外卖', '午餐', '晚餐', '早餐', '午饭', '晚饭', '聚餐', '奶茶',
               '咖啡', '小吃', '烧烤', '火锅', '面', '饭', '菜', '饼', '包子', '饺子',
               '麻辣烫', 'KFC', '麦当劳', '肯德基', '星巴克', '零食', '水果'] },
  { id: 'transport', name: '交通', type: 'expense',
    keywords: ['打车', '地铁', '公交', '加油', '停车', '高铁', '飞机', '火车', '滴滴',
               '出租车', '骑行', '共享单车', '摩拜', '哈啰', '油费', '过路费', '机票'] },
  { id: 'shopping', name: '购物', type: 'expense',
    keywords: ['衣服', '鞋子', '超市', '网购', '淘宝', '京东', '日用品', '化妆品', '数码',
               '手机', '电脑', '耳机', '包包', '买', '购物', '消费'] },
  { id: 'housing', name: '居家', type: 'expense',
    keywords: ['房租', '房贷', '水电', '物业', '维修', '装修', '煤气', '宽带', '话费',
               '电费', '水费', '燃气', '暖气', '网费'] },
  { id: 'entertainment', name: '娱乐', type: 'expense',
    keywords: ['电影', 'KTV', '游戏', '旅游', '景点', '门票', '演出', '剧本杀',
               '按摩', '洗脚', '唱歌', '网吧', '游乐园', '迪士尼'] },
  { id: 'medical', name: '医疗', type: 'expense',
    keywords: ['看病', '药', '医院', '体检', '挂号', '门诊', '牙科', '中药', '西药'] },
  { id: 'education', name: '教育', type: 'expense',
    keywords: ['学费', '培训', '书本', '课程', '考试', '考证', '学习', '教材'] },
  { id: 'social', name: '人情', type: 'expense',
    keywords: ['红包', '结婚', '生日', '礼物', '随礼', '请客', '礼金', '份子钱'] },

  // 收入分类
  { id: 'salary', name: '工资', type: 'income',
    keywords: ['工资', '薪水', '奖金', '年终奖', '绩效', '发工资', '收入'] },
  { id: 'freelance', name: '兼职', type: 'income',
    keywords: ['兼职', '外快', '私活', '副业', '接单'] },
  { id: 'investment', name: '理财', type: 'income',
    keywords: ['利息', '股票', '基金', '分红', '理财', '收益', '赚了'] },
  { id: 'refund', name: '退款', type: 'income',
    keywords: ['退款', '报销', '返现', '退回'] },
];

// ============ 金额提取正则 ============
// 支持"万""千"单位：1万 → 10000, 1.5万 → 15000, 1万5 → 15000
const AMOUNT_PATTERNS = [
  // "X万" / "X.X万" / "X万X" / "X.XX万" — 必须带"万"字才算大额
  /(\d+(?:\.\d{1,2})?)\s*万\s*(\d+)?/,           // 1万, 1.5万, 1万5
  // "X千" / "X.X千"
  /(\d+(?:\.\d{1,2})?)\s*千\s*(\d+)?/,           // 3千, 2.5千, 3千5
  // 常规：X元 / X块 / X块钱 / 花了X
  /(\d+(?:\.\d{1,2})?)\s*[元块]/,                  // 25元, 12.5块
  /(\d+(?:\.\d{1,2})?)\s*(块钱|元钱)/,             // 25块钱
  /[花用消费了]\s*(\d+(?:\.\d{1,2})?)/,            // 花了25, 用了12.5
  /(-?\d+(?:\.\d{1,2})?)/,                          // 兜底：任意数字
];

// ============ 日期关键词处理 ============
const DATE_KEYWORDS = {
  '今天': 0, '今儿': 0, '今日': 0,
  '昨天': -1, '昨儿': -1, '昨日': -1,
  '前天': -2,
  '大前天': -3,
};

/**
 * 解析文本中的日期
 */
function parseDate(text) {
  // 先检查相对日期关键词
  for (const [keyword, offset] of Object.entries(DATE_KEYWORDS)) {
    if (text.includes(keyword)) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return formatDateStr(d);
    }
  }

  // 检查具体日期格式：MM月DD日 / MM-DD / MM/DD
  const dateMatch = text.match(/(\d{1,2})[月\-\/](\d{1,2})[日号]?/);
  if (dateMatch) {
    const month = parseInt(dateMatch[1]);
    const day = parseInt(dateMatch[2]);
    const year = new Date().getFullYear();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // 默认今天
  return formatDateStr(new Date());
}

function formatDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 中文数字字符转数值
 */
function chineseDigit(ch) {
  const map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  return map[ch] !== undefined ? map[ch] : null;
}

/**
 * 口语简写中文金额 → 数字
 * "一万五" → 15000, "三千五" → 3500, "一百二" → 120, "十五" → 15
 * 返回 null 表示无法解析
 */
function parseShortChineseAmount(text) {
  // 匹配 "X万X" / "X千X" / "X百X" / "X十X"
  const wan = text.match(/^([一二两三四五六七八九])万([一二两三四五六七八九])?$/);
  if (wan) {
    const base = chineseDigit(wan[1]) * 10000;
    const tail = wan[2] ? chineseDigit(wan[2]) * 1000 : 0; // "一万五"尾数5 = 五千
    return base + tail;
  }

  const qian = text.match(/^([一二两三四五六七八九])千([一二两三四五六七八九])?$/);
  if (qian) {
    const base = chineseDigit(qian[1]) * 1000;
    const tail = qian[2] ? chineseDigit(qian[2]) * 100 : 0; // "三千五"尾数5 = 五百
    return base + tail;
  }

  const bai = text.match(/^([一二两三四五六七八九])百([一二两三四五六七八九])?$/);
  if (bai) {
    const base = chineseDigit(bai[1]) * 100;
    const tail = bai[2] ? chineseDigit(bai[2]) * 10 : 0; // "一百二"尾数2 = 二十
    return base + tail;
  }

  const shi = text.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (shi) {
    const base = (shi[1] ? chineseDigit(shi[1]) : 1) * 10;
    const tail = shi[2] ? chineseDigit(shi[2]) : 0;
    return base + tail;
  }

  return null;
}

/**
 * 严格中文数字 → 数字（处理"一万五千""三千五百"等完整写法）
 */
function chineseNumToNumber(chineseStr) {
  let result = 0;
  let temp = 0;    // 当前段累积（万以下）
  let num = 0;     // 当前数字

  for (const ch of chineseStr) {
    const digit = chineseDigit(ch);
    if (digit !== null) {
      num = digit;
    } else if (ch === '十' || ch === '百' || ch === '千' || ch === '万') {
      const unit = { '十': 10, '百': 100, '千': 1000, '万': 10000 }[ch];
      if (num === 0) num = 1; // "十五"的"十"、"十万"的"十"
      if (ch === '万') {
        result = (result + temp + num) * unit;  // 万段结算
        temp = 0;
        num = 0;
      } else {
        temp += num * unit;
        num = 0;
      }
    }
  }
  result += temp + num;
  return result;
}

/**
 * 提取中文数字金额（"一万"、"一万五"、"三千五"、"一百二十"）
 * 返回 null 表示没匹配到
 */
function parseChineseAmount(text) {
  // 匹配中文数字+单位组合（含元/块后缀）
  const match = text.match(/([零一二两三四五六七八九十百千万]+)\s*[元块钱]?/);
  if (!match) return null;

  const chinesePart = match[1];
  // 至少包含一个单位（十/百/千/万），避免误匹配"三个""五天"等
  if (!/[十百千万]/.test(chinesePart)) return null;

  // 先试口语简写（"一万五"、"三千五"）
  const short = parseShortChineseAmount(chinesePart);
  if (short !== null && short > 0) return short;

  // 再试严格写法（"一万五千"）
  const full = chineseNumToNumber(chinesePart);
  if (full > 0) return full;

  return null;
}

/**
 * 中文数字 + 货币单位（不含"十百千万"）→ 数字
 * "两块" → 2, "五元" → 5, "三块钱" → 3, "两块五" → 2.5, "两毛" → 0.2
 * 返回 null 表示未匹配
 * 注意：必须先于本函数调用 parseChineseAmount（处理"两百""两千"等带单位的大额）
 */
function parseChineseCurrency(text) {
  // 元 / 块：两块、五元、三块钱、两块五
  const yuanMatch = text.match(/([零一二两三四五六七八九十]+)\s*(?:块钱|元钱|块|元)/);
  if (yuanMatch) {
    const intPart = chineseNumToNumber(yuanMatch[1]);
    if (intPart > 0) {
      // 角： "两块五" → 0.5 元
      const tail = text.match(/(?:块钱|元钱|块|元)\s*([零一二两三四五六七八九])(?![十百千万])/);
      const cents = tail ? chineseDigit(tail[1]) * 10 : 0;
      return intPart + cents / 100;
    }
  }

  // 毛 / 角：两毛、五角
  const jiaoMatch = text.match(/([零一二两三四五六七八九十]+)\s*(?:毛钱|角钱|毛|角)/);
  if (jiaoMatch) {
    const intPart = chineseNumToNumber(jiaoMatch[1]);
    if (intPart > 0) return intPart / 10;
  }

  return null;
}

/**
 * 解析文本中的金额
 * 支持"万""千"单位：1万 → 10000, 1.5万 → 15000, 1万5 → 15000, 3千 → 3000
 * 支持中文数字：一万 → 10000, 一万五 → 15000, 三千五 → 3500
 */
function parseAmount(text) {
  // 判断是收入还是支出
  const isIncome = /[收入赚得盈利到账收到进账挣].*?\d|^\d+.*?[收入赚得]|\d+.*?[到账进账]/.test(text)
    || /[收入赚得盈利到账收到进账挣].*?[一二两三四五六七八九十百千万]|^[一二两三四五六七八九十百千万]+.*?[收入赚得]/.test(text);

  // ---- 优先匹配中文数字大额（如"一万""三千五"）----
  const chineseAmt = parseChineseAmount(text);
  if (chineseAmt !== null) {
    if (chineseAmt > 0 && chineseAmt < 100000000) {
      return {
        amount: Math.round(chineseAmt * 100),
        type: isIncome ? 'income' : 'expense',
      };
    }
  }

  // ---- 中文数字 + 货币单位（"两块""五元""三块钱"）----
  const cnCurrency = parseChineseCurrency(text);
  if (cnCurrency !== null) {
    if (cnCurrency > 0 && cnCurrency < 1000000) {
      return {
        amount: Math.round(cnCurrency * 100),
        type: isIncome ? 'income' : 'expense',
      };
    }
  }

  // ---- 优先匹配"万"单位 ----
  const wanMatch = text.match(/(\d+(?:\.\d{1,2})?)\s*万\s*(\d+)?/);
  if (wanMatch) {
    let amount = parseFloat(wanMatch[1]);
    // "1万5" → 1 * 10000 + 5 * 1000 = 15000
    if (wanMatch[2]) {
      const tail = parseInt(wanMatch[2]);
      // "1万5" 中的 5 是 5000（五千），"1万50" 中的 50 是 5000
      if (tail < 10) {
        amount = amount * 10000 + tail * 1000;
      } else if (tail < 100) {
        amount = amount * 10000 + tail * 100;
      } else {
        amount = amount * 10000 + tail;
      }
    } else {
      amount = amount * 10000;
    }
    if (amount > 0 && amount < 100000000) {
      return {
        amount: Math.round(amount * 100),
        type: isIncome ? 'income' : 'expense',
      };
    }
  }

  // ---- 匹配"千"单位 ----
  const qianMatch = text.match(/(\d+(?:\.\d{1,2})?)\s*千\s*(\d+)?/);
  if (qianMatch) {
    let amount = parseFloat(qianMatch[1]);
    if (qianMatch[2]) {
      const tail = parseInt(qianMatch[2]);
      if (tail < 10) {
        amount = amount * 1000 + tail * 100;
      } else {
        amount = amount * 1000 + tail;
      }
    } else {
      amount = amount * 1000;
    }
    if (amount > 0 && amount < 100000000) {
      return {
        amount: Math.round(amount * 100),
        type: isIncome ? 'income' : 'expense',
      };
    }
  }

  // ---- 常规金额匹配 ----
  const patterns = [
    /(\d+(?:\.\d{1,2})?)\s*[元块]/,
    /(\d+(?:\.\d{1,2})?)\s*(块钱|元钱)/,
    /[花用消费了]\s*(\d+(?:\.\d{1,2})?)/,
    /(-?\d+(?:\.\d{1,2})?)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseFloat(match[1]);
      if (amount > 0 && amount < 1000000) {
        return {
          amount: Math.round(amount * 100), // 存储为分
          type: isIncome ? 'income' : 'expense',
        };
      }
    }
  }

  return null;
}

/**
 * 解析分类
 */
function parseCategory(text, type) {
  // 按匹配关键词数量排序，取匹配最多的分类
  const scores = CATEGORY_RULES
    .filter((rule) => rule.type === type)
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      score: rule.keywords.filter((kw) => text.includes(kw)).length,
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  return scores.length > 0 ? scores[0] : { id: type === 'income' ? 'other_income' : 'other', name: type === 'income' ? '其他收入' : '其他' };
}

/**
 * 去掉文本中的标点符号（保留数字中的小数点，如 12.5）
 * 用于描述字段：ASR 或手动输入可能带句末句号，记账描述不需要标点
 */
function stripPunctuation(text) {
  return String(text == null ? '' : text)
    // 先把数字小数点占位保护，避免被当作标点删除
    .replace(/(\d)\.(\d)/g, '$1<DOT>$2')
    // 移除中英文标点
    .replace(/[，。！？、；：""''（）《》〈〉【】〔〕\[\]{}~～—\-_…·｜|!?,.:;"'()]/g, '')
    // 还原小数点
    .replace(/<DOT>/g, '.')
    // 合并多余空白
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 提取描述（去掉金额、分类词等噪音）
 */
function parseDescription(text, amount, category) {
  let desc = text
    .replace(/[花钱用消费了支出]\s*\d+(?:\.\d{1,2})?\s*[元块]?/g, '')
    .replace(/\d+(?:\.\d{1,2})?\s*[元块钱]/g, '')
    .replace(/今天|昨天|前天|今儿|昨儿/g, '')
    .replace(/花了|用了|消费|支出|收入|赚了/g, '')
    .trim();

  // 去掉标点符号（如 ASR 返回的句末句号）
  desc = stripPunctuation(desc);

  // 如果什么也不剩，用分类名 + 金额作为描述
  if (!desc || desc.length < 2) {
    desc = `${category.name} ${(amount / 100).toFixed(2)}元`;
  }

  return desc.substring(0, 100); // 限制长度
}

// ============ 主入口 ============
exports.main = async (event) => {
  const { action, text } = event;

  if (action !== 'parse') {
    return { code: -1, message: 'Unknown action' };
  }

  if (!text || text.trim().length === 0) {
    return { code: -1, message: '语音内容为空' };
  }

  try {
    // Step 1: 提取金额和类型
    const amountResult = parseAmount(text);
    if (!amountResult) {
      return {
        code: 0,
        data: {
          success: false,
          reason: '未能识别金额，请重新说出消费金额',
          rawText: text,
        },
      };
    }

    // Step 2: 解析分类
    const category = parseCategory(text, amountResult.type);

    // Step 3: 解析日期
    const date = parseDate(text);

    // Step 4: 提取描述
    const description = parseDescription(text, amountResult.amount, category);

    return {
      code: 0,
      data: {
        success: true,
        rawText: text,
        parsed: {
          amount: amountResult.amount,
          type: amountResult.type,
          categoryId: category.id,
          categoryName: category.name,
          date,
          description,
        },
        confidence: category.score > 1 ? 'high' : category.score > 0 ? 'medium' : 'low',
      },
    };
  } catch (err) {
    console.error('Parse voice error:', err);
    return { code: -1, message: '解析失败：' + err.message };
  }
};
