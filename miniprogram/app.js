// app.js - 语音记账小程序入口
App({
  onLaunch() {
    // 初始化云开发
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-d5gk2s5v9147776de', // 替换为你的云环境ID
        traceUser: true,
      });
    }

    // 获取系统信息
    const systemInfo = wx.getSystemInfoSync();
    this.globalData.systemInfo = systemInfo;
    this.globalData.statusBarHeight = systemInfo.statusBarHeight;
    this.globalData.navBarHeight = systemInfo.platform === 'android' ? 48 : 44;

    // 恢复上次选中的账本
    try {
      const cached = wx.getStorageSync('currentLedger');
      if (cached && (cached.type === 'personal' || cached.type === 'shared')) {
        this.globalData.currentLedger = cached;
      }
    } catch (e) {
      // ignore
    }

    // 自动登录
    this.autoLogin();
  },

  onShow() {
    // 小程序切前台时刷新用户数据
  },

  // 自动静默登录 — 无需用户操作
  async autoLogin() {
    try {
      const { code } = await this.promisify(wx.login)();
      const res = await wx.cloud.callFunction({
        name: 'userLogin',
        data: { code },
      });
      this.globalData.openid = res.result.openid;
      this.globalData.userInfo = res.result.userInfo;
    } catch (err) {
      console.error('Auto login failed:', err);
    }
  },

  // 获取用户公开信息（需要用户授权）
  async getUserProfile() {
    try {
      const { userInfo } = await this.promisify(wx.getUserProfile)({
        desc: '用于记账数据关联',
      });
      this.globalData.userInfo = { ...this.globalData.userInfo, ...userInfo };
      return userInfo;
    } catch (err) {
      console.warn('User declined profile authorization');
      return null;
    }
  },

  // 通用 promisify 包装器
  promisify(api) {
    return (options = {}) => {
      return new Promise((resolve, reject) => {
        api({
          ...options,
          success: resolve,
          fail: reject,
        });
      });
    };
  },

  // 设置当前账本并持久化（ledger: {id, name, type:'personal'|'shared'}）
  setCurrentLedger(ledger) {
    this.globalData.currentLedger = ledger;
    try {
      wx.setStorageSync('currentLedger', ledger);
    } catch (e) {
      // ignore
    }
  },

  // 获取当前账本（优先内存，其次缓存）
  getCurrentLedger() {
    let ledger = this.globalData.currentLedger;
    if (!ledger || (!ledger.id && ledger.type !== 'personal')) {
      try {
        const cached = wx.getStorageSync('currentLedger');
        if (cached) ledger = cached;
      } catch (e) {
        // ignore
      }
    }
    if (!ledger) ledger = { id: '', name: '我的账本', type: 'personal' };
    this.globalData.currentLedger = ledger;
    return ledger;
  },

  globalData: {
    openid: '',
    userInfo: null,
    systemInfo: null,
    statusBarHeight: 0,
    navBarHeight: 0,
    // 当前账本：个人账本 {id:'', name:'我的账本', type:'personal'}；共享账本 {id, name, type:'shared'}
    currentLedger: { id: '', name: '我的账本', type: 'personal' },
    // 预设分类定义（可被用户自定义覆盖）
    categoryConfig: {
      expense: [
        { id: 'food', name: '餐饮', icon: 'food', keywords: ['吃饭', '外卖', '午餐', '晚餐', '早餐', '聚餐', '奶茶', '咖啡', '小吃', '烧烤', '火锅'] },
        { id: 'transport', name: '交通', icon: 'transport', keywords: ['打车', '地铁', '公交', '加油', '停车', '高铁', '飞机', '火车', '滴滴', '骑车'] },
        { id: 'shopping', name: '购物', icon: 'shopping', keywords: ['衣服', '鞋子', '超市', '网购', '淘宝', '京东', '日用品', '化妆品', '数码'] },
        { id: 'housing', name: '居家', icon: 'housing', keywords: ['房租', '房贷', '水电', '物业', '维修', '装修', '煤气', '宽带', '话费'] },
        { id: 'entertainment', name: '娱乐', icon: 'entertainment', keywords: ['电影', 'KTV', '游戏', '旅游', '景点', '门票', '演出', '剧本杀'] },
        { id: 'medical', name: '医疗', icon: 'medical', keywords: ['看病', '药', '医院', '体检', '挂号', '门诊'] },
        { id: 'education', name: '教育', icon: 'education', keywords: ['学费', '培训', '书本', '课程', '考试', '考证'] },
        { id: 'social', name: '人情', icon: 'social', keywords: ['红包', '结婚', '生日', '礼物', '随礼', '请客'] },
        { id: 'other', name: '其他', icon: 'other', keywords: [] },
      ],
      income: [
        { id: 'salary', name: '工资', icon: 'salary', keywords: ['工资', '薪水', '奖金', '年终奖', '绩效'] },
        { id: 'freelance', name: '兼职', icon: 'freelance', keywords: ['兼职', '外快', '私活', '副业'] },
        { id: 'investment', name: '理财', icon: 'investment', keywords: ['利息', '股票', '基金', '分红', '理财'] },
        { id: 'refund', name: '退款', icon: 'refund', keywords: ['退款', '报销', '返现'] },
        { id: 'other_income', name: '其他收入', icon: 'other_income', keywords: [] },
      ],
    },
  },
});
