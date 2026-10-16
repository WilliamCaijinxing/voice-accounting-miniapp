// pages/import/import.js — 从「小羊记账」版式 Excel 导入账本数据
// 两步式：预览确认 → 入库。表格解析在云端做，这里只负责展示与勾选。
const { importAPI, ledgerAPI, currentLedgerId } = require('../../utils/cloud');
const { formatAmount } = require('../../utils/util');

const CHUNK = 500; // 单次入库上限（云函数 MAX_CONFIRM），超出分批

Page({
  data: {
    step: 'idle',            // idle | parsing | preview | importing | done
    currentLedgerName: '我的账本',
    readonly: false,         // 只读成员（viewer）不允许导入
    fileName: '',

    records: [],             // 预览记录（每项带 _ 前缀的展示字段）
    total: 0,
    duplicateCount: 0,
    checkedCount: 0,
    totalAmountText: '0',
    warnings: [],
    truncated: false,

    result: null,            // { inserted, skipped }
  },

  onLoad() {
    const ledger = getApp().getCurrentLedger();
    this.setData({ currentLedgerName: ledger.name });
    this.checkRole(ledger);
  },

  /** 只读成员不给入口：与其让他点完被服务端拒，不如一开始就说明白 */
  async checkRole(ledger) {
    if (ledger.type !== 'shared') return;
    try {
      const detail = await ledgerAPI.detail(ledger.id);
      if (detail.myRole === 'viewer') {
        this.setData({ readonly: true });
      }
    } catch (e) {
      // 拉不到角色信息时不拦截：服务端仍会按角色拒绝，不会造成越权导入
    }
  },

  // ==================== 选文件 → 解析 ====================
  async chooseFile() {
    if (this.data.readonly) return;
    if (this.data.step === 'parsing' || this.data.step === 'importing') return;

    let file;
    try {
      const res = await new Promise((resolve, reject) => {
        wx.chooseMessageFile({
          count: 1,
          type: 'file',
          success: resolve,
          fail: reject,
        });
      });
      file = res.tempFiles && res.tempFiles[0];
    } catch (err) {
      // 用户主动取消：不是错误，静默返回
      return;
    }

    if (!file) return;
    // chooseMessageFile 的 extension 过滤在部分版本不可靠，这里自己校验一遍
    if (!/\.(xlsx|xls)$/i.test(file.name || '')) {
      wx.showToast({ title: '请选择 .xlsx 格式的表格文件', icon: 'none' });
      return;
    }

    this.setData({ step: 'parsing', fileName: file.name, result: null });
    wx.showLoading({ title: '正在解析...', mask: true });

    try {
      const up = await wx.cloud.uploadFile({
        cloudPath: `imports/${Date.now()}_${Math.floor(Math.random() * 100000)}.xlsx`,
        filePath: file.path,
      });

      const res = await importAPI.parsePreview(up.fileID, currentLedgerId());
      wx.hideLoading();

      const records = (res.records || []).map((r) => this.decorate(r));
      this.setData({
        step: 'preview',
        records,
        total: res.total || records.length,
        duplicateCount: res.duplicateCount || 0,
        warnings: res.warnings || [],
        truncated: !!res.truncated,
      });
      this.refreshSummary();
    } catch (err) {
      wx.hideLoading();
      this.setData({ step: 'idle' });
      // 错误文案由 callCloud 统一 toast（服务端已给出可读原因）
    }
  },

  /** 补齐展示字段：金额文本、分类猜测、默认勾选状态 */
  decorate(r) {
    const type = r.type === 'income' ? 'income' : 'expense';
    const amountFen = Math.round(Number(r.amount) * 100);
    const cat = this.guessCategory(r.desc, type);
    return {
      ...r,
      type,
      // 重复项默认不勾选：用户大概率不想再导一遍，但保留勾选权
      checked: !r.duplicate,
      _amountText: formatAmount(amountFen),
      _amountYuan: r.amount,
      _typeLabel: type === 'income' ? '收入' : '支出',
      _categoryName: cat.name,
      _categoryId: cat.id,
      _descText: r.desc || '(无描述)',
    };
  },

  /**
   * 按关键词猜测分类。分类定义是 app.js 里那份（唯一事实源），
   * 这里只读它、不复制关键词，避免与 app.js 漂移（P1-19 的教训）。
   */
  guessCategory(desc, type) {
    const app = getApp();
    const cfg = (app && app.globalData && app.globalData.categoryConfig) || {};
    const list = cfg[type] || [];
    const text = String(desc || '');
    if (text) {
      for (const c of list) {
        if ((c.keywords || []).some((k) => text.indexOf(k) >= 0)) {
          return { id: c.id, name: c.name };
        }
      }
    }
    const fallbackId = type === 'income' ? 'other_income' : 'other';
    const fallback = list.find((c) => c.id === fallbackId) || list[list.length - 1];
    return fallback ? { id: fallback.id, name: fallback.name } : { id: fallbackId, name: '其他' };
  },

  // ==================== 勾选 ====================
  toggleItem(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const records = this.data.records;
    if (idx < 0 || idx >= records.length) return;
    records[idx].checked = !records[idx].checked;
    this.setData({ records });
    this.refreshSummary();
  },

  setAllChecked(checked) {
    const records = this.data.records.map((r) => ({ ...r, checked }));
    this.setData({ records });
    this.refreshSummary();
  },

  selectAll() {
    this.setAllChecked(true);
  },

  deselectAll() {
    this.setAllChecked(false);
  },

  /** 只保留非重复项（最常用：重复导同一份表时的安全选择） */
  selectNonDuplicate() {
    const records = this.data.records.map((r) => ({ ...r, checked: !r.duplicate }));
    this.setData({ records });
    this.refreshSummary();
  },

  /** 汇总：勾选条数 + 合计金额（JS 侧算好，WXML 只取值） */
  refreshSummary() {
    const checked = this.data.records.filter((r) => r.checked);
    const sumFen = checked.reduce((acc, r) => acc + Math.round(Number(r.amount) * 100), 0);
    this.setData({
      checkedCount: checked.length,
      totalAmountText: formatAmount(sumFen),
    });
  },

  // ==================== 确认入库 ====================
  async doImport() {
    const selected = this.data.records.filter((r) => r.checked);
    if (!selected.length) {
      wx.showToast({ title: '请至少选择一条记录', icon: 'none' });
      return;
    }
    if (this.data.step === 'importing' || this.data.readonly) return;

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '确认导入',
        content: `将向「${this.data.currentLedgerName}」导入 ${selected.length} 条记录，合计 ¥${this.data.totalAmountText}`,
        confirmText: '导入',
        cancelText: '再看看',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirm) return;

    this.setData({ step: 'importing' });
    wx.showLoading({ title: '正在导入...', mask: true });

    const ledgerId = currentLedgerId();
    let inserted = 0;
    let skipped = 0;
    let aborted = false;

    // 分批调用：单批 500 条，避免大文件把云函数单次调用拖超时
    for (let i = 0; i < selected.length && !aborted; i += CHUNK) {
      const chunk = selected.slice(i, i + CHUNK).map((r) => ({
        date: r.date,
        desc: r.desc,
        amount: r.amount,
        type: r.type,
        categoryId: r._categoryId,
        categoryName: r._categoryName,
      }));
      try {
        const res = await importAPI.confirmImport(chunk, ledgerId);
        inserted += res.inserted || 0;
        skipped += res.skipped || 0;
      } catch (err) {
        aborted = true;
        wx.hideLoading();
        this.setData({ step: 'preview' });
        wx.showModal({
          title: '导入中断',
          content: `已成功导入 ${inserted} 条，之后中断了。剩余记录未导入，可重试。`,
          showCancel: false,
        });
        return;
      }
    }

    wx.hideLoading();
    this.setData({ step: 'done', result: { inserted, skipped } });
  },

  /** 导入完成后返回上一页（账本数据会随 onShow 自动刷新） */
  goBack() {
    wx.navigateBack();
  },

  reSelect() {
    this.setData({
      step: 'idle',
      records: [],
      result: null,
      checkedCount: 0,
      totalAmountText: '0',
      warnings: [],
      fileName: '',
    });
  },
});
