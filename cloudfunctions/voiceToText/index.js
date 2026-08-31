// cloudfunctions/voiceToText/index.js
// 语音识别一体化云函数：腾讯云 ASR 转文字 + NLP 解析 → 结构化账目
// 优化：前端直传 base64（省掉云存储上传/下载两轮网络往返），一次云函数调用完成识别+解析
// 入参：{ action:'recognize', audioBase64, voiceFormat }  ← 推荐
//       { fileID }                                      ← 旧路径兼容（云存储中转）
// 返回：{ code:0, text, parsed, confidence } 或 { code:0, text, parseFailed, reason }
//       { code:0, text:'', asr_empty, message } / { code:0, fallback, message } / { code:-1, message }
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ==================== MOCK 模式 ====================
// 如果不想配置腾讯云 ASR，可以开启 MOCK 模式来测试完整流程
const MOCK_MODE = false;  // 改为 true 会返回模拟文字用于测试

const MOCK_TEXTS = [
  '午餐花了35块',
  '打车去公司25元',
  '超市购物花了128块5',
  '晚饭吃了48',
  '买咖啡15元',
  '工资到账15000',
  '地铁通勤花了6块',
];

// ==================== 腾讯云 ASR ====================

let AsrClient;
try {
  const tencentcloud = require('tencentcloud-sdk-nodejs');
  AsrClient = tencentcloud.asr.v20190614.Client;
} catch (e) {
  console.warn('[voiceToText] tencentcloud-sdk-nodejs 未安装，请在云函数目录执行 npm install');
}

/**
 * 获取环境变量中的腾讯云密钥
 */
const getCredentials = () => {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) {
    return null;
  }
  return { secretId, secretKey };
};

/**
 * 调用腾讯云 ASR 一句话识别
 */
const recognizeWithTencentASR = async (base64Data, dataLen) => {
  const creds = getCredentials();
  if (!creds) {
    throw new Error('TENCENT_SECRET_ID/TENCENT_SECRET_KEY_NOT_CONFIGURED');
  }

  const clientConfig = {
    credential: {
      secretId: creds.secretId,
      secretKey: creds.secretKey,
    },
    region: 'ap-guangzhou',
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        endpoint: 'asr.tencentcloudapi.com',
        reqTimeout: 8,   // 一句话识别通常 1~3s 返回，8s 足够且能快速失败重试
      },
    },
  };

  const client = new AsrClient(clientConfig);

  const params = {
    EngSerViceType: '16k_zh',
    SourceType: 1,
    VoiceFormat: 'mp3',
    Data: base64Data,
    DataLen: dataLen,
    // 关闭非必要的服务端后处理，缩短识别耗时
    FilterDirty: 0,     // 不过滤脏词
    FilterModal: 0,     // 不过滤语气词
    FilterPunc: 1,      // 过滤句末标点（描述不需要句号；注意 0=不过滤即保留，1=过滤）
    // 智能数字转换：口语中文数字 → 阿拉伯数字（"两块"→"2块"），利于金额解析
    ConvertNumMode: 1,
  };

  const result = await client.SentenceRecognition(params);
  return result;
};

// ==================== 降级方案 ====================

/**
 * ASR 未配置时的降级提示
 */
const buildFallbackResponse = (reason) => {
  return {
    code: 0,
    text: '',
    fallback: true,
    fallback_reason: reason,
    message: '语音识别服务未配置，请使用「手动输入」功能。\n\n如需启用语音识别：在云函数 voiceToText 的环境变量中配置 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY（腾讯云 ASR 每月免费 10,000 次）',
    help_url: 'https://console.cloud.tencent.com/cam/capi',
  };
};

// ==================== NLP 解析（内嵌 parseVoice 逻辑） ====================
// 与 parseVoice 云函数保持一致；一次调用同时完成「识别 + 结构化」，省一次云函数调用

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

const DATE_KEYWORDS = {
  '今天': 0, '今儿': 0, '今日': 0,
  '昨天': -1, '昨儿': -1, '昨日': -1,
  '前天': -2,
  '大前天': -3,
};

function chineseDigit(ch) {
  const map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  return map[ch] !== undefined ? map[ch] : null;
}

