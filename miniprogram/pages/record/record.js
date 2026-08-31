// pages/record/record.js — 语音记账核心页面
const { formatAmount, formatDate, getToday, getCategoryIcon } = require('../../utils/util');
const { voiceAPI, expenseAPI, ledgerAPI } = require('../../utils/cloud');
const app = getApp();

Page({
  data: {
    // 阶段：idle | recording | parsing | confirm
    phase: 'idle',

    // 录音
    recorderManager: null,
    recordingTime: 0,
    recordTimer: null,

    // 语音识别结果
    rawText: '',

    // 解析结果
    parsed: null,
    confidence: '',

    // 可选分类列表
    categories: [],

    // 日期选择器
    selectedDate: getToday(),    // 用户选定的录入日期
    selectedDateLabel: '',      // 显示用的日期标签
    todayStr: getToday(),

    // 账本
    ledgers: [{ id: '', name: '我的账本', type: 'personal' }],
    currentLedgerName: '我的账本',
  },

  onLoad() {
    // 初始化录音管理器
    const recorder = wx.getRecorderManager();
    this.recorderManager = recorder;
    this.setData({ recorderManager: recorder });

    // 初始化选中日期标签
    this.setData({ selectedDateLabel: this.formatDateLabel(this.data.selectedDate) });

    recorder.onStart(() => {
      console.log('[Recorder] Started');
    });

    recorder.onStop((res) => {
      console.log('[Recorder] Stopped:', res);
      this.handleRecordStop(res);
    });

    recorder.onError((err) => {
      console.error('[Recorder] Error:', err);
      this.setData({ phase: 'idle' });
      wx.showToast({ title: '录音失败，请重试', icon: 'none' });
    });

    // 初始化分类列表
    this.initCategories();

    // 加载账本列表（用于确认卡片切换账本）
    this.loadLedgers();

    // 预热识别云函数，消除首次识别的冷启动耗时
    this.warmupVoice();
  },

  onShow() {
    // 每次进入记账页都尝试预热（内部有 20s 节流）
    this.warmupVoice();
  },

  onUnload() {
    this.clearTimer();
  },

  /**
   * 预热 voiceToText 云函数
   * 云函数冷启动（含腾讯云 SDK 加载）通常 300~800ms，是识别总耗时的大头。
   * 在「进入页面」和「按下录音」时提前拉起实例，让真正的识别跑在热实例上。
   */
  warmupVoice() {
    const now = Date.now();
    if (now - (this._lastWarmup || 0) < 20000) return; // 20s 内不重复预热
    this._lastWarmup = now;
    wx.cloud.callFunction({
      name: 'voiceToText',
      data: { warmup: true },
      success: () => {},
      fail: () => {}, // 预热失败不影响正常识别流程
    });
  },

  // ==================== 录音 ====================

  startRecord() {
    if (this.data.phase === 'recording') return;

    // 授权检查
    wx.authorize({
      scope: 'scope.record',
      success: () => this.doStartRecord(),
      fail: () => {
        wx.showModal({
          title: '需要麦克风权限',
          content: '请在设置中允许小程序使用麦克风',
          success: (res) => {
            if (res.confirm) wx.openSetting();
          },
        });
      },
    });
  },

  doStartRecord() {
    // 录音开始时再确保一次预热：用户说话的这几秒里，云函数实例保持热状态
    this.warmupVoice();

    this.recorderManager.start({
      duration: 15000,     // 最长15秒
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 32000, // 16kHz 采样下 32kbps 足够语音识别，文件更小传输更快（原 48k 偏大）
      format: 'mp3',
    });

    this.setData({ phase: 'recording', recordingTime: 0 });

    // 计时器
    this.clearTimer();
    this.data.recordTimer = setInterval(() => {
      const t = this.data.recordingTime + 1;
      this.setData({ recordingTime: t });
      if (t >= 14) {
        // 快超时了，提示一下
        this.stopRecord();
      }
    }, 1000);
  },

  stopRecord() {
    if (this.data.phase !== 'recording') return;
    this.clearTimer();
    this.recorderManager.stop();
  },

  clearTimer() {
    if (this.data.recordTimer) {
      clearInterval(this.data.recordTimer);
      this.data.recordTimer = null;
    }
  },

  // ==================== 语音识别 ====================

  async handleRecordStop(res) {
    const { tempFilePath, duration } = res;

    if (duration < 500) {
      this.setData({ phase: 'idle' });
      wx.showToast({ title: '说话时间太短', icon: 'none' });
      return;
    }

    this.setData({ phase: 'parsing' });

    try {
      await this.recognizeVoice(tempFilePath);
    } catch (err) {
      console.error('Voice recognition error:', err);
      this.setData({ phase: 'idle' });
      wx.showToast({ title: '语音识别失败，请重试', icon: 'none' });
    }
  },

  /**
   * 语音识别 —— 录音 base64 直传云函数，一次调用完成「识别 + 解析」
   * 优化点：
   *   1. 不再上传云存储（省掉上传+云函数内下载两轮网络往返）
   *   2. ASR 与 NLP 解析合并到 voiceToText 一次云函数调用（省一次冷启动+往返）
   *   3. 录音码率降到 32kbps（16kHz 采样足够），音频更小传输更快
   * 依赖腾讯云语音识别服务（每月 10,000 次免费额度）
   *
   * 如果 ASR 未配置，会自动弹出引导并切换到手动输入
   */
  async recognizeVoice(filePath) {
    const t0 = Date.now();
    try {
      // 1. 读取录音为 base64（15秒 mp3@32k ≈ 60KB → base64 ≈ 80KB，远低于 1MB 限制）
      wx.showLoading({ title: '语音识别中...' });
      const audioBase64 = await this.readFileAsBase64(filePath);
      const t1 = Date.now();

      // 2. 一次云函数调用：腾讯云 ASR 转文字 + NLP 解析出结构化账目
      const asrResult = await voiceAPI.recognize(audioBase64, 'mp3');
      const t2 = Date.now();
      wx.hideLoading();

      const result = asrResult || {};
      // 耗时埋点：定位慢在哪个环节（读文件 / 云函数识别）
      console.log(`[Record][perf] 读音频 ${t1 - t0}ms | 识别+解析 ${t2 - t1}ms | 总计 ${t2 - t0}ms`);
      console.log('[Record] voiceToText result:', JSON.stringify(result));

      // ---- ASR 服务未配置，走降级引导 ----
      if (result.fallback) {
        this.setData({ phase: 'idle' });
        wx.showModal({
          title: '语音识别未启用',
          content: '请在云函数 voiceToText 的环境变量中配置腾讯云 ASR 密钥。\n\n'
            + '配置后可享每月免费 10,000 次语音识别。\n\n'
            + '现在可以使用手动输入记账：',
          confirmText: '手动输入',
          cancelText: '知道了',
          success: (modalRes) => {
            if (modalRes.confirm) {
              this.openManualInput();
            }
          },
        });
        return;
      }

      // ---- ASR 返回了空文本 ----
      const text = result.text || '';
      if (!text || text.trim().length === 0) {
        this.setData({ phase: 'idle' });
        const extraMsg = result.message || '请确保周围环境安静，吐字清晰，重试一次';
        wx.showModal({
          title: '未识别到文字',
          content: result.asr_empty
            ? extraMsg
            : extraMsg + '\n\n或者使用手动输入：',
          confirmText: '手动输入',
          cancelText: '再试一次',
          success: (modalRes) => {
            if (modalRes.confirm) {
              this.openManualInput();
            }
          },
        });
        return;
      }

      // ---- ASR 成功但 NLP 解析失败（如没听清金额） ----
      if (result.parseFailed) {
        this.setData({ phase: 'idle' });
        wx.showModal({
          title: '未能解析',
          content: (result.reason || '请尝试重新说出金额和消费内容')
            + '\n\n识别到的内容：' + text
            + '\n\n或者使用手动输入：',
          confirmText: '手动输入',
          cancelText: '再试一次',
          success: (modalRes) => {
            if (modalRes.confirm) {
              this.openManualInput();
            }
          },
        });
        return;
      }

      // ---- 识别 + 解析成功，直接进入确认阶段 ----
      const parsed = result.parsed;
      if (!parsed || !parsed.amount) {
        this.setData({ phase: 'idle' });
        wx.showToast({ title: '解析结果异常，请重试', icon: 'none' });
        return;
      }

      // 如果语音没有解析出具体日期，使用用户选定的录入日期
      if (!parsed.date) {
        parsed.date = this.data.selectedDate;
      }

      this.setData({
        phase: 'confirm',
        rawText: text,
        parsed: {
          ...parsed,
          _fmtAmount: formatAmount(parsed.amount),
          _sign: parsed.type === 'income' ? '+' : '-',
        },
        confidence: result.confidence || '',
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[Record] recognizeVoice error:', err);
      this.setData({ phase: 'idle' });

      // 根据错误类型给出不同提示
      let errorMsg = '语音识别失败，请重试';
      if (err.errCode === -1 || (err.message && err.message.includes('timeout'))) {
        errorMsg = '网络超时，请检查网络后重试';
      } else if (err.errCode === -601003) {
        errorMsg = '云函数调用失败，请确认 voiceToText 已部署';
      }

      wx.showModal({
        title: '识别失败',
        content: errorMsg + '\n\n可以使用手动输入记账：',
        confirmText: '手动输入',
        cancelText: '返回',
        success: (modalRes) => {
          if (modalRes.confirm) {
            this.openManualInput();
          }
        },
      });
    }
  },

  /**
   * 读取录音文件为 base64（替代云存储中转，显著降低延迟）
   */
  readFileAsBase64(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'base64',
        success: (res) => resolve(res.data),
        fail: (err) => reject(err),
      });
    });
  },

  // ==================== 分类相关 ====================

  initCategories() {
    const config = app.globalData.categoryConfig;
    const expenseCategories = (config.expense || []).map((c) => ({
      ...c,
      icon: getCategoryIcon(c.id),
    }));
    this.setData({ categories: expenseCategories });
  },

  selectCategory(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      'parsed.categoryId': id,
      'parsed.categoryName': name,
    });
  },

  // ==================== 日期选择 ====================

  /**
   * 录入日期选择（idle 阶段）
   * 用户先选好日期，录音识别后的 parsed.date 默认使用此日期
   */
  onSelectDate(e) {
    const date = e.detail.value;
    this.setData({
      selectedDate: date,
      selectedDateLabel: this.formatDateLabel(date),
    });
  },

  /**
   * 确认卡片中修改日期
   */
  onDateChange(e) {
    this.setData({ 'parsed.date': e.detail.value });
  },

  /**
   * 日期显示标签：今天/昨天/前天/MM月DD日
   */
  formatDateLabel(dateStr) {
    const today = getToday();
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = formatDate(d);
    d.setDate(d.getDate() - 1);
    const dayBeforeYesterday = formatDate(d);

    if (dateStr === today) return '今天';
    if (dateStr === yesterday) return '昨天';
    if (dateStr === dayBeforeYesterday) return '前天';
    return formatDate(dateStr, 'MM月DD日');
  },

  // ==================== 描述输入 ====================

  onDescInput(e) {
    this.setData({ 'parsed.description': e.detail.value });
  },

  // ==================== 保存 ====================

  async saveExpense() {
    const { parsed } = this.data;
    if (!parsed || !parsed.amount) {
      wx.showToast({ title: '数据不完整', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    try {
      await expenseAPI.create({
        amount: parsed.amount,
        type: parsed.type,
        categoryId: parsed.categoryId,
        categoryName: parsed.categoryName,
        date: parsed.date,
        description: parsed.description,
        ledgerId: (getApp().getCurrentLedger().id) || '',
      });

      wx.hideLoading();
      wx.showToast({ title: '记账成功!', icon: 'success' });

      // 重置状态
      this.resetRecord();

      // 触发首页刷新标记
      const pages = getCurrentPages();
      const indexPage = pages.find((p) => p.route === 'pages/index/index');
      if (indexPage && indexPage.loadData) {
        indexPage.loadData();
      }
    } catch (err) {
      wx.hideLoading();
      // error handled in cloud.js
    }
  },

  // ==================== 重置 ====================

  resetRecord() {
    this.setData({
      phase: 'idle',
      rawText: '',
      parsed: null,
      confidence: '',
    });
    this.clearTimer();
  },

  // ==================== 手动输入（备用） ====================

  openManualInput() {
    wx.showModal({
      title: '手动记账',
      editable: true,
      placeholderText: '输入金额和描述，如：午餐35元',
      success: async (res) => {
        if (res.confirm && res.content) {
          this.setData({ rawText: res.content, phase: 'parsing' });
          const parseResult = await voiceAPI.parse(res.content);
          if (parseResult.success) {
            const parsed = parseResult.parsed;
            // 手动输入也使用选定的录入日期
            if (!parsed.date) {
              parsed.date = this.data.selectedDate;
            }
            this.setData({
              phase: 'confirm',
              parsed: {
                ...parsed,
                _fmtAmount: formatAmount(parsed.amount),
                _sign: parsed.type === 'income' ? '+' : '-',
              },
              confidence: parseResult.confidence,
            });
          } else {
            this.setData({ phase: 'idle' });
            wx.showToast({ title: '未能解析，请检查格式', icon: 'none' });
          }
        }
      },
    });
  },

  // ==================== 账本 ====================

  async loadLedgers() {
    const app = getApp();
    const current = app.getCurrentLedger();
    try {
      const res = await ledgerAPI.list();
      const shared = (res && res.list) || [];
      const options = [
        { id: '', name: '我的账本', type: 'personal' },
        ...shared.map((l) => ({ id: l._id, name: l.name, type: 'shared' })),
      ];
      // 校验当前共享账本是否仍有效
      let active = current;
      if (current.type === 'shared' && current.id && !shared.some((l) => l._id === current.id)) {
        active = { id: '', name: '我的账本', type: 'personal' };
        app.setCurrentLedger(active);
      }
      this.setData({ ledgers: options, currentLedgerName: active.name });
    } catch (err) {
      this.setData({
        ledgers: [{ id: '', name: '我的账本', type: 'personal' }],
        currentLedgerName: '我的账本',
      });
    }
  },

  // 切换记账账本
  onSelectLedger() {
    const items = this.data.ledgers.map((l) => l.name);
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const ledger = this.data.ledgers[res.tapIndex];
        const app = getApp();
        app.setCurrentLedger({ id: ledger.id, name: ledger.name, type: ledger.type });
        this.setData({ currentLedgerName: ledger.name });
      },
    });
  },

  // ==================== 分享 ====================

  onShareAppMessage() {
    return {
      title: '语音记账，一句话搞定！',
      path: '/pages/index/index',
    };
  },
});
