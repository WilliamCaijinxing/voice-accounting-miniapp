# 统计页 · 日视图改造（日历显示收支 + 走势/日历合并 + 折线图）

## 需求

1. 统计页日历中，日期数字**下方**显示每日收支金额
2. 把「趋势」和「日历」**合并成一张卡片**，可切换
3. 趋势图从柱状图改为**折线图**

## 改动清单

### 1. `miniprogram/pages/statistics/statistics.js`

| 改动 | 说明 |
|---|---|
| 新增 `dayViewMode` / `dayViewTabs` | `'calendar' \| 'trend'`，默认日历 |
| 新增 `switchDayView(e)` | 子模式切换，只改一个字段，不重新请求 |
| 移除 `dailyTrend` / `maxDailyExpense` | 柱状图数据不再需要 |
| 新增 `lineChart` | 折线图几何数据，全部在 JS 预算好 |
| 新增 `calMonthExpense` / `calMonthIncome` | 日历底部当月合计 |
| **修复** `buildCalendarGrid` | 格子补上 `expense` / `income` 原始值 |
| 新增 `buildLineChart(days)` | 折线图几何计算 |
| 新增 `niceCeil(max)` | Y 轴上限取整 |
| `shortenAmount` 补 0 值处理 | `0` → `'0'`，不再显示 `0.0` |
| `processCategoryData` / `tapMonthBar` 加 `_color` | 分类颜色预计算 |

### 2. `miniprogram/pages/statistics/statistics.wxml`

- 日视图由 3 张卡片（日历 / 趋势 / 饼图）压成 2 张（日历+走势 合并卡 / 饼图）
- 顶部 `.sub-tabs` 复用周视图的 `看日历 / 看走势` 样式
- 月份切换 `‹ 2026年8月 ›` 提到两个模式共用
- 日历格子改为**同时**渲染支出（红）与收入（绿）
- 趋势改为折线图：Y 轴刻度 + 网格线 + 面积填充 + 折线段 + 数据点 + X 轴日期

### 3. `miniprogram/pages/statistics/statistics.wxss`

- 新增 `.card-hint`、`.cal-day-amounts`、`.cal-total`、`.cal-total-item`
- 新增折线图全套：`.line-chart` `.line-y-axis` `.line-y-label` `.line-scroll` `.line-inner` `.line-plot` `.line-grid` `.line-area` `.line-seg` `.line-dot` `.line-dot-tip` `.line-x-labels` `.line-x-label`
- `.cal-cell` min-height `104rpx → 124rpx`（容纳两行金额）
- 补 `.bar-chart`（此前只被引用未定义）

## 关键实现：不用 canvas 画折线图

WXML 不支持 SVG，也没必要引入 canvas 的绘制生命周期。**用 CSS 旋转线段拼折线**：

```js
// rpx 是统一坐标系，长度与角度都在同一坐标系下计算，缩放后视觉一致
const dx = b.x - a.x;
const dyUp = b.y - a.y;                          // y 轴向上为正
width  = Math.sqrt(dx*dx + dyUp*dyUp);           // rpx
rotate = Math.atan2(-dyUp, dx) * 180 / Math.PI;  // 屏幕 y 向下为正 → 取负
```

```css
.line-seg { position:absolute; height:4rpx; transform-origin: 0 50%; }
```

`transform-origin: 0 50%` = 矩形左边中点 = 线段起点；`left/bottom` 定位起点，
`width` 是长度，`rotate` 是角度。面积填充用 `clip-path: polygon(...)` 百分比坐标，
从折线各点闭到底部。

### 顺带修掉的隐性 Bug

`buildCalendarGrid` 产出的格子**只带了格式化字符串 `_fmtExpense`，没有原始值**，
而 WXML 写的是 `wx:if="{{item.expense > 0}}"` —— 条件恒为假，所以日历里
**金额一直没显示过**。这次补上了 `expense` / `income`。

## 验证

- `node --check` 通过
- 几何算法 7 组用例全通过：31/28/30 天、全 0、单日边界；
  逐段反算终点坐标与下一点吻合（误差 < 0.01rpx）；`niceCeil` 上限恒 ≥ 实际最大值；
  顶部留白 48rpx 足够容纳数值气泡（实测最高 201rpx < 248rpx）
- 静态校验：15 个事件方法均已定义、101 个 class 均有样式、标签配平、
  20 个 `wx:for` 均有 `wx:key`、**WXML 中无函数调用**
- 预览页：`preview/statistics-day-view.html`
