# TeamStudio · 团队工作室

一个可本地部署的现代化「团队工作室」全栈应用：在团队（Team）内切换多个开发组（Group），围绕成员概览、任务台账与共享标签、工作量负载、数据洞察、协作日历、红黑榜、公告栏、常用链接和可切换表格/网络视图的业务责任田矩阵组织日常协作；提供免密码的**邮箱验证码注册与登录**、个人主页与头像上传、分层的权限与设置（超级管理员 / 团队管理员 / 开发组管理员 / 成员）、可选的**企业 SSO**、可热更新的 JSON 配置，以及**仅通过外部 SMTP 中继**投递验证码邮件（不内置邮件服务器，也不发送日历邮件提醒）。浏览视角支持「开发组 / 当前团队 / 所有团队」，所有身份均可自由切换；主题默认跟随系统，责任田支持唯一主责 + 多位备份，成员负载可点击查看逐任务明细。

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

| 责任田矩阵（描述列 + 多备份） | 责任田矩阵（网络视图） |
| --- | --- |
| ![责任田矩阵](docs/screenshots/matrix.png) | ![责任田网络](docs/screenshots/matrix-network.png) |

| 工作区管理（团队 / 开发组增删） | 成员负载详情（逐任务拆解） |
| --- | --- |
| ![工作区管理](docs/screenshots/workspace-manager.png) | ![成员负载详情](docs/screenshots/workload-detail.png) |

| 责任田按成员筛选 | 红黑榜（月度） |
| --- | --- |
| ![责任田成员筛选](docs/screenshots/matrix-network-member.png) | ![红黑榜](docs/screenshots/redblack.png) |

| 数据洞察（当前团队视角） | 任务标签 |
| --- | --- |
| ![数据洞察](docs/screenshots/insights.png) | ![任务标签](docs/screenshots/tags.png) |

| 自绘下拉框 | 标签库管理 |
| --- | --- |
| ![下拉框](docs/screenshots/select-open.png) | ![标签库](docs/screenshots/tag-library.png) |

| 纸白外观与跟随系统预览 | JSON 配置（VS Code 同款 Monaco） |
| --- | --- |
| ![外观设置](docs/screenshots/appearance.png) | ![JSON 编辑器](docs/screenshots/settings-json.png) |

| 管理台（GUI 设置） | 关于 / 模型声明 |
| --- | --- |
| ![管理台](docs/screenshots/settings.png) | ![关于弹窗](docs/screenshots/about-dialog.png) |

| 系统重置（仅设备管理员可见） | 最终确认：逐字输入完整站点名称 |
| --- | --- |
| ![系统重置](docs/screenshots/system-reset.png) | ![输入完整站点名称](docs/screenshots/system-reset-confirm.png) |

| 折叠侧边栏 | 登录页（邮箱验证码） |
| --- | --- |
| ![折叠侧边栏](docs/screenshots/sidebar-collapsed.png) | ![登录页](docs/screenshots/login.png) |

开发组/团队切换：![开发组切换](docs/screenshots/sidebar-group-switch.png) ![团队切换](docs/screenshots/sidebar-team-switch.png)

所有团队聚合视角：[概览聚合](docs/screenshots/overview-scope-all.png) · [责任田聚合](docs/screenshots/matrix-all.png) · [链接聚合](docs/screenshots/scope-all-links.png)

---

## 构建与模型声明

本项目由 **DeepSeek Flash 模型**（当前推理服务暴露的模型版本标识：`deepseek-flash`，推理强度 `high`）通过 **DeepSeek Harness `0.2.1-rc.2`** 的 Agent Team 协作完成。产品设计、前后端实现、联调与自动化验收均由模型代理执行。

应用内「关于团队工作室」弹窗（左下角信息按钮或用户菜单）可查看完整构建信息。若企业交付需要替换为指定的数字模型版本，只需修改 `web/src/components/AboutDialog.tsx` 中的 `BUILD_INFO` 常量并重新构建。

---

## 目录

