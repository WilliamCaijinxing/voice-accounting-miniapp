// pages/index/index.js — 首页（语音记账主界面）
//
// 已合并原「记账页」：录音 → 识别 → 确认 → 保存 全在本页闭环完成，
// 不再需要在两个 tab 之间来回切换。原 pages/record/record 保留为重定向壳页。
const { formatAmount, getToday, getCategoryIcon } = require('../../utils/util');
const { voiceAPI, expenseAPI, statsAPI, budgetAPI, ledgerAPI } = require('../../utils/cloud');

Page({
  data: {
    /* ========== 仪表盘 ========== */
    todayStats: { totalExpense: 0, totalIncome: 0, recordCount: 0, categoryBreakdown: [] },
    monthStats: null,
    recentList: [],
    todayText: '',
    currentMonth: new Date().getMonth() + 1,
    loading: true,

    // 预算
    budget: null,
    budgetPercent: 0,
    budgetRemaining: 0,

    /* ========== 账本 ========== */
    ledgers: [{ id: '', name: '我的账本', type: 'personal' }],
    currentLedgerId: '',
    currentLedgerName: '我的账本',

    /* ========== 语音记账 ========== */
    // 阶段：idle | recording | parsing | confirm
    phase: 'idle',
    recordingTime: 0,
    // 波形条高度（百分比），录音开始时随机生成
    waves: [],
    rawText: '',
    parsed: null,
    confidence: '',
    categories: [],
    todayStr: getToday(),
  },

  // ==================== 生命周期 ====================

  onLoad(options) {
    const now = new Date();
    this.setData({
      todayText: `${now.getMonth() + 1}月${now.getDate()}日 ${this.getWeekday(now.getDay())}`,
      currentMonth: now.getMonth() + 1,
    });

    this.initRecorder();
    this.initCategories();

    // onLoad 后紧接着会触发一次 onShow，这里标记跳过，避免首进首页重复发一轮请求
    this._skipNextShow = true;

    // 通过分享卡片进入：必须先 await 加入结果，再刷新，否则刷新的还是切换前的账本
    this.bootstrap(options);
  },

  async bootstrap(options) {
    // 分享卡片 path 携带 ledgerId + token（token 由创建者签发、72h 有效、可被重置作废）
    if (options && options.ledgerId) {
      await this.handleShareJoin(options.ledgerId, options.token || '');
    }
    await this.refresh();
    // 预热识别云函数，消除首次识别的冷启动耗时
    this.warmupVoice();
  },

  onShow() {
    this._pageHidden = false;
    if (this._skipNextShow) {
      this._skipNextShow = false;
      return;
    }
    // 每次切回首页都刷新数据（先刷新账本列表，再刷新数据）
    this.refresh();
    // 每次进入首页都尝试预热（内部有 20s 节流）
    this.warmupVoice();
  },

  onHide() {
    // 录音中切后台 / 跳走：必须停录并清计时器，否则 15s 后会在后台弹出确认卡
    this._pageHidden = true;
    this.abortRecording();
  },

  onUnload() {
    this._destroyed = true;
    this.abortRecording();
  },

  /** 中止录音并复位（后台/卸载时调用，丢弃本次录音结果） */
  abortRecording() {
    this.clearTimer();
    if (this.data.phase === 'recording') {
      this.setData({ phase: 'idle', recordingTime: 0 });
      try {
        if (this.recorderManager) this.recorderManager.stop();
      } catch (e) {
        // 停录失败无需处理，已复位到 idle
      }
    }
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  // ==================== 数据加载 ====================

  // 刷新：先加载账本列表（含校验当前账本有效性），再加载数据
  async refresh() {
    await this.loadLedgers().catch(() => {});
    await this.loadData().catch(() => {});
  },

  async loadData() {
    // 请求序号：快速连点切换账本时会有多轮请求并发，旧请求返回后必须丢弃，
    // 否则慢返回的旧账本数据会覆盖新账本（页面显示与当前账本不一致）
    const seq = (this._dataSeq = (this._dataSeq || 0) + 1);

    this.setData({ loading: true });
    const app = getApp();
    const ledger = app.getCurrentLedger();
    const ledgerId = ledger.id || '';

    try {
      const [todayData, monthData, recentData] = await Promise.all([
        statsAPI.today(ledgerId),
        statsAPI.monthly(new Date().getFullYear(), new Date().getMonth() + 1, ledgerId),
        expenseAPI.list({ page: 1, pageSize: 10, ledgerId }),
      ]);

      const today = todayData || { totalExpense: 0, totalIncome: 0, recordCount: 0, categoryBreakdown: [] };
      const month = monthData || { totalExpense: 0, totalIncome: 0, recordCount: 0, daysWithRecords: 0, avgDailyExpense: 0, balance: 0 };
      const list = (recentData && recentData.list) || [];

      // 构建记账人昵称映射（仅共享账本需要显示"谁记的"）
      let openidMap = {};
      if (ledger.type === 'shared' && ledger.id) {
        try {
          const detail = await ledgerAPI.detail(ledger.id);
          (detail.members || []).forEach((m) => { openidMap[m.openid] = m.nickname || '成员'; });
        } catch (e) {
          console.warn('Ledger detail failed', e);
        }
      }

      // 已有更新的请求发出（账本已切换），本次结果作废
      if (seq !== this._dataSeq) return;

      // 预计算格式化字符串与颜色，不在 WXML 中调用函数
      // （WXML 的 Mustache 不支持调用 Page 方法，直接写会静默渲染为空）
      this.setData({
        todayStats: {
          ...today,
          categoryBreakdown: (today.categoryBreakdown || []).map(item => ({
            ...item,
            _color: this.getCategoryColor(item.categoryId),
          })),
          _fmtTotalExpense: formatAmount(today.totalExpense),
          _fmtTotalIncome: formatAmount(today.totalIncome),
        },
        monthStats: {
          ...month,
          _fmtTotalExpense: formatAmount(month.totalExpense),
          _fmtTotalIncome: formatAmount(month.totalIncome),
          _fmtBalance: formatAmount(Math.abs(month.balance || 0)),
          _balanceSign: (month.balance || 0) >= 0 ? '+' : '-',
          _balanceClass: (month.balance || 0) >= 0 ? 'income' : 'expense',
        },
        recentList: list.map(item => ({
          ...item,
          _fmtAmount: formatAmount(item.amount),
          _sign: item.type === 'income' ? '+' : '-',
          recorderName: ledger.type === 'shared' ? (openidMap[item._openid] || '成员') : '',
        })),
        loading: false,
      });

      // 并行加载预算信息（失败不影响主流程；带 seq 防止旧账本的预算写入新账本）
      this.loadBudgetInfo(month.totalExpense, ledgerId, seq).catch(() => {});
    } catch (err) {
      if (seq !== this._dataSeq) return;
      console.error('[Index] loadData error:', err);
      this.setData({ loading: false });
    }
  },

  // 加载预算信息（共享账本传入 ledgerId）
  async loadBudgetInfo(monthExpense, ledgerId = '', seq) {
    try {
      const budget = await budgetAPI.get(ledgerId);
      if (seq !== undefined && seq !== this._dataSeq) return; // 账本已切换，丢弃
      if (budget && budget.monthlyBudget > 0) {
        const percent = Math.round((monthExpense / 100 / budget.monthlyBudget) * 100);
        const remaining = budget.monthlyBudget - monthExpense / 100;
        // 本月剩余天数（含今天）
        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const remainingDays = daysInMonth - now.getDate() + 1;
        this.setData({
          budget: budget,
          budgetPercent: percent,
          budgetRemaining: remaining,
          _fmtBudgetRemaining: formatAmount(Math.max(0, remaining) * 100),
          _fmtBudgetOver: formatAmount(Math.max(0, -remaining) * 100),
          _dailyAvailable: remainingDays > 0 ? Math.max(0, remaining / remainingDays).toFixed(0) : '0',
        });
      } else {
        this.setData({ budget: null });
      }
    } catch (err) {
      this.setData({ budget: null });
    }
  },

  // 分享卡片携带 ledgerId 进入时，自动加入并切换
  async handleShareJoin(ledgerId, token) {
    try {
      const userInfo = getApp().globalData.userInfo || {};
      const ledger = await ledgerAPI.joinByShare(
        ledgerId,
        token,
        userInfo.nickName || '',
        userInfo.avatarUrl || ''
      );
      getApp().setCurrentLedger({ id: ledger._id, name: ledger.name, type: 'shared' });
      wx.showToast({ title: '已加入共享账本', icon: 'success' });
    } catch (err) {
      // 链接失效/过期、账本已解散等情况必须让用户看见原因，
      // 否则点开卡片后静默停在个人账本，用户不知道发生了什么
      console.warn('[Index] share join failed:', err);
      wx.showModal({
        title: '未能加入共享账本',
        content: (err && err.message) || '邀请链接无效，请让创建者重新分享',
        showCancel: false,
        confirmText: '知道了',
      });
    }
  },

  // ==================== 账本 ====================

  // 加载账本列表（个人 + 共享），并校验当前账本有效性
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

      // 校验当前共享账本是否仍有效（可能已退出/被解散）
      let active = current;
      if (current.type === 'shared' && current.id && !shared.some((l) => l._id === current.id)) {
        active = { id: '', name: '我的账本', type: 'personal' };
        app.setCurrentLedger(active);
      }

      this.setData({
        ledgers: options,
        currentLedgerId: active.id || '',
        currentLedgerName: active.name || '我的账本',
      });
    } catch (err) {
      this.setData({
        ledgers: [{ id: '', name: '我的账本', type: 'personal' }],
        currentLedgerId: '',
        currentLedgerName: '我的账本',
      });
    }
  },

  // 切换当前账本
  async switchLedger(e) {
    const { id, type, name } = e.currentTarget.dataset;
    const app = getApp();
    app.setCurrentLedger({ id: id || '', name, type });
    this.setData({ currentLedgerId: id || '', currentLedgerName: name });
    await this.loadData().catch(() => {});
    wx.showToast({ title: `已切换到${name}`, icon: 'none' });
  },

  // ==================== 录音 ====================

  /**
   * 初始化录音管理器
   * 注意：recorderManager / recordTimer 挂实例属性而非 data，
   * 避免把不可序列化的对象通过 setData 跨线程传递。
   */
  initRecorder() {
    const recorder = wx.getRecorderManager();
    this.recorderManager = recorder;

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
      encodeBitRate: 32000, // 16kHz 采样下 32kbps 足够语音识别，文件更小传输更快
      format: 'mp3',
    });

    // 波形高度在 JS 侧生成（WXML 表达式不支持 Math.random()）
    const waves = Array.from({ length: 15 }, () => 20 + Math.round(Math.random() * 60));

    this.setData({ phase: 'recording', recordingTime: 0, waves });

    // 计时器
    this.clearTimer();
    this.recordTimer = setInterval(() => {
      const t = this.data.recordingTime + 1;
      this.setData({ recordingTime: t });
      if (t >= 14) {
        // 快超时了，自动结束
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
    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = null;
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
   * 依赖腾讯云语音识别服务（每月 10,000 次免费额度）
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
      console.log(`[Index][perf] 读音频 ${t1 - t0}ms | 识别+解析 ${t2 - t1}ms | 总计 ${t2 - t0}ms`);
      console.log('[Index] voiceToText result:', JSON.stringify(result));

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
            if (modalRes.confirm) this.openManualInput();
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
          content: result.asr_empty ? extraMsg : extraMsg + '\n\n或者使用手动输入：',
          confirmText: '手动输入',
          cancelText: '再试一次',
          success: (modalRes) => {
            if (modalRes.confirm) this.openManualInput();
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
            if (modalRes.confirm) this.openManualInput();
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

      // 语音没有解析出具体日期时，默认记到今天
      if (!parsed.date) {
        parsed.date = this.data.todayStr;
      }

      this.enterConfirm(parsed, text, result.confidence || '');
    } catch (err) {
      wx.hideLoading();
      console.error('[Index] recognizeVoice error:', err);
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
          if (modalRes.confirm) this.openManualInput();
        },
      });
    }
  },

  // 进入确认状态（语音与手动输入共用）
  enterConfirm(parsed, rawText, confidence) {
    this.setData({
      phase: 'confirm',
      rawText: rawText || '',
      parsed: {
        ...parsed,
        _fmtAmount: formatAmount(parsed.amount),
        _sign: parsed.type === 'income' ? '+' : '-',
      },
      confidence: confidence || '',
    });
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

  // ==================== 确认卡片交互 ====================

  initCategories() {
    const config = getApp().globalData.categoryConfig || {};
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

  // 确认卡片中修改日期
  onDateChange(e) {
    this.setData({ 'parsed.date': e.detail.value });
  },

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

    // 防重复提交：showLoading 未加 mask，断网时用户会连点保存按钮导致重复入账
    if (this._saving) return;
    this._saving = true;

    wx.showLoading({ title: '保存中...', mask: true });

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

      // 重置录音状态
      this.resetRecord();

      // 本页即首页，直接刷新今日/本月统计与最近账单
      await this.loadData().catch(() => {});
    } catch (err) {
      wx.hideLoading();
      console.error('[Index] saveExpense error:', err);
      // 云函数异常时 callCloud 已弹过 toast；这里兜底非云函数异常，
      // 保证断网/异常场景下用户一定看到失败原因并能重试（确认卡保留）
      if (!(err && (err.message || err.errMsg))) {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    } finally {
      this._saving = false;
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
        if (!res.confirm || !res.content) return;

        this.setData({ rawText: res.content, phase: 'parsing' });

        // 必须捕获异常：parseVoice 走 callCloud，断网/云函数异常时会 reject。
        // 此前没有 catch，phase 会永久停在 'parsing'，页面卡在「解析中」无法恢复。
        try {
          const parseResult = await voiceAPI.parse(res.content);
          if (parseResult && parseResult.success) {
            const parsed = parseResult.parsed;
            if (!parsed.date) {
              parsed.date = this.data.todayStr;
            }
            this.enterConfirm(parsed, res.content, parseResult.confidence);
          } else {
            this.setData({ phase: 'idle' });
            wx.showToast({ title: '未能解析，请检查格式', icon: 'none' });
          }
        } catch (err) {
          console.error('[Index] manual parse error:', err);
          this.setData({ phase: 'idle' });
          // callCloud 已对云函数异常弹过 toast，这里只补「非云函数异常」的提示，避免重复弹窗
          if (!(err && (err.message || err.errMsg))) {
            wx.showToast({ title: '解析失败，请重试', icon: 'none' });
          }
        }
      },
    });
  },

  // ==================== 页面跳转 ====================

  goToBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' });
  },

  goToStats() {
    wx.switchTab({ url: '/pages/statistics/statistics' });
  },

  goToLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' });
  },

  // 点击账单项 — 跳转到详情/编辑页（携带 ledgerId 以支持共享账本）
  onExpenseTap(e) {
    const { item } = e.detail;
    const ledger = getApp().getCurrentLedger();
    const ledgerId = ledger.type === 'shared' ? ledger.id : '';
    wx.navigateTo({
      url: `/pages/bill-detail/bill-detail?id=${item._id}${ledgerId ? `&ledgerId=${ledgerId}` : ''}`,
    });
  },

  // ==================== 工具 ====================

  // 分类颜色映射
  getCategoryColor(categoryId) {
    const colors = {
      food: '#FF6B6B', transport: '#4ECDC4', shopping: '#FF8E72',
      housing: '#6C5CE7', entertainment: '#A29BFE', medical: '#FF7675',
      education: '#74B9FF', social: '#FDCB6E', other: '#B2BEC3',
    };
    return colors[categoryId] || '#B2BEC3';
  },

  getWeekday(day) {
    const map = ['日', '一', '二', '三', '四', '五', '六'];
    return `星期${map[day]}`;
  },

  // ==================== 分享 ====================

  onShareAppMessage() {
    return {
      title: '语音记账，一句话搞定！',
      path: '/pages/index/index',
    };
  },
});
