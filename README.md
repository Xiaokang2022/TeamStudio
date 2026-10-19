# TeamStudio · 团队工作室

一个可本地部署的现代化「团队工作室」全栈应用：在团队（Team）内切换多个开发组（Group），围绕成员概览、任务台账与共享标签、工作量负载、数据洞察、协作日历、红黑榜、公告栏、常用链接和可切换表格/网络视图的业务责任田矩阵组织日常协作，并提供企业 SSO、细粒度管理员白名单、可热更新的 JSON 配置、与日历关联的邮件提醒，以及**内建 SMTP 邮件服务器**（无需外部邮件服务即可离线投递与查看邮件）。所有数据都支持「开发组 / 整个团队 / 全部团队」三级浏览视角。

> 技术栈：Python 3.15 + FastAPI + SQLite · React 19 + TypeScript + Vite · 原生 CSS 设计系统 · 华为鸿蒙风纸白 / 暗黑双主题 · Monaco（VS Code 同款）JSON 编辑器。前后端同源部署，单进程即可运行。

---

## 界面预览

| 纸白主题 · 团队概览 | 暗黑主题 · 团队概览 |
| --- | --- |
| ![团队概览·纸白](docs/screenshots/overview.png) | ![团队概览·暗黑](docs/screenshots/overview-dark.png) |

| 成员任务总览 / 负载 | 成员任务编辑 |
| --- | --- |
| ![任务总览](docs/screenshots/tasks.png) | ![任务编辑](docs/screenshots/task-dialog.png) |

| 成员档案与负载 | 协作日历 / 待办 |
| --- | --- |
| ![成员抽屉](docs/screenshots/member-drawer.png) | ![协作日历](docs/screenshots/calendar.png) |

| 责任田矩阵（表格） | 责任田矩阵（网络视图） |
| --- | --- |
| ![责任田矩阵](docs/screenshots/matrix.png) | ![责任田网络](docs/screenshots/matrix-network.png) |

| 责任田按成员筛选 | 红黑榜（月度） |
| --- | --- |
| ![责任田成员筛选](docs/screenshots/matrix-network-member.png) | ![红黑榜](docs/screenshots/redblack.png) |

| 数据洞察（全团队视角） | 内建邮件中心 |
| --- | --- |
| ![数据洞察](docs/screenshots/insights.png) | ![邮件中心](docs/screenshots/mail.png) |

| 任务标签 | 自绘下拉框 |
| --- | --- |
| ![任务标签](docs/screenshots/tags.png) | ![下拉框](docs/screenshots/select-open.png) |

| 纸白外观与跟随系统预览 | JSON 配置（VS Code 同款 Monaco） |
| --- | --- |
| ![外观设置](docs/screenshots/appearance.png) | ![JSON 编辑器](docs/screenshots/settings-json.png) |

| 管理台（GUI 设置） | 关于 / 模型声明 |
| --- | --- |
| ![管理台](docs/screenshots/settings.png) | ![关于弹窗](docs/screenshots/about-dialog.png) |

| 折叠侧边栏 | 登录页 |
| --- | --- |
| ![折叠侧边栏](docs/screenshots/sidebar-collapsed.png) | ![登录页](docs/screenshots/login.png) |

开发组/团队切换与浏览视角：![开发组切换](docs/screenshots/sidebar-group-switch.png) ![团队切换](docs/screenshots/sidebar-team-switch.png)

全部团队聚合视角：[概览聚合](docs/screenshots/overview-scope-all.png) · [责任田聚合](docs/screenshots/matrix-all.png) · [链接聚合](docs/screenshots/scope-all-links.png)

---

## 构建与模型声明

本项目由 **DeepSeek Flash 模型**（当前推理服务暴露的模型版本标识：`deepseek-flash`，推理强度 `high`）通过 **DeepSeek Harness `0.2.1-rc.2`** 的 Agent Team 协作完成。产品设计、前后端实现、联调与自动化验收均由模型代理执行。

应用内「关于团队工作室」弹窗（左下角信息按钮或用户菜单）可查看完整构建信息。若企业交付需要替换为指定的数字模型版本，只需修改 `web/src/components/AboutDialog.tsx` 中的 `BUILD_INFO` 常量并重新构建。

---

## 目录