- [功能清单](#功能清单)
- [账号与登录](#账号与登录)
- [个人主页与成员资料](#个人主页与成员资料)
- [成员任务与工作量负载](#成员任务与工作量负载)
- [全局浏览视角](#全局浏览视角)
- [任务标签](#任务标签开发组内共享)
- [数据统计与分析](#数据统计与分析)
- [快速开始](#快速开始)
- [权限模型](#权限模型)
- [企业 SSO 配置](#企业-sso-配置)
- [管理员白名单](#管理员白名单)
- [邮件服务（SMTP 中继）](#邮件服务smtp-中继)
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
| 3 | 协作日历 + 每日待办 | 月视图、日侧栏、新建/编辑/完成/删除待办、优先级、指派成员；不再包含邮件提醒相关设置 |
| 4 | 红黑榜（月度迭代） | 按月切换红榜/黑榜，月度主题、成员、上榜理由、评分；管理员可创建/编辑/滚动下月；团队与所有团队视角为只读汇总，并标注所属开发组 |
| 5 | 常用链接贴板 | 分类筛选、搜索、卡片式外链、复制链接；链接按开发组维护 |
| 6 | 业务责任田矩阵 | 精简为「业务领域 / 描述 / 负责人 / 备份成员」；提供表格与网络图两种视图，可按成员查看其主责/备份板块，网络图区分主责实线与备份虚线；**每块责任田只有一个主责，但可以配置多位备份**，同一成员也可同时负责或备份多块责任田 |
| 7 | 邮箱验证码账号体系 | 免密码注册与登录：邮箱 → 六位验证码 → 登录；任意有效邮箱可自助注册为成员；超级管理员可预创建账号（角色 + 团队/开发组范围），创建时同步返回一次性激活链接并自动复制到剪贴板，打开链接即自动激活并登录（默认 10 分钟内有效，可在设置中调整，无需邮箱验证码与 SMTP） |
| 8 | 个人主页与头像 | 用户菜单「个人主页」聚合账号资料与所链接开发组的责任田、当前/历史任务、待办与红黑榜记录；支持上传头像（PNG/JPEG/WebP/GIF，≤2MB）、恢复默认头像、修改用户名、简介、头像颜色与技能标签 |
| 9 | 账号与角色管理 | 超级管理员可在「系统设置 → 账号与角色」中创建、授权、改角色/范围、删除账号；创建预创建账号时同步生成一次性激活链接并自动复制到剪贴板，激活链接卡片支持点击复制、重新生成，复制失败会明确提示并选中链接供手动复制（默认 10 分钟有效）；部署设备内置 Admin 只读展示、不可管理 |
| 10 | 分层权限与设置 | 站点级设置（外观、模块、登录、账号、SSO、邮件、JSON）仅超级管理员可见；团队/开发组管理员只看到领域级「工作区设置」，按授权范围编辑团队与开发组的基础信息 |
| 11 | 企业 SSO + 访客回退 | 标准 OIDC 授权码 + PKCE；作为可选的第二种登录方式，配置后在登录页提供「使用企业 SSO 登录」；未配置或配置不完整时自动进入只读访客模式，不阻塞浏览 |
| 12 | IP / ID 白名单管理员 | 作为 SSO / IP 身份的补充授权路径：按 IP 或身份 ID 授予团队管理员、开发组管理员范围；部署设备默认是内置 `Admin`，退出后可按普通账号访问 |
| 13 | JSON 配置 + GUI 编辑 | `data/settings.json` 原子写入；管理台提供可视化表单 + 原始 JSON 编辑器（Schema 校验、路径级错误）；模块展示开关等 |
| 14 | 公告栏最多三条置顶 | 置顶上限可配置且硬上限 3；服务端 409/422 双重校验；公告等级、作者、时间 |
| 15 | 邮件服务（SMTP 中继） | 仅使用外部 SMTP 中继投递账号验证码：服务器 IP/域名、端口、账号、密码、发件邮箱/名称、STARTTLS 或 SSL、超时；提供状态、发送日志与测试发信 |
| 16 | 成员任务台账 | 所有成员任务集中总览；进度状态（待完成 / 进行中 / 已完成）、健康状态（正常 / 延期 / 阻塞）、优先级、难易度、预期完成日期、加权负载点数；成员管理自己的任务 |
| 17 | 工作量负载量化 | 任务基础 1 分 + 优先级加成 + 难度加成；每人每周容量 15 分；统计当前与近 4 周滚动平均负载点数，分级为轻载 / 均衡 / 偏高 / 超载 |
| 18 | 高级双主题 | 华为鸿蒙风「纸白 / 暗黑」双主题，统一鸿蒙蓝强调色、柔和纸感层次、不透明浮层，全站过渡动画；**默认跟随系统明暗偏好**，访问者手动切换后按浏览器本地记忆 |
| 19 | 全局浏览视角 | 侧边栏「浏览视角」在开发组 / 当前团队之间切换；概览、任务、日历、链接、责任田、公告、数据分析均按 scope 聚合，条目显示所属开发组徽章；**所有身份均可使用「所有团队」视角** |
| 20 | 任务标签 | 每个开发组共享一套标签库，所有人可新建、改名、换色、删除；任务支持多选标签（最多 8 个），任务总览支持按标签筛选与标签库管理 |
| 21 | 数据统计与分析 | 独立「数据洞察」模块：7 项 KPI、日/周趋势柱状图、成员/开发组/团队三张可排序表格；时间跨度从近 1 周到全部时间 |
| 22 | 成员负载明细 | 任务总览的「成员负载」卡片可点击：查看该成员当前 / 平均负载、周容量、阻塞与逾期，以及每项任务的「基础 + 优先级 + 难度」点数构成；可直接在台账中筛选该成员或打开成员档案 |
| 23 | 工作区结构管理 | 用户菜单「工作区管理」：按权限域创建 / 删除团队与开发组，展示成员与开发组数量；删除使用输入完整名称的二次确认，级联清理该范围内的业务数据并写入审计 |
| 24 | 体验细节优化 | 成员卡桌面一行 4 张、自绘无障碍下拉框、Monaco JSON 编辑器、单勾日历完成按钮、纸白主题低眩光层次、抽屉开合动画、统一的登录/个人主页视觉等 |
| 25 | 系统重置（设备管理员专属） | 「系统设置 → 重置系统」仅部署设备内置 Admin 可见（存储的超级管理员账号看不到、也无接口权限）；双重确认：先弹窗询问是否重置，再要求完整输入当前站点名称才解锁最终按钮；确认后恢复全部默认设置、清空团队/成员/任务/待办/账号/日志/头像等所有数据并轮换会话密钥（所有人登录失效），重启服务也不会重新灌入演示数据 |

除此之外还包括：可折叠侧边栏（状态持久化）、关于弹窗与模型声明、水墨纸感层次、丝滑页面/卡片/负载条动画、响应式布局、超级管理员身份提示、审计日志、演示种子数据、API 文档、自动化测试。

---

## 账号与登录

默认登录方式为**邮箱验证码**，无需密码；企业 SSO 作为可选的第二种方式保留。

1. 打开登录页 `/#/login`，输入邮箱，点击「发送验证码」；后端向该邮箱发送六位数字验证码（默认 10 分钟有效，60 秒内不可重复发送，最多尝试 5 次，均可在设置中调整）。
2. 输入验证码完成登录。未注册的邮箱会自动创建为「成员」账号；超级管理员预创建的账号会获得一次性激活链接，打开链接即自动激活并登录（默认 10 分钟有效，可在设置中调整），无需邮箱验证码，也不依赖 SMTP。
3. 登录成功后写入 HMAC-SHA256 签名的 HttpOnly 会话 Cookie；**会话默认 7 天滑动续期**：每次访问 `/api/bootstrap` 或 `/api/auth/me` 都会重新签发，从最近一次访问重新计时。有效期可在「系统设置 → 成员与权限 → 登录状态保持天数」中调整。
4. 登录页始终提供「以访客身份浏览」；配置了企业 SSO 时还会显示「使用企业 SSO 登录」。访客不会被自动跳转到登录页。
5. 在部署设备本机打开登录页时，会额外显示「以设备管理员身份登录」按钮（无需邮箱）。设备管理员也可以先退出当前身份、改用其他邮箱账号登录；该账号只拥有自己的角色权限，不会附带设备管理权限，之后可随时通过按钮恢复内置 `Admin`。

相关 API：`POST /api/auth/email/request`、`POST /api/auth/email/verify`、`GET /api/auth/activate?token=`（预创建账号一次性激活链接）、`GET /api/auth/config`、`GET /api/auth/me`、`POST /api/auth/logout`、`POST /api/auth/device/login`、`POST /api/users/{id}/activation-link`（超级管理员重新生成激活链接）；SSO 仍为 `GET /api/auth/login`、`/api/auth/callback`。验证码只保存 HMAC 哈希，不保存明文、不写入日志；激活令牌仅保存 SHA-256 哈希。未配置 SMTP 时普通邮箱登录接口返回 `503 email_not_configured`，但预创建账号仍可通过激活链接正常激活登录。

---

## 个人主页与成员资料

- 用户菜单 →「个人主页」（`#/profile`）展示账号头像、用户名、邮箱、角色徽章，以及按邮箱关联的开发组成员记录：责任田、当前任务、历史任务、待办与红黑榜记录（均带开发组 / 团队徽章）。
- 本人可编辑：用户名、头像图片、头像颜色、个人简介、技能标签（最多 20 个）；头像支持 PNG / JPEG / WebP / GIF，最大 2MB，可一键恢复默认头像。
- 编辑权限按字段区分：**个人信息**（姓名、邮箱、简介、头像、头像颜色、标签、技能）仅超级管理员或本人可改，其他管理员修改会得到 `403 personal_info_forbidden`；**组织信息**（职位、团队角色、状态）由权限范围内的团队/开发组管理员维护。
- 账号资料与开发组成员记录通过邮箱双向同步：在成员抽屉里修改个人资料会同步到账号，反之亦然，成员卡、个人主页与账号设置始终一致。
- 查看其他账号：`#/profile?userId=<账号 id>`（个人主页只读，账号管理由超级管理员在设置中完成）。部署设备内置 `Admin` 没有存储账号，个人主页为只读。

---

## 成员任务与工作量负载

「任务总览」是成员共同维护的任务台账，而不是只读报表：

> 负载模型参考敏捷团队常用的「加权 Team Points + 周容量」做法（例如 [ClickUp 的 Team Points 负载思路](https://consultevo.com/clickup-keep-teams-status-green/#content#1) 与 [敏捷容量规划实践](https://ones.com/blog/agile-capacity-planning-template-a-clear-explanation-with-examples/)），用任务数量、优先级和难度推导相对负载，避免让成员凭感觉填写不可精确的工时。

- **任务字段**：标题、说明、所属成员、进度状态（待完成 / 进行中 / 已完成）、健康状态（正常 / 延期 / 阻塞）、优先级（低 / 普通 / 高 / 紧急）、难易度（简单 / 中等 / 困难）、预期完成日期。
- **个人编辑**：普通成员通过邮箱验证码（或企业 SSO）登录后只能新增/修改/删除自己的任务；管理员（团队/开发组/超级管理员）可管理范围内任意成员任务；访客只读。
- **单任务负载点数（1–6 分）**：基础 1 分 + 优先级加成（低 0 / 普通 1 / 高 2 / 紧急 3）+ 难度加成（简单 0 / 中等 1 / 困难 2）。这样同时反映任务数量、紧急程度和难易度，不依赖无法准确填写的小时估算。
- **当前负载**：未完成任务负载点数合计 ÷ 每人每周容量 15 分，显示为百分比与点数（例如 7 分 / 15 分）。
- **平均负载**：按最近 4 个完整 7 天窗口内活跃任务的加权负载点数计算滚动平均，用于识别持续高负载或空闲。
- **负载分级**：`< 40%` 轻载、`< 85%` 均衡、`< 110%` 偏高、其余超载。
- **界面**：总览页、成员抽屉和任务总览同时展示当前/平均负载；成员卡片支持展示多项并行进行中的工作。
- **成员负载明细**：任务总览「成员负载」卡片可点击打开详情，逐项列出该成员未完成任务的优先级、难度与点数构成（基础 1 分 + 优先级加成 + 难度加成）、当前/平均负载、周容量、阻塞与逾期数量，以及已完成任务；支持直接从详情筛选该成员任务或打开成员档案，便于在过载前定位具体任务。
- **数据一致性**：任务接口与 `member_tasks` 表由服务端校验、鉴权和审计；现有库升级时会自动补充优先级/难度字段并回填。

---

## 全局浏览视角

侧边栏的「浏览视角」提供数据范围切换，状态保存在本地并在刷新后保持：

| 视角 | 可用身份 | 数据范围 | 典型用途 |
| --- | --- | --- | --- |
| 开发组 | 全部身份 | 当前选中的开发组 | 日常协作、组内任务与日历 |
| 团队 | 全部身份 | 当前团队下全部开发组 | 团队负责人查看整体进度 |
| 所有团队 | 全部身份 | 站点内所有团队与开发组 | 跨团队横向对比与站点级盘点 |

- 后端所有数据读取接口支持 `?scope=group|team|all`（默认 `group`，与旧版逐字段兼容），返回 `scope` 元数据；列表项携带 `groupId/groupName/teamId/teamName`，前端据此显示所属开发组徽章。
- 所有身份（含访客）均可使用 `?scope=all`（所有团队）聚合视图，浏览视角不设权限限制。
- 写入仍然组级：在聚合视角编辑/删除时，前端按条目自己的 `groupId` 路由到对应开发组；新建数据写入当前选中的开发组，并在弹窗中明确提示「将创建到：{开发组}」。
- 概览、任务总览、数据洞察、协作日历、常用链接、责任田矩阵、公告栏均已支持；红黑榜随视角联动——开发组视角可编辑当月榜单，团队 / 所有团队视角显示只读汇总（条目带所属开发组徽章，隐藏编辑与「生成下月」）。
- 示例：`GET /api/teams/team-aurora/groups/grp-frontend/overview?scope=all`（所有身份，含访客）。

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
- 完整支持开发组 / 团队 / 所有团队视角；API：`GET /api/teams/{team}/groups/{group}/insights?scope=&range=1w|2w|1m|2m|3m|all`。

「任务总览」同时提供近 1 周至近 3 个月的任务窗口和多列排序（成员 / 优先级 / 难度 / 负载点数 / 预期完成 / 创建时间 / 进度 / 健康度）。

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

### 依赖说明

- 后端依赖见 `backend/requirements.txt`：FastAPI、uvicorn、pydantic、**python-multipart**（个人主页头像的 multipart 上传必需）；测试依赖另含 httpx + pytest（`backend/requirements-dev.txt`）。
- Python：清华 PyPI 镜像 `https://pypi.tuna.tsinghua.edu.cn/simple`（已写入 `pip.conf` 并在脚本中显式指定）。
- npm：清华 TUNA 的 npm 镜像已停止提供（访问返回 404），因此使用国内 **npmmirror** 镜像 `https://registry.npmmirror.com/`，配置在项目根目录 `.npmrc`，脚本中同样显式指定。VS Code 同款编辑器 `monaco-editor@0.57.0` 也通过该镜像安装，worker 由 Vite 本地打包。
- 本项目未使用任何 CDN 运行时资源，Monaco 编辑器代码与 worker 全部随构建产物本地加载，字体使用系统字体，部署后无需外网。

### 目录内容

首次启动会自动创建：

```
data/
├─ settings.json        # 可视化 + JSON 双模式编辑的全部设置
├─ teamstudio.db        # SQLite 业务数据（演示种子、账号/验证码、任务标签、审计等）
├─ .session_secret      # 会话签名密钥（自动生成，请勿泄露）
└─ uploads/avatars/     # 个人主页头像（首次上传时创建）
```

想重新生成演示数据：停止服务后删除 `data/teamstudio.db` 再启动。删除 `data/settings.json` 会恢复默认设置。

启用邮箱验证码登录前，请先由超级管理员在「系统设置 → 邮件服务」中填写 SMTP 中继信息并点击「测试发送」确认可用；未配置时登录页会提示联系超级管理员。

---

## 权限模型

| 身份 | 判定方式 | 权限 |
|------|----------|------|
| **超级管理员（部署设备 Admin）** | 请求来源为部署机器本机（loopback 或本机网卡地址），且该浏览器未主动退出设备管理员身份 | 所有团队/开发组内容、站点设置、账号与角色、企业 SSO、邮件服务；**可创建 / 删除任意团队与开发组**；名称固定 `Admin`，**不会出现在配置文件中**；可退出并在登录页用「以设备管理员身份登录」恢复 |
| **超级管理员（账号）** | `users.role = super`（由超级管理员在「账号与角色」中授予） | 与设备 Admin 相同的管理能力；区别是该账号行可被管理（但设备 Admin 行始终不可管理与删除） |
| **团队管理员** | 账号角色 `team_admin` + 团队范围，或 ID/IP 白名单 | 该团队全部开发组内容的完整编辑权限；**可在该团队内创建 / 删除开发组**；不能创建/删除团队、不能读取站点设置，只能编辑领域级「工作区设置」 |
| **开发组管理员** | 账号角色 `group_admin` + 开发组范围，或 ID/IP 白名单 | 指定开发组内容的完整编辑权限；不能跨组、不能修改站点设置、不能增删团队/开发组 |
| **成员** | 邮箱验证码登录（任意有效邮箱自助注册，或超级管理员预创建后通过一次性激活链接激活） | 个人主页与本人资料、自己的工作项、自己的任务与待办；全局只读；可使用任意浏览视角 |
| **访客** | 未登录 / 站点关闭访客访问 | 只读（可浏览所有模块），可按配置关闭访客访问 |

要点：

- **设备管理员可退出**：直接用浏览器访问 `127.0.0.1:8000` 或部署机本机地址时默认成为 `Admin`，这是应急恢复入口，避免误配 SSO 或邮件服务后锁死管理台。在登录页或用户菜单点击「退出登录 / 切换账号」后，本机浏览器会记住退出状态，可改用任意邮箱账号登录，该账号**不会附带设备管理员权限**；登录页顶部会显示「以设备管理员身份登录」按钮，可随时恢复内置 `Admin`。
- 如果服务部署在中心服务器、由其他电脑访问，浏览器所处电脑并非“部署设备”，此时请通过账号与角色（或 IP / ID 白名单）授予管理员。
- **账号主路径**：注册 / 登录 / 角色范围都以 `users` 表为准；预创建账号初始为未验证状态，使用创建时返回的一次性激活链接激活并登录。成员身份与开发组成员记录按邮箱关联。
- **个人信息与组织信息分离**：姓名、邮箱、简介、头像、头像颜色、标签、技能仅本人或超级管理员可编辑；职位、团队角色、状态由权限范围内的团队/开发组管理员编辑；越权修改返回 `403 personal_info_forbidden`。
- **浏览视角不设权限限制**：所有身份（含访客）均可使用开发组 / 当前团队 / 所有团队视图；`?scope=all` 不再返回权限错误。
- 删除成员、修改公告、账号与角色变更等管理操作都会写入审计日志（`features.auditLog` 可关闭）。
- **系统重置只有部署设备内置 Admin 能做**：存储在册的 `super` 账号即使在本机登录也只有站点设置等普通超管权限，看不到「重置系统」标签页，接口返回 `403 device_admin_required`。重置会恢复默认设置并清空全部数据，见下文。

### 工作区结构管理（团队 / 开发组增删）

有权管理员可从右上角用户菜单打开「工作区管理」，在权限域内维护团队与开发组结构：

- **超级管理员**：可创建 / 删除任意团队与开发组；**团队管理员**：仅可在自己的团队内创建 / 删除开发组；**开发组管理员 / 成员 / 访客**：没有结构管理入口。
- 删除是**输入名称的二次确认**：必须完整输入团队或开发组名称，确认按钮才会解锁；名称不匹配时接口返回 `422 confirm_mismatch`，数据不会变化。
- 删除团队会级联删除其下全部开发组、成员、工作项、任务、待办、红黑榜、链接、责任田、公告与任务标签；删除开发组会级联清理该组业务数据，并写入审计日志。
- 操作完成后侧边栏团队 / 开发组树和当前选择会自动刷新；若删除了当前正在浏览的团队或开发组，会自动回退到第一个可用选项。
- API：`GET /api/workspace/manage`、`POST /api/workspace/teams`、`DELETE /api/workspace/teams/{teamId}`、`POST /api/workspace/teams/{teamId}/groups`、`DELETE /api/workspace/teams/{teamId}/groups/{groupId}`（删除请求体为 `{ "confirmName": "完整名称" }`）。

### 系统重置（仅设备管理员）

「系统设置」最后一个标签页「重置系统」只对**部署设备内置 Admin** 渲染；存储的超级管理员账号看不到该标签页，直接访问 `#/settings?tab=reset` 会回退到普通标签页，`GET/POST /api/system/reset` 对其返回 `403 device_admin_required`。

- **双重确认**：点击「重置整个系统」先弹出确认框询问是否重置；确认后再弹出第二个对话框，必须**完整输入当前站点名称**（如 `星港团队工作室`）才会解锁最终按钮，名称不匹配时接口返回 `422 confirm_mismatch`。
- **清除范围**：恢复 `data/settings.json` 全部默认设置；删除所有团队、开发组、成员、工作项、任务、待办、红黑榜、链接、责任田、公告、任务标签、账号、邮箱验证码/日志、激活令牌、审计日志与 `data/uploads/` 下的全部头像文件。
- **重启安全**：重置后写入 `app_meta.factoryResetAt` 标记，启动时的演示数据播种会跳过，因此重启服务后系统保持干净空状态（可在「工作区设置」重新创建团队）。
- **会话安全**：重置会轮换 `data/.session_secret`，所有已签发的账号会话立即失效；内置 Admin 不是存储账号，重置后仍可继续使用。
- 重置操作本身会写入一条审计记录（`system.factory_reset`），便于事后追溯。

---

## 企业 SSO 配置

邮箱验证码是默认登录方式；企业 SSO 是可选的身份接入方式。配置后登录页会显示「使用企业 SSO 登录」。

系统设置 →「企业 SSO」，或直接编辑 JSON：

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
- 登录流程：授权码 + PKCE（S256）+ state + nonce；会话写入 HMAC-SHA256 签名的 HttpOnly Cookie，与邮箱验证码登录共享 7 天滑动会话。
- 配置不完整（缺 issuer/clientId/clientSecret/redirectUri）或未启用时，登录页只展示邮箱验证码与访客入口。
- 从其他电脑访问时，回调地址必须使用实际可访问的 URL（反向代理 HTTPS 时同步修改 `redirectUri`，并把 `auth.session.secureCookie` 设为 `true`）。

---

## 管理员白名单

白名单是 SSO / IP 身份的**补充授权路径**（主路径仍是账号与角色），可在系统设置 →「成员与权限」可视化维护，也可编辑 JSON。白名单分为 IP 与 ID 两组，支持 `team_admin` / `group_admin` 两种角色。

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

- IP 支持单 IP 和 CIDR；ID 会与 SSO / 邮箱账号的 id、邮箱、`sub` 匹配（忽略大小写）。
- `team_admin` 必须填 `teamId`；`group_admin` 至少填一个 `groupIds`，否则配置校验失败。
- 内置 `Admin` 不在白名单中，无法被删除，也不会写入 JSON；超级管理员角色请通过「账号与角色」授予。

---

## 邮件服务（SMTP 中继）

第 5 轮起，邮件只用于**投递账号验证码**，并且只支持通过外部 SMTP 中继发送：不再内置 SMTP 服务器，不再提供本地邮件中心 / 发件箱，也不再发送日历邮件提醒。

系统设置 →「邮件服务」，或修改 JSON 的 `email` 节点：

```json
{
  "email": {
    "enabled": true,
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
    "subjectTemplate": "[{{siteName}}] 邮箱验证码",
    "bodyTemplate": "你的验证码是 {{code}}，{{expiresMinutes}} 分钟内有效，请勿转发给他人。"
  }
}
```

工作方式：

1. `email.enabled = true` 且填写 `smtp.host` 与发件邮箱 `fromEmail` 后，验证码邮件才会发送；否则登录接口返回 `503 email_not_configured`。
2. `username` / `password` 是中继账号（企业邮箱通常需要“应用专用密码”），`fromEmail` / `fromName` 是收件人看到的发件地址与发件人名称。
3. 587 端口通常使用 STARTTLS，465 端口使用 SSL；二者互斥，不能同时开启。`timeoutSeconds` 控制连接超时。
4. 验证码邮件的主题与正文支持 `{{siteName}}`、`{{code}}`、`{{expiresMinutes}}` 与 `{{purpose}}` 变量；发送失败会返回明确错误。
5. 管理台提供「测试发送」、中继状态（已配置 / 主机 / 端口 / 最近错误 / 今日发送量）与最近发送日志（收件邮箱脱敏）；`GET /api/email/status`、`GET /api/email/logs`、`POST /api/email/test`。
6. 发送尝试记录在 `email_logs` 表中；SMTP 密码不会出现在任何接口或日志里。

> SMTP 密码以明文保存在 `data/settings.json`（这是“JSON 可直接编辑”需求的取舍）。请使用应用专用密码，限制数据目录权限，并避免把该文件提交到版本库。升级到第 5 轮后，旧的 `email.deliveryMode`、`email.builtin`、`email.reminders` 字段会被自动移除。

---

## JSON / GUI 双模式设置

所有设置都在 `data/settings.json`，服务端 Pydantic 模型强校验并原子写盘。管理台按角色分层：

- **站点级（仅超级管理员）**：「外观与站点」「模块与展示」「成员与权限」「账号与角色」「企业 SSO」「邮件服务」「高级 JSON」；部署设备内置 Admin 在此基础上还会看到一个仅自己可见的「重置系统」危险操作页。
- **领域级（团队 / 开发组管理员）**：只显示「工作区设置」，可编辑授权范围内的团队与开发组基础信息，不会请求站点级配置（接口对其返回 403）。
- **GUI 模式**：站点/主题、模块开关、公告置顶策略、日历展示偏好、红黑榜文案、功能开关、邮箱验证码登录参数、会话保持天数、白名单、账号与角色、企业 SSO、SMTP 中继与验证码模板。主题固定为鸿蒙纸白/暗黑双模式与统一色板。
- **高级 JSON 模式（超级管理员）**：完整设置对象，VS Code 同款 Monaco 编辑器（行号、语法高亮、错误波浪线），支持格式化、后端 Schema 校验、逐路径错误提示、校验通过后保存；Schema 可通过 `GET /api/settings/schema` 获取。
- **模块隐藏**：`modules.overview/tasks/insights/calendar/redblack/links/matrix/announcements/settings` 控制侧栏入口；隐藏后普通成员直接访问路由会看到隐藏提示，管理员仍可进入设置恢复。
- **保存即时生效**：主题、模块可见性、日历默认值、登录参数、会话天数与邮件配置会立即应用。

主要配置节点：

```
site             站点名称、标语、logo、页脚、主题（纸白/暗黑/跟随系统、圆角）
modules          模块展示开关（概览/任务/数据洞察/日历/红黑榜/链接/矩阵/公告/设置）
announcements    置顶上限 0-3、首页条数
calendar         周起始日、是否显示周末、是否允许创建过期待办
redblack         红黑榜标题、是否显示评分、月度主题
email            外部 SMTP 中继（主机/端口/账号/密码/发件人/TLS/超时）、验证码邮件主题与正文模板
auth             邮箱验证码登录、预创建账号激活链接有效期（默认 10 分钟）、企业 SSO、访客模式、管理员白名单、会话 Cookie 与保持天数（默认 7）
features         成员自编辑、访客横幅、演示标识、审计、访客创建待办
```

任何未知字段、类型错误、范围错误都会被拒绝，不会写入文件；第 4 轮的邮件提醒 / 内置邮件服务器字段会在加载旧配置时自动剔除。

---

## 项目结构

```
TeamStudio/
├─ backend/
│  ├─ app/
│  │  ├─ main.py              # FastAPI 入口、静态前端托管、异常格式、生命周期
│  │  ├─ config.py            # Pydantic 配置 Schema、原子 JSON 存储、旧配置迁移
│  │  ├─ db.py                # SQLite Schema 与连接（账号/验证码、头像列、移除旧邮件表）
│  │  ├─ scope.py             # 开发组 / 团队 / 所有团队读取范围解析
│  │  ├─ auth.py              # 账号会话、滑动续期、IP/ID 权限、验证码哈希
│  │  ├─ sso.py               # OIDC Discovery + 授权码 + PKCE
│  │  ├─ seed.py              # 演示团队/成员/工作/待办/榜单/任务数据
│  │  ├─ routers/             # auth/bootstrap/settings/system/users/profile/email/workspaces/
│  │  │                       # workspace/calendar/boards/tasks/insights
│  │  └─ services/            # 账号同步、SMTP 中继、任务负载、洞察聚合
│  ├─ requirements.txt        # FastAPI / uvicorn / pydantic / python-multipart
│  └─ tests/                  # 127 个 pytest 用例（API / 权限 / 账号 / 个人主页 / 分层设置 /
│                             # 验证码 / 视角限制 / 红黑榜 / 工作区 / 任务 / 标签 / 洞察）
├─ web/
│  ├─ src/
│  │  ├─ pages/               # 概览、任务总览、数据洞察、日历、红黑榜、链接、矩阵、公告、
│  │  │                       # 设置、登录、个人主页
│  │  ├─ components/          # AppShell、工作区管理、成员负载详情、多选、成员抽屉、任务弹窗、
│  │  │                       # 标签选择、下拉框、头像、Monaco 等
│  │  ├─ api.ts / types.ts    # 类型化 API 客户端
│  │  ├─ store.tsx            # 工作区上下文、跟随系统主题、团队/开发组切换、浏览视角、权限
│  │  └─ styles.css           # 鸿蒙风纸白/暗黑设计系统（默认跟随系统）
│  ├─ e2e/                    # Playwright 冒烟 / 任务 / 侧栏 / 集成 QA / 第 5 轮验收 / 截图脚本
│  └─ dist/                   # 构建产物（由 FastAPI 托管）
├─ data/                      # 运行时数据（首次启动生成）
├─ docs/                      # 设计/验收契约与截图
├─ scripts/                   # setup / build / start / verify
├─ CONTRACT.md                # 前后端 API 契约
├─ TASKS_CONTRACT.md          # 任务台账 / 标签 / 视角 / 洞察契约
└─ README.md
```

---

## 开发与测试

```powershell
# 后端测试（127 个用例）
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
# 集成 QA
npm run e2e:qa --prefix web
# 第 3 轮六项优化专项 QA
npm run e2e:round3 --prefix web
# 第 5 轮验收（账号 / 个人主页 / 分层设置 / 验证码登录 / 浏览视角 / 红黑榜视角）
npm run e2e:round5 --prefix web
# 回归：所有身份（访客 / 成员）都能切换到「所有团队」视角
npm run e2e:scope-all --prefix web
# 回归：预创建账号 / 重新生成激活链接后自动复制到剪贴板（含复制失败回退）
npm run e2e:activation --prefix web
# 系统重置（设备管理员专属标签页 / 双重确认 / 清空数据 / 超管不可见 / 重启安全）
npm run e2e:reset --prefix web
# 专项验证脚本
npm run e2e:select --prefix web
npm run e2e:tags --prefix web
npm run e2e:insights --prefix web
# 全页面截图（输出到 artifacts/）
npm run e2e:screenshots --prefix web
# 刷新 README 截图（输出到 docs/screenshots/）
npm run e2e:docs-shots --prefix web
npm run e2e:docs-shots-r3 --prefix web
```

E2E 覆盖：成员抽屉、团队/开发组切换、日历待办增删、公告发布删除、设置各标签页、JSON 双模式校验与恢复（Monaco）、任务台账筛选与增删改（优先级 / 难度 / 负载点数 / 时间跨度 / 排序）、标签 CRUD 与筛选、数据洞察范围与排序、浏览视角聚合与所有团队视图、自绘下拉框、成员负载展示、侧栏折叠、关于弹窗、纸白/暗黑主题切换；第 5 轮新增：**邮箱验证码注册/登录、个人主页与头像上传、账号与角色管理、站点/领域分层设置、SMTP 中继配置、红黑榜视角跟随与只读汇总**；系统重置：**设备管理员专属标签页、两步确认与完整站点名称校验、真实清空数据、在册超管不可见 / 接口 403、重置后重启不回填演示数据**；回归专项：**访客/成员「所有团队」视角切换、预创建账号激活链接自动复制到剪贴板**。

> 集成 QA 脚本默认访问 `http://127.0.0.1:8000`，可用 `QA_URL=http://127.0.0.1:5173` 指向 Vite 开发服务器；`TEAMSTUDIO_URL` 可指定冒烟脚本目标。`e2e:round5` 使用独立的 `QA_URL`（默认 `http://127.0.0.1:8010`）、`TEAMSTUDIO_TRUST_PROXY=1` 与一次性数据目录，详见脚本头部注释。`e2e:reset` **会真实清空数据**，必须指向 `QA_URL`（默认 `http://127.0.0.1:8011`）且使用一次性 `TEAMSTUDIO_DATA_DIR` 的实例；它同时输出 `docs/screenshots/system-reset*.png` 两张界面截图。

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

- 备份内容：`data/teamstudio.db`、`data/settings.json`、`data/.session_secret` 与 `data/uploads/`（个人头像）。账号、验证码、任务标签、审计日志都在 SQLite 中，随数据库一起备份。SQLite 使用 WAL，建议停机备份或使用 SQLite 在线备份。
- 部署设备本机访问自动获得 `Admin` 是为了防止锁死；**不要把 8000 端口无保护地暴露到公网**。
- 邮箱验证码只保存 HMAC 哈希，明文验证码不落库、不写日志；发送日志中的收件邮箱经过脱敏；SMTP 密码不会出现在日志中。
- 中心化部署时建议：
  1. 配置企业 SSO 并至少保留一个可用的超级管理员账号（或白名单管理员）；
  2. 通过反向代理启用 HTTPS；
  3. 将 `auth.session.secureCookie` 设为 `true`；
  4. 正确设置代理来源 IP（默认不信任 `X-Forwarded-For`，避免伪造本机/白名单 IP）。
- 反向代理与设备 Admin：默认情况下，带 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` 请求头的请求**不会**被当作部署设备，避免同机 Nginx 等代理让所有访问者继承 Admin。设备管理员应通过直连 `127.0.0.1:8000` 访问；如需信任代理，显式设置环境变量 `TEAMSTUDIO_TRUST_PROXY=1` 并确保代理会覆盖客户端传入的转发头。
- 访客默认只读。可在设置中关闭访客访问（`auth.guestMode=false` + `auth.allowGuestRead=false`）。
- `data/settings.json` 可能包含 SMTP 密码与白名单等敏感信息，请限制数据目录权限，避免提交到版本库。
- **系统重置不可撤销**：仅部署设备内置 Admin 可执行，会恢复默认设置、清空全部业务与账号数据、删除上传头像并轮换会话密钥。需要保留的数据请先备份 `data/`；重置后系统保持空状态（不会重新灌入演示数据），可在「工作区设置」重建团队。

---

## 常见问题

**Q：页面显示“前端尚未构建 / 只能访问 API”？**  
运行 `.\scripts\build.ps1`，确认 `web\dist\index.html` 存在后重启。

**Q：为什么从另一台电脑打开没有 Admin 权限？**  
内置 Admin 只对部署设备本机请求生效。请在「账号与角色」中创建超级管理员账号并用邮箱验证码登录，或按 IP / SSO ID 在「成员与权限」中添加管理员。

**Q：设备管理员退出后还能恢复吗？**  
可以。退出后本机浏览器会显示普通登录页及「以设备管理员身份登录」按钮，点击即可恢复内置 `Admin`；即使清理了 Cookie，部署设备默认仍会自动恢复设备管理员身份。

**Q：收不到邮箱验证码？**  
先在「系统设置 → 邮件服务」确认 `email.enabled` 已开启、SMTP 主机 / 端口 / 账号 / 密码 / 发件邮箱填写正确，并点击「测试发送」；也可查看 `GET /api/email/status` 的最近错误与发送日志。注意 60 秒重发间隔与 10 分钟有效期，并检查垃圾邮件目录。未配置 SMTP 时登录接口返回 `503 email_not_configured`，属于预期提示。

**Q：为什么普通管理员进入设置只看到「工作区设置」？**  
第 5 轮起设置分层：站点级设置（外观、模块、登录、账号、SSO、邮件、JSON）仅超级管理员可读写；团队 / 开发组管理员只拥有领域级「工作区设置」，不能读取站点配置。

**Q：为什么看不到「所有团队」浏览视角？**  
「所有团队」不再需要额外权限，所有身份均可使用；如界面未显示，请刷新页面或检查浏览器缓存。

**Q：企业 SSO 已开启但登录页没有入口？**  
先确认 issuer/clientId/clientSecret/redirectUri 是否齐全、回调地址是否与控制台一致、IdP 是否允许该回调；配置完整后登录页会显示「使用企业 SSO 登录」。邮箱验证码是默认登录方式，不受 SSO 配置影响。

**Q：以前的「内建邮件服务器 / 本地邮件中心 / 邮件提醒」去哪了？**  
第 5 轮已整体移除：不再内置 SMTP 服务器、不再保存本地邮箱、不再有日历提醒调度与提醒模板。邮件现在只用于发送账号验证码，并通过「邮件服务」中配置的外部 SMTP 中继投递；旧的 `deliveryMode` / `builtin` / `reminders` 配置与待办提醒字段会在加载或升级时自动清除。

**Q：为什么不能修改某个成员的个人信息？**  
姓名、邮箱、简介、头像、头像颜色、标签、技能属于个人信息，仅超级管理员或本人可改，其他管理员修改会收到 `403 personal_info_forbidden`；职位、团队角色、状态属于组织信息，由权限范围内的管理员维护。

**Q：想清空演示数据？**  
停止服务，删除 `data/teamstudio.db`，重新启动即可重建演示数据；`data/settings.json` 不受影响。

**Q：Node/Python 安装慢？**  
项目已使用国内镜像。若需手动安装：`pip install -i https://pypi.tuna.tsinghua.edu.cn/simple ...` / `npm install --registry https://registry.npmmirror.com/ ...`。个人主页头像上传依赖的 `python-multipart` 已包含在 `backend/requirements.txt` 中。
