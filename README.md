# 语音记账微信小程序

基于**微信云开发**的语音记账小程序：一句话语音即可记账，支持**多人共享账本**与**多 LLM 响应对比分析**。

## 功能特性

- 🎙️ **语音记账**：说话即记账，自动识别金额、分类、收支类型
- 👥 **多人共享账本**：邀请码 / 微信分享卡片加入，全员可读写，显示记账人
- 📊 **统计报表**：日 / 周 / 月 / 年四维度，日历视图（每日收支）+ 折线走势图 + 支出分类
- 💰 **预算与消费分析**：月度预算、超支预警、智能建议
- 🤖 **LLM 对比**：统一接口调用多个大模型（DeepSeek / GLM / Qwen 等），对比同一 prompt 下的回复

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 微信小程序原生（WXML / WXSS / JS） |
| 后端 | 微信云开发（云函数 + 云数据库 + 云存储） |
| 大模型 | 硅基流动（SiliconFlow）平台免费模型 |
| 语音识别 | 腾讯云 ASR（SentenceRecognition） |

## 目录结构

```
voice-accounting-miniapp/
├── miniprogram/            # 小程序前端
│   ├── pages/              # 页面：首页/记账/明细/统计/预算/导出/账本/我的
│   ├── components/         # 自定义组件
│   └── utils/              # 云调用封装、格式化工具
├── cloudfunctions/         # 9 个云函数
│   ├── expenseCRUD/        # 记账增删改查
│   ├── budgetCRUD/         # 预算
│   ├── statistics/         # 统计聚合
│   ├── parseVoice/         # 语音文本解析为结构化账目
│   ├── voiceToText/        # 音频转文本 + 解析（含预热优化）
│   ├── voiceASR/           # 腾讯云语音识别
│   ├── exportData/         # 导出 CSV
│   ├── groupCRUD/          # 多人账本
│   └── userLogin/          # 登录
├── database/               # 集合结构定义（schema.json）+ 示例数据说明
└── docs/                   # 架构与部署说明（见各 .md）
```

## 环境配置

1. 微信开发者工具导入 `miniprogram` 目录
2. 开通云开发，设置环境 ID
3. 在云函数环境变量中配置（**不要写进代码**）：
   - `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`：腾讯云 ASR 密钥
   - SiliconFlow API Key：大模型调用
4. 上传并部署全部云函数，导入 `database/schema.json` 定义

## 安全说明

- 密钥一律通过云函数环境变量读取（`process.env`），代码库内不含任何明文密钥
- 运行数据（`database/*.json` 示例）已忽略，仅保留 schema 与说明

## 文档

- `ARCHITECTURE.md`：整体架构
- `DEPLOYMENT.md`：部署与配置
- `MULTI_LEDGER_IMPLEMENTATION.md`：多人共享账本实现
- `BUGFIX_ROUND2.md` / `STATS_DAYVIEW_REDESIGN.md`：历史修复与改造记录