- [功能清单](#功能清单)
- [成员任务与工作量负载](#成员任务与工作量负载)
- [全局浏览视角](#全局浏览视角)
- [任务标签](#任务标签开发组内共享)
- [数据统计与分析](#数据统计与分析)
- [内建邮件服务器](#内建邮件服务器)
- [构建与模型声明](#构建与模型声明)
- [快速开始](#快速开始)
- [权限模型](#权限模型)
- [企业 SSO 配置](#企业-sso-配置)
- [管理员白名单](#管理员白名单)
- [邮件提醒](#邮件提醒)
- [JSON / GUI 双模式设置](#json--gui-双模式设置)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [数据备份与安全](#数据备份与安全)
- [常见问题](#常见问题)

---

## 功能清单

| # | 需求 | 实现 |
|---|------|------|
| 1 | 团队内切换开发组 | 左上角开发组下拉框 + 左下角团队切换器；侧边栏可折叠为图标栏并记住状态；所有业务数据按 `team_id + group_id` 隔离，切换即时刷新 |
| 2 | 开发组成员概览看板 | 成员卡片展示头像、职位、角色、标签、简介、多项并行工作、当前负载与近 4 周平均负载；抽屉展示当前/历史工作与任务负载；已移除“当前状态”字段 |
| 3 | 开发组日历 + 每日待办 | 月视图、日侧栏、新建/编辑/完成/删除待办、优先级、指派成员、提醒提前天数、邮件开关 |
| 4 | 红黑榜（月度迭代） | 按月切换红榜/黑榜，月度主题、成员、上榜理由、评分；管理员可创建/编辑/滚动下月 |
| 5 | 常用链接贴板 | 分类筛选、搜索、卡片式外链、复制链接；链接按开发组维护 |
| 6 | 业务责任田矩阵 | 精简为「业务领域 / 负责人 / 备份人」；提供表格与网络图两种视图，可按成员查看其主责/备份板块，网络图区分主责实线与备份虚线 |
| 7 | 企业 SSO + 访客回退 | 标准 OIDC 授权码 + PKCE；未配置或配置不完整时自动进入只读访客模式，不阻塞浏览 |
| 8 | IP / ID 白名单管理员 | 部署设备请求始终是内置 `Admin`（不写入配置）；团队管理员、开发组管理员按范围授权；成员仅能编辑自己的资料/工作/任务/待办 |
| 9 | JSON 配置 + GUI 编辑 | `data/settings.json` 原子写入；管理台提供可视化表单 + 原始 JSON 编辑器（Schema 校验、路径级错误）；模块展示开关等 |
| 10 | 公告栏最多三条置顶 | 置顶上限可配置且硬上限 3；服务端 409/422 双重校验；公告等级、作者、时间 |
| 11 | 邮件提醒 + 内容定制 | SMTP、提醒提前天数、发送时间、附加收件人、主题/正文模板、公告聚合、自定义附加内容、测试发送、扫描日志 |
| 12 | 邮件与日历关联 | 每条日历待办独立设置提醒天数与邮件开关；后台调度器按 `(待办, 提前天数, 收件人)` 幂等去重；邮件含开发组置顶公告 |
| 13 | 成员任务台账 | 所有成员任务集中总览；进度状态（待完成 / 进行中 / 已完成）、健康状态（正常 / 延期 / 阻塞）、优先级、难易度、预期完成日期、加权负载点数；成员管理自己的任务 |
| 14 | 工作量负载量化 | 任务基础 1 分 + 优先级加成 + 难度加成；每人每周容量 15 分；统计当前与近 4 周滚动平均负载点数，分级为轻载 / 均衡 / 偏高 / 超载 |
| 15 | 高级双主题 | 华为鸿蒙风「纸白 / 暗黑」双主题，统一鸿蒙蓝强调色、柔和纸感层次、不透明浮层，全站过渡动画与「跟随系统」真实主题预览 |
| 16 | 全局浏览视角 | 侧边栏「浏览视角」在开发组 / 整个团队 / 全部团队之间切换；概览、任务、日历、链接、责任田、公告、数据分析均按 scope 聚合，条目显示所属开发组徽章 |
| 17 | 任务标签 | 每个开发组共享一套标签库，所有人可新建、改名、换色、删除；任务支持多选标签（最多 8 个），任务总览支持按标签筛选与标签库管理 |
| 18 | 数据统计与分析 | 独立「数据洞察」模块：7 项 KPI、日/周趋势柱状图、成员/开发组/团队三张可排序表格；时间跨度从近 1 周到全部时间 |
| 19 | 内建邮件服务器 | 标准库 asyncio 实现的本地 SMTP 服务器（默认 `127.0.0.1:2525`），离线投递提醒与测试邮件，设置页内置「本地邮件中心」查看 / 删除邮件；外部 SMTP 仍可选 |
| 20 | 体验细节优化 | 成员卡桌面一行 4 张、自绘无障碍下拉框、Monaco JSON 编辑器、单勾日历完成按钮、纸白主题低眩光层次、抽屉开合动画等 |

除此之外还包括：可折叠侧边栏（状态持久化）、关于弹窗与模型声明、水墨纸感层次、丝滑页面/卡片/负载条动画、响应式布局、设备管理员身份提示、审计日志、演示种子数据、API 文档、自动化测试。

---

## 成员任务与工作量负载

「任务总览」是成员共同维护的任务台账，而不是只读报表：

> 负载模型参考敏捷团队常用的「加权 Team Points + 周容量」做法（例如 [ClickUp 的 Team Points 负载思路](https://consultevo.com/clickup-keep-teams-status-green/#content#1) 与 [敏捷容量规划实践](https://ones.com/blog/agile-capacity-planning-template-a-clear-explanation-with-examples/)），用任务数量、优先级和难度推导相对负载，避免让成员凭感觉填写不可精确的工时。

- **任务字段**：标题、说明、所属成员、进度状态（待完成 / 进行中 / 已完成）、健康状态（正常 / 延期 / 阻塞）、优先级（低 / 普通 / 高 / 紧急）、难易度（简单 / 中等 / 困难）、预期完成日期。
- **个人编辑**：普通成员通过 SSO 登录后只能新增/修改/删除自己的任务；管理员（团队/开发组/设备 Admin）可管理范围内任意成员任务；访客只读。
- **单任务负载点数（1–6 分）**：基础 1 分 + 优先级加成（低 0 / 普通 1 / 高 2 / 紧急 3）+ 难度加成（简单 0 / 中等 1 / 困难 2）。这样同时反映任务数量、紧急程度和难易度，不依赖无法准确填写的小时估算。
- **当前负载**：未完成任务负载点数合计 ÷ 每人每周容量 15 分，显示为百分比与点数（例如 7 分 / 15 分）。
- **平均负载**：按最近 4 个完整 7 天窗口内活跃任务的加权负载点数计算滚动平均，用于识别持续高负载或空闲。
- **负载分级**：`< 40%` 轻载、`< 85%` 均衡、`< 110%` 偏高、其余超载。
- **界面**：总览页、成员抽屉和任务总览同时展示当前/平均负载；成员卡片支持展示多项并行进行中的工作。
- **数据一致性**：任务接口与 `member_tasks` 表由服务端校验、鉴权和审计；现有库升级时会自动补充优先级/难度字段并回填。

---

## 全局浏览视角

侧边栏的「浏览视角」提供三级数据范围，状态保存在本地并在刷新后保持：

| 视角 | 数据范围 | 典型用途 |
| --- | --- | --- |
| 开发组 | 当前选中的开发组 | 日常协作、组内任务与日历 |
| 团队 | 当前团队下全部开发组 | 团队负责人查看整体进度 |
| 全部团队 | 站点内所有团队与开发组 | 跨团队横向对比与站点级盘点 |

- 后端所有数据读取接口支持 `?scope=group|team|all`（默认 `group`，与旧版逐字段兼容），返回 `scope` 元数据；列表项携带 `groupId/groupName/teamId/teamName`，前端据此显示所属开发组徽章。
- 写入仍然组级：在聚合视角编辑/删除时，前端按条目自己的 `groupId` 路由到对应开发组；新建数据写入当前选中的开发组，并在弹窗中明确提示「将创建到：{开发组}」。
- 概览、任务总览、数据洞察、协作日历、常用链接、责任田矩阵、公告栏均已支持；红黑榜按开发组按月维护，保持组级语义。
- 示例：`GET /api/teams/team-aurora/groups/grp-frontend/overview?scope=all`。

---

## 任务标签（开发组内共享）

- 每个开发组拥有一套共享标签库（`task_tags` 表），**所有登录成员**都可以新增、重命名、换色、删除，无需管理员权限。
- 任务可绑定最多 8 个标签（`member_tasks.tags` 存标签 ID 数组），任务列表与任务弹窗以彩色 chips 展示；支持按标签筛选。
- 标签库管理弹层展示每个标签的使用次数；删除标签会自动从所有任务的引用中移除。
- 首次访问某个开发组时若无标签，会自动初始化 5 个常用标签（如「前端」「后端」「体验」「数据」「协作」）。
- API：`GET/POST /api/teams/{team}/groups/{group}/task-tags`、`PATCH/DELETE .../task-tags/{tagId}`；任务读写接受 `tagIds`。

---

## 数据统计与分析

「数据洞察」是新的独立模块（`modules.insights` 可开关），用于和任务台账互补的纵向分析：

- **7 项 KPI**：成员数、任务数、任务完成率、逾期任务、阻塞任务、平均负载、待办完成率。
- **时间跨度**：近 1 周 / 近 2 周 / 近 1 个月 / 近 3 个月 / 全部时间（后端同时支持近 2 个月）；范围越小趋势按天聚合，范围越大按周聚合（全部时间最多 26 桶）。
- **三张可排序表格**：成员表现、开发组对比、团队对比；点击表头切换升降序（`aria-sort`），并随浏览视角自动增减「开发组 / 团队」列。
- **趋势图**：纯 CSS 分组柱状图展示新建任务、完成任务、新建待办，hover/聚焦显示数值。
- 完整支持开发组 / 团队 / 全部团队三级视角；API：`GET /api/teams/{team}/groups/{group}/insights?scope=&range=1w|2w|1m|2m|3m|all`。

「任务总览」同时提供近 1 周至近 3 个月的任务窗口和多列排序（成员 / 优先级 / 难度 / 负载点数 / 预期完成 / 创建时间 / 进度 / 健康度）。

---

## 内建邮件服务器

无需外部邮箱服务即可完成提醒投递与查看：

- 后端内建一个标准库 `asyncio` 实现的轻量 SMTP 服务器，默认监听 `127.0.0.1:2525`（仅本机，随应用启动/停止，端口被占用时只记录日志、不阻塞 API）。
- `email.deliveryMode = "builtin"` 时，测试邮件和日历提醒会投递到内置服务器并写入本地邮箱（`mailbox_messages` 表），在「设置 → 邮件提醒 → 本地邮件中心」中可查看列表、正文详情、删除与刷新。
- 仍可切换为 `deliveryMode = "smtp"` 使用企业外部 SMTP（保留原有配置项）；切换后即时生效。
- 提醒调度、模板变量、公告聚合、幂等去重 `(todoId, offsetDays, recipient)` 等原有能力完全保留。

```json
{
  "email": {
    "enabled": true,
    "deliveryMode": "builtin",
    "builtin": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 2525,
      "hostname": "teamstudio.local",
      "mailboxLimit": 500,
      "retentionDays": 90
    }
  }
}
```

管理台「邮件提醒」提供投递方式切换、内置服务器运行状态 / 配置 / 重启、测试发信与本地邮件中心。API：`GET /api/email/mailbox`、`GET /api/email/mailbox/{id}`、`DELETE /api/email/mailbox/{id}`、`POST /api/email/builtin/restart`。

---

## 快速开始

> 要求：Windows + PowerShell 5.1+、Python 3.11+、Node.js 20+。本机已使用 Python 3.15 / Node 24 验证。

```powershell
# 1. 安装依赖并构建前端（国内镜像）
.\scripts\setup.ps1

# 2. 启动（默认 http://127.0.0.1:8000）
.\scripts\start.ps1
```

启动后可访问：

- 应用：<http://127.0.0.1:8000>
- API 文档：<http://127.0.0.1:8000/api/docs>
- 健康检查：<http://127.0.0.1:8000/api/health>

端口与浏览器行为：

```powershell
.\scripts\start.ps1 -Port 8080 -NoBrowser
```

### 依赖镜像说明

- Python：清华 PyPI 镜像 `https://pypi.tuna.tsinghua.edu.cn/simple`（已写入 `pip.conf` 并在脚本中显式指定）。
- npm：清华 TUNA 的 npm 镜像已停止提供（访问返回 404），因此使用国内 **npmmirror** 镜像 `https://registry.npmmirror.com/`，配置在项目根目录 `.npmrc`，脚本中同样显式指定。VS Code 同款编辑器 `monaco-editor@0.57.0` 也通过该镜像安装，worker 由 Vite 本地打包。
- 本项目未使用任何 CDN 运行时资源，Monaco 编辑器代码与 worker 全部随构建产物本地加载，字体使用系统字体，部署后无需外网。

### 目录内容

首次启动会自动创建：

```
data/
├─ settings.json        # 可视化 + JSON 双模式编辑的全部设置
├─ teamstudio.db        # SQLite 业务数据（含演示种子数据、任务标签、本地邮箱）
├─ .session_secret      # 会话签名密钥（自动生成，请勿泄露）
└─ email_outbox.jsonl   # 邮件发送审计镜像
```

想重新生成演示数据：停止服务后删除 `data/teamstudio.db` 再启动。删除 `data/settings.json` 会恢复默认设置。

---

## 权限模型

| 身份 | 判定方式 | 权限 |
|------|----------|------|
| **Admin（设备内置）** | 请求来源为部署机器本机（loopback 或本机网卡地址） | 超级管理员：所有团队/开发组内容、设置、SSO、邮件；名称固定 `Admin`，**不会出现在配置文件中** |
| **团队管理员** | 白名单 ID 或 IP，`role=team_admin` + `teamId` | 该团队全部开发组内容的完整编辑权限；不能修改全局设置 |
| **开发组管理员** | 白名单 ID 或 IP，`role=group_admin` + `groupIds` | 指定开发组内容的完整编辑权限；不能跨组、不能修改全局设置 |
| **成员** | 通过 SSO 登录，且 member 的 `external_id` 或邮箱与身份匹配 | 编辑自己的资料、自己的工作项、自己的待办；全局只读 |
| **访客** | 未登录 / SSO 未配置 / SSO 登录失败 | 只读（可浏览所有模块），可按配置关闭访客访问 |

要点：

- **设备始终拥有管理权限**：直接用浏览器访问 `127.0.0.1:8000` 或部署机本机地址时自动成为 `Admin`。这是应急恢复入口，避免误配 SSO 后锁死管理台。
- 如果服务部署在中心服务器、由其他电脑访问，浏览器所处电脑并非“部署设备”，此时请通过 ID/IP 白名单授予管理员。
- 成员资料中的 `external_id` 与 SSO 的 `sub` / `id` 对齐即可获得“本人可编辑”能力。演示数据使用 `lin.zhixia@corp.example` 等邮箱作为 ID。
- 删除成员、修改公告等管理操作都会写入审计日志（`features.auditLog` 可关闭）。

---

## 企业 SSO 配置

管理台 →「团队与权限 → 企业 SSO」，或直接编辑 JSON：

```json
{
  "auth": {
    "sso": {
      "enabled": true,
      "providerName": "企业 SSO",
      "issuer": "https://sso.example.com",
      "clientId": "teamstudio",
      "clientSecret": "请填写应用密钥",
      "scopes": "openid profile email",
      "redirectUri": "http://127.0.0.1:8000/api/auth/callback",
      "claimId": "sub",
      "claimName": "name",
      "claimEmail": "email",
      "allowedEmailDomains": ["corp.example"],
      "authorizationEndpoint": "",
      "tokenEndpoint": "",
      "userinfoEndpoint": "",
      "endSessionEndpoint": ""
    }
  }
}
```

- 默认使用 OIDC Discovery：`{issuer}/.well-known/openid-configuration`；若企业 IdP 不提供 discovery，可手动填写三个端点。
- 登录流程：授权码 + PKCE（S256）+ state + nonce；会话写入 HMAC-SHA256 签名的 HttpOnly Cookie。
- 配置不完整（缺 issuer/clientId/clientSecret/redirectUri）或未启用时，登录入口自动回退到访客模式，并在界面提示原因。
- 从其他电脑访问时，回调地址必须使用实际可访问的 URL（反向代理 HTTPS 时同步修改 `redirectUri`，并把 `auth.session.secureCookie` 设为 `true`）。

---

## 管理员白名单

管理台 →「团队与权限」可视化维护，也可编辑 JSON。白名单分为 IP 与 ID 两组，均支持 `team_admin` / `group_admin` 两种角色。

```json
{
  "auth": {
    "adminWhitelist": {
      "ips": [
        {
          "ip": "10.20.0.0/16",
          "name": "研发楼层",
          "role": "group_admin",
          "teamId": "team-aurora",
          "groupIds": ["grp-frontend", "grp-platform"],
          "note": "办公网段"
        }
      ],
      "ids": [
        {
          "id": "lin.zhixia@corp.example",
          "name": "林知夏",
          "role": "team_admin",
          "teamId": "team-aurora",
          "groupIds": [],
          "note": "星港产品团队负责人"
        },
        {
          "id": "su.wan@corp.example",
          "name": "苏晚",
          "role": "group_admin",
          "teamId": "team-aurora",
          "groupIds": ["grp-frontend"],
          "note": "前端体验组管理员"
        }
      ]
    }
  }
}
```

- IP 支持单 IP 和 CIDR；ID 会与 SSO 的 `id`、邮箱、`sub` 匹配（忽略大小写）。
- `team_admin` 必须填 `teamId`；`group_admin` 至少填一个 `groupIds`，否则配置校验失败。
- 内置 `Admin` 不在白名单中，无法被删除，也不会写入 JSON。

---

## 邮件提醒

管理台 →「邮件提醒」，或修改 JSON 的 `email` 节点。

```json
{
  "email": {
    "enabled": true,
    "deliveryMode": "smtp",
    "builtin": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 2525,
      "hostname": "teamstudio.local",
      "mailboxLimit": 500,
      "retentionDays": 90
    },
    "smtp": {
      "host": "smtp.corp.example",
      "port": 587,
      "username": "teamstudio@corp.example",
      "password": "应用专用密码",
      "fromEmail": "teamstudio@corp.example",
      "fromName": "星港团队工作室",
      "useStartTls": true,
      "useSsl": false,
      "timeoutSeconds": 15
    },
    "reminders": {
      "enabled": true,
      "offsetsDays": [3, 1, 0],
      "sendTime": "09:00",
      "scanIntervalSeconds": 60,
      "notifyAssignee": true,
      "additionalRecipients": ["pm@corp.example"],
      "includeAnnouncements": true,
      "includeTodoDescription": true,
      "includeExtra": true,
      "extraContent": "请及时同步进度；如遇阻塞，请在开发组日历中更新状态。",
      "subjectTemplate": "[{{siteName}}] {{groupName}} · {{todoTitle}} 将于 {{dueDate}} 到期",
      "bodyTemplate": "{{memberName}} 你好：\n\n事项：{{todoTitle}}\n截止：{{dueDate}} {{dueTime}}\n优先级：{{priority}}\n\n{{announcements}}\n\n{{extraContent}}"
    }
  }
}
```

工作方式：

1. 投递方式由 `email.deliveryMode` 决定：`builtin`（默认，使用内建 SMTP 服务器，离线可用）或 `smtp`（企业外部邮箱）。
2. 每条待办保存自己的 `reminderOffsetsDays`（如 `[3, 1, 0]`）和 `emailEnabled` 开关；未单独设置时使用全局默认。
3. 后台调度器按 `sendTime` 扫描：在“截止日期 − 提前天数”的当天发送；提前 0 天表示截止当天发送。
4. 以 `(todoId, offsetDays, recipient)` 唯一定位，重启、重试、手动扫描都不会重复发送。
5. 收件人默认是待办指派成员；可关闭 `notifyAssignee` 或追加 `additionalRecipients`。
6. 邮件内容自动附加该开发组置顶公告（最多 3 条）和自定义附加内容；所有模板变量均可配置。
7. 管理台支持「测试发信」「立即扫描」、查看扫描状态与发送日志；内置模式下的邮件同时进入「本地邮件中心」。

可用模板变量：`{{siteName}}` `{{teamName}}` `{{groupName}}` `{{memberName}}` `{{todoTitle}}` `{{todoDescription}}` `{{dueDate}}` `{{dueTime}}` `{{priority}}` `{{announcements}}` `{{extraContent}}`。

> SMTP 密码以明文保存在 `data/settings.json`（这是“JSON 可直接编辑”需求的取舍）。请使用应用专用密码，限制数据目录权限，并避免把该文件提交到版本库。内置模式不需要填写任何 SMTP 密码。

---

## JSON / GUI 双模式设置

所有设置都在 `data/settings.json`，服务端 Pydantic 模型强校验并原子写盘。管理台提供：

- **GUI 模式**：站点/主题、模块开关、公告置顶策略、日历默认值、红黑榜文案、功能开关、SSO、白名单、邮件投递方式（内置 / SMTP）、提醒模板、收件人。主题固定为鸿蒙纸白/暗黑双模式与统一色板。
- **高级 JSON 模式**：完整设置对象，VS Code 同款 Monaco 编辑器（行号、语法高亮、错误波浪线），支持格式化、后端 Schema 校验、逐路径错误提示、校验通过后保存。
- **Schema**：管理台可下载/查看，或访问 `GET /api/settings/schema`（仅超级管理员）。
- **模块隐藏**：`modules.overview/tasks/insights/calendar/redblack/links/matrix/announcements/settings/email` 控制侧栏入口；隐藏后普通成员直接访问路由会看到隐藏提示，管理员仍可进入设置恢复。
- **保存即时生效**：主题、模块可见性、日历默认值、邮件策略会立即应用；邮件后台调度器下一轮读取新配置。

主要配置节点：

```
site             站点名称、标语、logo、页脚、主题（纸白/暗黑/跟随系统、圆角）
modules          模块展示开关（概览/任务/数据洞察/日历/红黑榜/链接/矩阵/公告/设置/邮件）
announcements    置顶上限 0-3、首页条数
calendar         周起始日、是否显示周末、默认提醒天数、默认提醒时间
redblack         红黑榜标题、是否显示评分、月度主题
email            投递方式（内置/SMTP）、内置服务器参数、SMTP、提醒策略、模板、附加内容
auth             SSO、访客模式、管理员白名单、会话 Cookie
features         成员自编辑、访客横幅、演示标识、审计、访客创建待办
```

任何未知字段、类型错误、范围错误都会被拒绝，不会写入文件。

---

## 项目结构

```
TeamStudio/
├─ backend/
│  ├─ app/
│  │  ├─ main.py              # FastAPI 入口、静态前端托管、异常格式、生命周期
│  │  ├─ config.py            # Pydantic 配置 Schema、原子 JSON 存储
│  │  ├─ db.py                # SQLite Schema 与连接（任务标签 / 本地邮箱表）
│  │  ├─ scope.py             # 开发组 / 团队 / 全部团队读取范围解析
│  │  ├─ auth.py              # 本机 Admin、会话、IP/ID 权限
│  │  ├─ sso.py               # OIDC Discovery + 授权码 + PKCE
│  │  ├─ seed.py              # 演示团队/成员/工作/待办/榜单/任务数据
│  │  ├─ routers/             # auth/bootstrap/settings/email/workspace/calendar/boards/tasks/insights
│  │  └─ services/            # 内置 SMTP 服务器、外部 SMTP、提醒扫描、任务负载、洞察聚合、调度
│  └─ tests/                  # 80 个 pytest 用例（API / 权限 / SSO / 邮件 / 任务 / 标签 / 视角 / 洞察）
├─ web/
│  ├─ src/
│  │  ├─ pages/               # 概览、任务总览、数据洞察、日历、红黑榜、链接、矩阵、公告、设置、登录
│  │  ├─ components/          # AppShell、成员抽屉、任务弹窗、标签选择、下拉框、Monaco 编辑器等
│  │  ├─ api.ts / types.ts    # 类型化 API 客户端
│  │  ├─ store.tsx            # 工作区上下文、主题、团队/开发组切换、浏览视角
│  │  └─ styles.css           # 鸿蒙风纸白/暗黑设计系统
│  ├─ e2e/                    # Playwright 冒烟 / 任务 / 侧栏 / 集成 QA / 截图脚本
│  └─ dist/                   # 构建产物（由 FastAPI 托管）
├─ data/                      # 运行时数据（首次启动生成）
├─ scripts/                   # setup / build / start / verify
├─ CONTRACT.md                # 前后端 API 契约
├─ TASKS_CONTRACT.md          # 任务台账 / 标签 / 视角 / 洞察契约
└─ README.md
```

---

## 开发与测试

```powershell
# 后端测试（80 个用例）
.\.venv\Scripts\python.exe -m pytest backend\tests -q

# 前端类型检查 / 构建（构建包含 Monaco 独立 chunk 与本地 worker）
npm run typecheck --prefix web
npm run build --prefix web

# 一键验证（测试 + 类型检查 + 构建）
.\scripts\verify.ps1

# 浏览器端冒烟测试（需先启动后端，使用系统 Edge）
npm run e2e:smoke --prefix web
npm run e2e:tasks --prefix web
npm run e2e:sidebar --prefix web
# 优化轮次集成 QA（25 项断言：主题/视角/标签/洞察/下拉/日历/编辑器/邮件）
npm run e2e:qa --prefix web
# 专项验证脚本
npm run e2e:select --prefix web
npm run e2e:tags --prefix web
npm run e2e:insights --prefix web
npm run e2e:mail --prefix web
# 全页面截图（输出到 artifacts/）
npm run e2e:screenshots --prefix web
# 刷新 README 截图（输出到 docs/screenshots/）
npm run e2e:docs-shots --prefix web
```

E2E 覆盖：成员抽屉、团队/开发组切换、日历待办增删、公告发布删除、设置各标签页、JSON 双模式校验与恢复（Monaco）、任务台账筛选与增删改（优先级 / 难度 / 负载点数 / 时间跨度 / 排序）、标签 CRUD 与筛选、数据洞察范围与排序、浏览视角聚合、自绘下拉框、内置邮件中心、成员负载展示、侧栏折叠、关于弹窗、纸白/暗黑主题切换。

> 集成 QA 脚本默认访问 `http://127.0.0.1:8000`，可用 `QA_URL=http://127.0.0.1:5173` 指向 Vite 开发服务器；`TEAMSTUDIO_URL` 可指定冒烟脚本目标。

前后端分离开发：

```powershell
# 终端 1：后端（带热重载）
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload --port 8000

# 终端 2：Vite（自动代理 /api 到 8000）
npm run dev --prefix web
# 访问 http://127.0.0.1:5173
```

Vite 开发模式仍通过 `/api` 代理访问后端；生产由 FastAPI 直接托管 `web/dist`。

---

## 数据备份与安全

- 备份三件套：`data/teamstudio.db`、`data/settings.json`、`data/.session_secret`。SQLite 使用 WAL，建议停机备份或使用 SQLite 在线备份。任务标签库、本地邮箱（`task_tags` / `mailbox_messages`）都在 SQLite 中，随数据库一起备份。
- 部署设备本机访问自动获得 `Admin` 是为了防止锁死；**不要把 8000 端口无保护地暴露到公网**。
- 内置邮件服务器默认只监听 `127.0.0.1:2525`（仅本机），不会对外暴露；如需跨机收信请改为受控地址并配合防火墙。
- 中心化部署时建议：
  1. 配置企业 SSO + 至少一个 ID 白名单管理员；
  2. 通过反向代理启用 HTTPS；
  3. 将 `auth.session.secureCookie` 设为 `true`；
  4. 正确设置代理来源 IP（默认不信任 `X-Forwarded-For`，避免伪造本机/白名单 IP）。
- 反向代理与设备 Admin：默认情况下，带 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` 请求头的请求**不会**被当作部署设备，避免同机 Nginx 等代理让所有访问者继承 Admin。设备管理员应通过直连 `127.0.0.1:8000` 访问；如需信任代理，显式设置环境变量 `TEAMSTUDIO_TRUST_PROXY=1` 并确保代理会覆盖客户端传入的转发头。
- 访客默认只读。可在设置中关闭访客访问（`auth.guestMode=false` + `auth.allowGuestRead=false`）。
- 邮件日志中的收件邮箱经过脱敏；SMTP 密码不会出现在日志中。

---

## 常见问题

**Q：页面显示“前端尚未构建 / 只能访问 API”？**  
运行 `.\scripts\build.ps1`，确认 `web\dist\index.html` 存在后重启。

**Q：为什么从另一台电脑打开没有 Admin 权限？**  
内置 Admin 只对部署设备本机请求生效。请在「团队与权限」中按 IP 或 SSO ID 添加管理员。

**Q：SSO 已开启但还是访客？**  
检查 issuer/clientId/clientSecret/redirectUri 是否齐全、回调地址是否与控制台一致、IdP 是否允许该回调；管理台会显示具体错误原因。

**Q：邮件测试失败？**  
先确认 `email.enabled=true`。内置模式（`deliveryMode=builtin`）会使用本地 SMTP 服务器，无需填写 SMTP 账号；若提示服务未运行，在「邮件提醒」中点击「重启内置服务」。外部模式（`deliveryMode=smtp`）需填写 SMTP `host/fromEmail`；企业邮箱通常需要“应用专用密码”，587 端口用 STARTTLS，465 端口用 SSL（二者不要同时开启）。

**Q：想清空演示数据？**  
停止服务，删除 `data/teamstudio.db`，重新启动即可重建演示数据；`data/settings.json` 不受影响。

**Q：Node/Python 安装慢？**  
项目已使用国内镜像。若需手动安装：`pip install -i https://pypi.tuna.tsinghua.edu.cn/simple ...` / `npm install --registry https://registry.npmmirror.com/ ...`。
