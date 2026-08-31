# 多人共同记账（共享账本）功能 — 实施总结

> 分支自 `voice-accounting-miniapp`，在原有个人记账基础上新增「家人/朋友一起记账」能力。
> 已通过 `node --check`（全部 JS）与 JSON 校验（app.json / ledger.json / package.json / schema.json）。

## 一、已确认的产品决策

| 项 | 决策 |
|----|------|
| 邀请方式 | 邀请码 **+** 微信分享卡片，两种都要 |
| 成员权限 | 全员可读写 |
| 预算模式 | 共享总预算（按 `ledgerId` 存预算，不按个人） |
| 记账人 | 显示「谁记的」（首页 / 账单详情展示昵称） |

## 二、数据隔离与权限设计（关键）

- 新增 `ledgers` 集合，权限：**所有用户可读，仅创建者可写**（成员列表需可见；所有写操作走云函数）
- `expenses` / `budgets` 新增可选 `ledgerId` 字段，**权限仍为「仅创建者可读写」**
- 查询 scope：
  - 个人账本：`{ _openid, ledgerId: _.exists(false) }`（兼容历史无字段数据，零迁移）
  - 共享账本：`{ ledgerId }`，并经云函数 `verifyLedgerMember` 校验成员身份
- ⚠️ 微信数据库权限无法细到「成员可读」，故跨用户读写一律走云函数，前端不可直连他人账目

## 三、改动文件清单

### 云端函数（共 9 个）
- `cloudfunctions/groupCRUD/index.js` — **新增**：create / list / detail / joinByCode / joinByShare / quit / removeMember / regenerateCode / dissolve
- `cloudfunctions/expenseCRUD/index.js` — 支持 `ledgerId`、成员校验、个人/共享双 scope
- `cloudfunctions/statistics/index.js` — 所有聚合接口支持 `ledgerId`
- `cloudfunctions/budgetCRUD/index.js` — 个人/共享预算分支
- `cloudfunctions/exportData/index.js` — 按 `ledgerId` 导出（共享账本含「记账人」列）

### 前端
- `utils/cloud.js` — 新增 `ledgerAPI` + `currentLedgerId`
- `app.js` — 全局 `currentLedger` 状态 + `wx.setStorageSync` 持久化
- `pages/index/index.js|.wxml|.wxss` — 顶部账本切换胶囊 + 账单记账人标记 + 分享卡片自动加入
- `pages/record/record.js|.wxml|.wxss` — 确认卡片显示/切换当前账本
- `pages/statistics/statistics.js|.wxml|.wxss` — 只读账本指示（统计随当前账本联动）
- `pages/ledger/ledger.{js,wxml,wxss,json}` — **新增页面**：创建 / 邀请码加入 / 成员列表 / 邀请码复制与重置 / 微信分享 / 退出 / 解散
- `pages/mine/mine.{js,wxml,wxss}` — 共享账本入口 + 概览账本指示
- `pages/bill-detail/bill-detail.{js,wxml}` — 透传 `ledgerId`（**修复共享账目无法编辑/删除的坑**）+ 显示记账人
- `pages/export/export.{js,wxml,wxss}` — 按当前账本导出
- `app.json` — 注册 `pages/ledger/ledger`

### 文档
- `DEPLOYMENT.md` — 增补 `ledgers` 集合、将云函数总数 8→9、新增测试清单
- `database/schema.json` / `database/README.md` — 已含 `ledgerId` 与 `ledgers`（Task #30 完成）

## 四、使用流程

1. 「我的」→ 共享账本（或首页「管理 ›」）→ **创建账本**，自动成为创建者并切换
2. 账本详情页：**复制邀请码** 或 **分享给微信好友**（分享卡片带 `ledgerId`，对方点开自动加入）
3. 好友输入邀请码 / 点开分享卡片 → 加入 → 自动切换该账本
4. 首页顶部胶囊 / 记账确认卡片 / 统计页只读条 均可切换账本，数据全局联动
5. 创建者可在详情页重置邀请码、移除成员、解散账本（解散级联删除该账本账目与预算）

## 五、未实跑验证项（需真实环境）

- 无 AppID 与云环境，未在真机/云控制台实跑
- 上线前需：部署 9 个云函数、创建 4 个集合并按文档设权限、`ledgers` 权限务必设为「所有用户可读，仅创建者可写」
