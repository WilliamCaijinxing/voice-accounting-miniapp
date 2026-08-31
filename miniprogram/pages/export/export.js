// pages/export/export.js — 账本数据导出页
const { exportAPI, currentLedgerId } = require('../../utils/cloud');

Page({
  data: {
    dateRanges: [
      { key: 'all', label: '全部账单' },
      { key: 'thisMonth', label: '本月账单' },
      { key: 'lastMonth', label: '上月账单' },
      { key: 'thisYear', label: '本年账单' },
    ],
    activeRange: 'all',
    exporting: false,
    result: null,
    currentLedgerName: '我的账本',

    // 文件获取方式（解决"导出的文件不知道在哪"）
    localPath: '',   // 小程序本地路径（供转发到微信）
    tempUrl: '',     // 云存储临时下载链接（可在浏览器打开）
    preparing: false,
  },

  onShow() {
    this.setData({ currentLedgerName: getApp().getCurrentLedger().name });
  },

  selectRange(e) {
    this.setData({ activeRange: e.currentTarget.dataset.key, result: null });
  },

  getRangeDates(key) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');

    switch (key) {
      case 'thisMonth':
        return {
          startDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`,
          endDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`,
        };
      case 'lastMonth': {
        const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
        return {
          startDate: `${firstDay.getFullYear()}-${pad(firstDay.getMonth() + 1)}-01`,
          endDate: `${lastDay.getFullYear()}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}`,
        };
      }
      case 'thisYear':
        return {
          startDate: `${now.getFullYear()}-01-01`,
          endDate: `${now.getFullYear()}-12-31`,
        };
      default:
        return { startDate: '', endDate: '' };
    }
  },

  async doExport() {
    if (this.data.exporting) return;
    const ledgerId = currentLedgerId();
    const ledger = getApp().getCurrentLedger();
    this.setData({
      exporting: true, result: null, currentLedgerName: ledger.name,
      localPath: '', tempUrl: '',
    });

    wx.showLoading({ title: '正在导出...', mask: true });

    try {
      const { startDate, endDate } = this.getRangeDates(this.data.activeRange);
      const res = await exportAPI.exportCSV({ startDate, endDate, ledgerId });
      wx.hideLoading();
      this.setData({ result: res, exporting: false });

      if (res.count === 0) {
        wx.showToast({ title: '没有可导出的数据', icon: 'none' });
        return;
      }

      wx.showToast({ title: '导出成功', icon: 'success' });
      // 提前备好文件，让下方「转发 / 复制链接」立即可用
      this.prepareFile(res.fileID);
    } catch (err) {
      wx.hideLoading();
      this.setData({ exporting: false });
    }
  },

  // ==================== 文件获取方式 ====================
  // 背景：CSV 保存在小程序沙盒目录，手机文件管理无法直接查看，
  //       且 wx.openDocument 不支持 CSV 预览。因此提供三种可靠获取方式。

  /** 并行准备：云存储临时下载链接 + 小程序本地文件路径 */
  async prepareFile(fileID) {
    this.setData({ preparing: true });
    const urlTask = wx.cloud.getTempFileURL({ fileList: [fileID] })
      .then((r) => (r && r.fileList && r.fileList[0] ? r.fileList[0].tempFileURL : ''))
      .catch(() => '');
    const localTask = this.downloadToLocal(fileID).catch(() => '');
    const [tempUrl, localPath] = await Promise.all([urlTask, localTask]);
    this.setData({ tempUrl, localPath, preparing: false });
  },

  /** 下载云文件到本地，返回本地路径 */
  downloadToLocal(fileID) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        success: (res) => {
          const fs = wx.getFileSystemManager();
          const savePath = `${wx.env.USER_DATA_PATH}/ledger_export.csv`;
          try {
            fs.saveFileSync(res.tempFilePath, savePath);
            resolve(savePath);
          } catch (e) {
            resolve(res.tempFilePath); // 保存失败则退回临时路径
          }
        },
        fail: reject,
      });
    });
  },

  /** 确保本地文件已就绪 */
  async ensureLocalFile() {
    if (this.data.localPath) return this.data.localPath;
    const fileID = this.data.result && this.data.result.fileID;
    if (!fileID) return '';
    wx.showLoading({ title: '准备文件...' });
    const path = await this.downloadToLocal(fileID).catch(() => '');
    wx.hideLoading();
    if (path) this.setData({ localPath: path });
    return path;
  },

  /** 方式一（推荐）：转发到微信，发给「文件传输助手」即可在电脑/手机拿到 */
  async shareToWeChat() {
    const filePath = await this.ensureLocalFile();
    if (!filePath) {
      wx.showToast({ title: '文件准备失败，请重试', icon: 'none' });
      return;
    }
    wx.shareFileMessage({
      filePath,
      fileName: `${this.data.currentLedgerName || '我的账本'}_账单.csv`,
      success: () => {},
      fail: (err) => {
        console.error('shareFileMessage fail:', err);
        wx.showModal({
          title: '转发失败',
          content: '可改用「复制下载链接」，粘贴到浏览器即可下载文件。',
          showCancel: false,
        });
      },
    });
  },

  /** 方式二：复制临时下载链接，在电脑/手机浏览器打开即可下载 */
  copyLink() {
    if (!this.data.tempUrl) {
      wx.showToast({ title: '链接尚未生成，请稍候', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.tempUrl,
      success: () => wx.showToast({ title: '下载链接已复制', icon: 'success' }),
    });
  },

  /** 复制小程序内保存路径（便于排查） */
  copyPath() {
    if (!this.data.localPath) {
      wx.showToast({ title: '文件尚未下载到本地', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.localPath,
      success: () => wx.showToast({ title: '路径已复制', icon: 'success' }),
    });
  },

  /** 方式三：尝试在小程序内打开（CSV 预览支持有限，失败会引导其他方式） */
  async openLocalFile() {
    const filePath = await this.ensureLocalFile();
    if (!filePath) {
      wx.showToast({ title: '文件准备失败，请重试', icon: 'none' });
      return;
    }
    wx.openDocument({
      filePath,
      fileType: 'csv',
      showMenu: true,   // 右上角菜单可转发/保存
      success: () => {},
      fail: () => {
        wx.showModal({
          title: '无法在小程序内预览',
          content: 'CSV 不支持在小程序中直接打开。建议「转发到微信」发到文件传输助手，或用「复制下载链接」在电脑浏览器打开。',
          showCancel: false,
        });
      },
    });
  },
});