function parseShortChineseAmount(text) {
  const wan = text.match(/^([一二两三四五六七八九])万([一二两三四五六七八九])?$/);
  if (wan) {
    const base = chineseDigit(wan[1]) * 10000;
    const tail = wan[2] ? chineseDigit(wan[2]) * 1000 : 0;
    return base + tail;
  }
  const qian = text.match(/^([一二两三四五六七八九])千([一二两三四五六七八九])?$/);
  if (qian) {
    const base = chineseDigit(qian[1]) * 1000;
    const tail = qian[2] ? chineseDigit(qian[2]) * 100 : 0;
    return base + tail;
  }
  const bai = text.match(/^([一二两三四五六七八九])百([一二两三四五六七八九])?$/);
  if (bai) {
    const base = chineseDigit(bai[1]) * 100;
    const tail = bai[2] ? chineseDigit(bai[2]) * 10 : 0;
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

function chineseNumToNumber(chineseStr) {
  let result = 0;
  let temp = 0;
  let num = 0;
  for (const ch of chineseStr) {
    const digit = chineseDigit(ch);
    if (digit !== null) {
      num = digit;
    } else if (ch === '十' || ch === '百' || ch === '千' || ch === '万') {
      const unit = { '十': 10, '百': 100, '千': 1000, '万': 10000 }[ch];
      if (num === 0) num = 1;
      if (ch === '万') {
        result = (result + temp + num) * unit;
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

function parseChineseAmount(text) {
  const match = text.match(/([零一二两三四五六七八九十百千万]+)\s*[元块钱]?/);
  if (!match) return null;
  const chinesePart = match[1];
  if (!/[十百千万]/.test(chinesePart)) return null;
  const short = parseShortChineseAmount(chinesePart);
  if (short !== null && short > 0) return short;
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

function parseAmount(text) {
  // 判断是收入还是支出
  const isIncome = /[收入赚得盈利到账收到进账挣].*?\d|^\d+.*?[收入赚得]|\d+.*?[到账进账]/.test(text)
    || /[收入赚得盈利到账收到进账挣].*?[一二两三四五六七八九十百千万]|^[一二两三四五六七八九十百千万]+.*?[收入赚得]/.test(text);

  // ---- 优先匹配中文数字大额（如"一万""三千五"）----
  const chineseAmt = parseChineseAmount(text);
  if (chineseAmt !== null) {
    if (chineseAmt > 0 && chineseAmt < 100000000) {
      return { amount: Math.round(chineseAmt * 100), type: isIncome ? 'income' : 'expense' };
    }
  }

  // ---- 中文数字 + 货币单位（"两块""五元""三块钱"）----
  const cnCurrency = parseChineseCurrency(text);
  if (cnCurrency !== null) {
    if (cnCurrency > 0 && cnCurrency < 1000000) {
      return { amount: Math.round(cnCurrency * 100), type: isIncome ? 'income' : 'expense' };
    }
  }

  // ---- "万"单位 ----
  const wanMatch = text.match(/(\d+(?:\.\d{1,2})?)\s*万\s*(\d+)?/);
  if (wanMatch) {
    let amount = parseFloat(wanMatch[1]);
    if (wanMatch[2]) {
      const tail = parseInt(wanMatch[2]);
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
      return { amount: Math.round(amount * 100), type: isIncome ? 'income' : 'expense' };
    }
  }

  // ---- "千"单位 ----
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
      return { amount: Math.round(amount * 100), type: isIncome ? 'income' : 'expense' };
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
        return { amount: Math.round(amount * 100), type: isIncome ? 'income' : 'expense' };
      }
    }
  }

  return null;
}

function parseCategory(text, type) {
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

function parseDate(text) {
  for (const [keyword, offset] of Object.entries(DATE_KEYWORDS)) {
    if (text.includes(keyword)) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return formatDateStr(d);
    }
  }
  const dateMatch = text.match(/(\d{1,2})[月\-\/](\d{1,2})[日号]?/);
  if (dateMatch) {
    const month = parseInt(dateMatch[1]);
    const day = parseInt(dateMatch[2]);
    const year = new Date().getFullYear();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return formatDateStr(new Date());
}

function formatDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

function parseDescription(text, amount, category) {
  let desc = text
    .replace(/[花钱用消费了支出]\s*\d+(?:\.\d{1,2})?\s*[元块]?/g, '')
    .replace(/\d+(?:\.\d{1,2})?\s*[元块钱]/g, '')
    .replace(/今天|昨天|前天|今儿|昨儿/g, '')
    .replace(/花了|用了|消费|支出|收入|赚了/g, '')
    .trim();

  // 去掉标点符号（如 ASR 返回的句末句号）
  desc = stripPunctuation(desc);

  if (!desc || desc.length < 2) {
    desc = `${category.name} ${(amount / 100).toFixed(2)}元`;
  }
  return desc.substring(0, 100);
}

/**
 * 语音文本 → 结构化账目
 * @returns {Object} { success, parsed?, confidence?, reason? }
 */
function parseVoiceText(text) {
  const amountResult = parseAmount(text);
  if (!amountResult) {
    return { success: false, reason: '未能识别金额，请重新说出消费金额' };
  }
  const category = parseCategory(text, amountResult.type);
  const date = parseDate(text);
  const description = parseDescription(text, amountResult.amount, category);
  return {
    success: true,
    parsed: {
      amount: amountResult.amount,
      type: amountResult.type,
      categoryId: category.id,
      categoryName: category.name,
      date,
      description,
    },
    confidence: category.score > 1 ? 'high' : category.score > 0 ? 'medium' : 'low',
  };
}

// ==================== 主函数 ====================

exports.main = async (event) => {
  // ---- 预热调用：仅拉起云函数实例（含 SDK 加载），不执行识别 ----
  // 前端在「进入记账页」和「开始录音」时提前调用，消除后续识别的冷启动耗时（可省 300~800ms）
  if (event && event.warmup) {
    return { code: 0, warm: true, ts: Date.now() };
  }

  const { audioBase64, voiceFormat, fileID } = event;

  if (!audioBase64 && !fileID) {
    return { code: -1, message: '缺少 audioBase64 或 fileID 参数' };
  }

  // ---- Mock 模式（测试用）----
  if (MOCK_MODE) {
    const mockText = MOCK_TEXTS[Math.floor(Math.random() * MOCK_TEXTS.length)];
    const parseResult = parseVoiceText(mockText);
    console.log('[voiceToText] MOCK mode, returning:', mockText);
    return { code: 0, text: mockText, mock: true, parsed: parseResult.parsed, confidence: parseResult.confidence };
  }

  try {
    // 1. 获取音频数据（新方式：base64 直传；旧方式：云存储下载，兼容保留）
    let base64Data;
    let dataLen;

    if (audioBase64) {
      base64Data = audioBase64;
      dataLen = Math.floor(Buffer.from(audioBase64, 'base64').length);
      console.log('[voiceToText] 收到 base64 直传音频, size:', dataLen, 'bytes');
    } else {
      console.log('[voiceToText] Downloading:', fileID);
      const downloadRes = await cloud.downloadFile({ fileID });
      const buffer = downloadRes.fileContent;
      if (!buffer || buffer.length === 0) {
        return { code: -1, message: '下载音频文件失败，文件为空' };
      }
      base64Data = buffer.toString('base64');
      dataLen = buffer.length;
      console.log('[voiceToText] Downloaded audio, size:', dataLen, 'bytes');

      // 清理云存储临时文件（异步不阻塞）
      cloud.deleteFile({ fileList: [fileID] }).catch((e) => {
        console.log('[voiceToText] 清理临时文件失败:', e.message);
      });
    }

    if (dataLen < 1000) {
      return { code: -1, message: '音频文件过小，可能未录制到有效内容' };
    }

    // 2. 检查 SDK 与密钥
    if (!AsrClient) {
      console.log('[voiceToText] tencentcloud-sdk-nodejs 未安装');
      return buildFallbackResponse('SDK_NOT_INSTALLED');
    }
    const creds = getCredentials();
    if (!creds) {
      console.log('[voiceToText] 腾讯云密钥未配置');
      return buildFallbackResponse('CREDENTIALS_NOT_CONFIGURED');
    }

    // 3. 调用腾讯云 ASR
    console.log('[voiceToText] 开始调用腾讯云 ASR...');
    const asrStart = Date.now();
    const asrResult = await recognizeWithTencentASR(base64Data, dataLen);
    console.log('[voiceToText] ASR 耗时:', Date.now() - asrStart, 'ms, dataLen:', dataLen);
    console.log('[voiceToText] ASR 返回:', JSON.stringify(asrResult).substring(0, 300));

    // 4. 提取识别文本
    const text = (asrResult.Result || asrResult.result || '').trim();

    if (!text) {
      return {
        code: 0,
        text: '',
        asr_empty: true,
        message: '语音识别未检测到有效文字，请重新录制并确保周围环境安静',
      };
    }

    // 5. 内嵌 NLP 解析（与 parseVoice 同一套逻辑）
    const parseResult = parseVoiceText(text);

    if (!parseResult.success) {
      return { code: 0, text, parseFailed: true, reason: parseResult.reason };
    }

    return {
      code: 0,
      text,
      parsed: parseResult.parsed,
      confidence: parseResult.confidence,
    };
  } catch (err) {
    console.error('[voiceToText] Error:', err.message);
    console.error('[voiceToText] Stack:', err.stack);

    if (err.message && err.message.includes('NOT_CONFIGURED')) {
      return buildFallbackResponse('CREDENTIALS_NOT_CONFIGURED');
    }
    if (err.message && err.message.includes('AuthFailure')) {
      return {
        code: -1,
        message: '腾讯云密钥验证失败，请检查 SecretId 和 SecretKey 是否正确',
        error: 'AuthFailure',
      };
    }
    if (err.message && err.message.includes('RequestLimitExceeded')) {
      return {
        code: -1,
        message: '语音识别请求频率过高，请稍后重试',
        error: 'RateLimit',
      };
    }
    return {
      code: -1,
      message: '语音识别失败：' + (err.message || '未知错误'),
      error: err.message,
    };
  }
};
