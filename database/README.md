# 数据库集合导入指南

## 需要创建的集合

| 集合名 | 说明 | 导入文件 |
|--------|------|----------|
| `expenses` | 账目记录 | `database/expenses.json` |
| `users` | 用户信息 | `database/users.json` |
| `budgets` | 预算设置 | `database/budgets.json` |
| `ledgers` | 共享账本 | `database/ledgers.json`（可选，建议在小程序内创建） |

## 导入步骤

### 方式一：通过微信开发者工具导入（推荐）

1. 打开微信开发者工具 → 点击顶部「云开发」按钮进入云开发控制台
2. 左侧菜单选择「数据库」
3. 点击「添加集合」，分别创建 `expenses`、`users`、`budgets` 和 `ledgers` 四个集合
4. 进入 `expenses` 集合 → 点击「导入」→ 选择 `database/expenses.json`
5. 进入 `users` 集合 → 点击「导入」→ 选择 `database/users.json`
6. 进入 `budgets` 集合 → 点击「导入」→ 选择 `database/budgets.json`
7. 进入 `ledgers` 集合 → （推荐）**无需导入数据**，直接在小程序「账本管理」页创建；如需结构参考可导入 `database/ledgers.json`（注意：示例记录的 ownerOpenid 为空，导入后请删除该示例，重新在小程序内创建真实账本）
8. 导入格式选择 **JSON Lines**（每行一条记录）

### 方式二：通过云开发网页控制台导入

1. 访问 https://console.cloud.tencent.com/tcb
2. 选择对应环境 → 数据库
3. 同方式一步骤 3-6

## 导入后设置索引

导入数据后，必须为高频查询场景创建索引，否则云函数查询会报错：

### expenses 集合索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_openid_date` | `_openid`(asc) + `date`(desc) | 按用户和时间查询账目列表 |
| `idx_openid_type_date` | `_openid`(asc) + `type`(asc) + `date`(desc) | 按用户、类型、时间筛选 |
| `idx_openid_category` | `_openid`(asc) + `categoryId`(asc) | 按用户和分类筛选 |

### users 集合索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_openid` | `_openid`(asc) | 按 openid 查询用户 |

### budgets 集合索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_openid_ym` | `_openid`(asc) + `ym`(asc) | 按用户和月份查询预算（月度/年度查询均依赖此索引） |
| `idx_ledger_ym` | `ledgerId`(asc) + `ym`(asc) | 按共享账本和月份查询预算 |

### expenses 集合新增索引（多人记账）

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_ledger_date` | `ledgerId`(asc) + `date`(desc) | 按共享账本和时间查询账目 |

### ledgers 集合索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_invite_code` | `inviteCode`(asc) | 邀请码唯一索引，用于加入账本时校验 |
| `idx_owner` | `ownerOpenid`(asc) | 按创建者查询其创建的账本 |

### 创建索引步骤

1. 云开发控制台 → 数据库 → 选择集合
2. 点击「索引管理」标签页
3. 点击「添加索引」
4. 按上表配置索引字段和排序方向
5. 保存

## 权限设置

- `expenses`、`users`、`budgets` 三个集合的权限应设置为：**仅创建者可读写**
- `ledgers` 集合权限应设置为：**所有用户可读，仅创建者可写**（成员列表需对所有人可见；所有写操作如创建/加入/退出均走云函数，不受前端权限限制）

设置路径：云开发控制台 → 数据库 → 集合 → 权限设置

## 数据格式说明

- `amount` 字段单位为**分**（100 = 1元），前端展示时除以 100
- `date` 字段格式为 `YYYY-MM-DD`
- `type` 字段取值：`expense`（支出）/ `income`（收入）
- `categoryId` 可选值：`food`(餐饮) / `transport`(交通) / `shopping`(购物) / `drinks`(饮品) / `entertainment`(娱乐) / `housing`(住房) / `communication`(通讯) / `medical`(医疗) / `education`(教育) / `salary`(工资) / `other`(其他)

### budgets 集合说明

| 字段 | 说明 |
|------|------|
| `type` | 预算类型：`month`（月度）/ `year`（年度） |
| `ym` | 月份标识 `YYYY-MM`（年度预算为 `YYYY-00`） |
| `year` / `month` | 年份 / 月份（年度预算 `month` 为 0） |
| `amount` | 预算金额，单位**分**（示例：300000 = 3000元） |

> `budgets.json` 中的示例数据可直接导入体验功能：
> - 2026-08 月度预算 3000 元
> - 2026 年度预算 36000 元
> - 2026-07 月度预算 2500 元
>
> 正式使用前可在云开发控制台删除示例记录，或直接在「预算设置」页面重新设置（会覆盖为新的预算值）。

### ledgers 集合说明（共享账本）

| 字段 | 说明 |
|------|------|
| `name` | 账本名称（如「家庭账本」「合租账本」） |
| `ownerOpenid` | 创建者 openid，拥有管理权限（移除成员、重生成邀请码） |
| `members` | 成员数组，每项 `{ openid, nickname, avatar, role, joinedAt }`；`role` 取值 `owner` / `member` |
| `inviteCode` | 6 位大写字母数字邀请码（唯一索引），用于好友输入码加入 |
| `createdAt` | 创建时间 |

> 共享账本通过小程序「账本管理」页创建，创建后自动生成 6 位邀请码；其他人可通过「输入邀请码」或「微信分享卡片」加入。全员可读写（家庭/情侣/合租场景）。

### expenses / budgets 新增 ledgerId 字段

多人记账后，账目与预算通过 `ledgerId` 区分归属：

- `ledgerId` 为空（或不存在）→ **个人账本**，仅本人可见
- `ledgerId` 非空 → **共享账本**，账本成员可见、可编辑

> 历史数据（无 `ledgerId` 字段）自动归为个人账本，无需迁移。
