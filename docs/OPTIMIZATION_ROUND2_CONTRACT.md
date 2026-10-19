# TeamStudio · 第二轮优化协作契约（v2）

> 本文件是本轮并行开发的唯一契约来源。所有 teammate 必须遵守文件所有权、API 形态与验收方式。
> 用户提出的 16 项需求编号统一使用：`#1`…`#16`（见任务板）。

## 0. 运行环境与验证方式

- 后端已由 Lead 以热重载方式运行：`http://127.0.0.1:8000`（uvicorn `--reload`，保存后端代码即自动重启；不要另起后端端口）。
- 前端 Vite 开发服务器：`http://127.0.0.1:5173`（HMR，保存即刷新；`/api` 已代理到 8000）。
- 用户实际访问：`http://127.0.0.1:8000`（FastAPI 托管 `web/dist`，需要 `npm run build --prefix web` 才更新；联调阶段请用 5173）。
- 浏览器截图：`playwright` 已安装，使用系统 Edge：
  ```js
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto("http://127.0.0.1:5173/#/overview", { waitUntil: "networkidle" });
  await page.screenshot({ path: "artifacts/xxx.png", fullPage: false });
  ```
  `artifacts/` 已被 gitignore，可放中间产物。需要管理员权限时直接访问 5173（本机请求自动 Admin）。
- 任何第三方依赖只能用国内镜像：npm `--registry https://registry.npmmirror.com/`，pip `-i https://pypi.tuna.tsinghua.edu.cn/simple`。**不要**引入 CDN 运行时资源。
- 不要执行 `git commit`/`git checkout`/删除 `data/`。Lead 用 git 做最终审阅。
- 类型检查/构建是全仓库的，其他 teammate 的文件可能暂时报错；只需确保**自己写入的文件**没有错误，并在完成时运行一次：
  - `npm run typecheck --prefix web`
  - `.\.venv\Scripts\python.exe -m pytest backend\tests -q`（后端改动）
  - 不要运行 `npm run build --prefix web` 之外的部署动作；构建产物由 Lead 统一生成。

## 1. 全局浏览视角（#11）—— 已由 Lead 打好基础

### 前端
- `useApp()` 新增 `scope: "group" | "team" | "all"`、`scopeLabel: string`、`setScope(scope)`。
- 侧边栏已新增「浏览视角」切换器（Lead 负责），localStorage 记忆。
- 所有数据页从 store 读取 `scope` 并传给 API：
  - `api.overview(teamId, groupId, scope)`
  - `api.tasks(teamId, groupId, scope)`
  - `api.todos(teamId, groupId, month, scope)`
  - `api.links(teamId, groupId, scope)` / `api.matrix(...)` / `api.announcements(...)`
- 聚合视角下，列表项需要显示所属开发组（成员卡片、任务、待办、链接、责任田、公告）。相关 payload 已约定包含 `groupId` + `groupName`（任务/待办已有 `groupId`），前端用 `scope.groups` 或 payload 自带名称渲染小徽章。
- 新建/编辑仍写回**条目所属开发组**：用条目上的 `groupId` 在 `data.teams` 中反查 `teamId`；新建时写入当前选中的开发组（`currentGroup`），并在聚合视角提示“将创建到：{currentGroup.name}”。
- 红黑榜/设置/邮件保持开发组/全局语义，不需要 scope 聚合。

### 后端（T5）
- `backend/app/scope.py`（Lead 已完成）提供：
  ```python
  scope: str = Query(default="group")
  ctx = resolve_scope(conn, team_id, group_id, scope)   # dict(kind,label,teamIds,groupIds,groups,...)
  ctx["groupIds"]  # list[str]
  ```
- 所有 GET 路由增加 `scope` 参数（默认 group，行为与旧版完全一致），SQL 用 `group_id IN (...)` 过滤；响应追加 `"scope": ctx`（camelCase 结构见 `web/src/types.ts` 的 `ScopeMeta`）。
- 响应中的成员/任务/待办/链接/责任田/公告追加 `groupId`、`groupName`（任务再加 `teamId`、`teamName`），供聚合视图展示。
- 统计/负载聚合按 `groupIds` 汇总；单组模式下结果必须与旧版逐字段一致（现有 48 个测试不能破坏）。

## 2. 任务标签（#10）—— 契约（T5 后端 / T4 前端）

标签库按开发组共享（所有人可增删改）：

- `GET /api/teams/{team}/groups/{group}/task-tags?scope=group` →
  `{ tags: [{ id, groupId, groupName?, name, color, usage, createdBy, createdAt, updatedAt }], scope }`
  - 首次访问某组且库为空时自动写入 5 个默认标签（如「前端」「后端」「体验」「数据」「协作」）。
- `POST .../task-tags`（登录用户即可）body `{ name: string(1-20), color?: #RRGGBB }` → `{ tag }`；同名 409/422。
- `PATCH .../task-tags/{tagId}`（登录用户即可）`{ name?, color? }` → `{ tag }`。
- `DELETE .../task-tags/{tagId}`（登录用户即可）→ `{ deleted: true }`，同时从所有任务的 `tags` 数组移除该 id。
- 任务读写：
  - `MemberTask.tagIds: string[]` 与 `tags: TaskTag[]`（服务端 hydrate）。
  - `POST/PATCH /tasks` 接受 `tagIds: string[]`（最多 8 个，必须属于该开发组），写入 `member_tasks.tags` JSON。
  - 任务列表/看板按 scope 过滤后同样返回 hydrated tags。
- 前端（T4）：
  - `components/TagPicker.tsx`：任务弹窗内多选标签、内联新建、编辑（重命名/换色）、删除；所有登录用户可用。
  - `TaskOverviewPage` 显示标签 chips，支持按标签筛选；标签管理入口（弹出层）可编辑标签库。

## 3. 数据统计与分析（#12）—— 契约（T5 后端 / T4 前端）

`GET /api/teams/{team}/groups/{group}/insights?scope=group|team|all&range=1w|2w|1m|2m|3m|all`
返回 `InsightsData`（严格按 `web/src/types.ts`）：

- `scope`: `ScopeMeta`；`range`: `{ key, label, days, start }`（`all` 时 `days=null, start=null`）。
- `summary`: 见 `InsightsSummary`。
- `members[]`: 每人一行，字段见 `InsightsMemberRow`（`completionRate` 为 0-100 整数）。
- `groups[]`: 每组一行，见 `InsightsGroupRow`。
- `teams[]`: 每团队一行，见 `InsightsTeamRow`。
- `trend`: `{ granularity: "day"|"week", buckets: [{ label, start, created, completed, todos }] }`
  - `range=1w/2w` 用 day，`1m/3m/all` 用 week；`all` 最多返回最近 26 个桶。
- 时间过滤语义：任务在窗口内“活跃”= `created_at >= start OR completed_at >= start OR progress_status != 'completed'`；`all` 时全部。待办按 `created_at >= start`（`all` 时全部）。成员行包含窗口内活跃任务/待办为 0 的成员吗？——**只返回窗口内有任务或待办的成员**，`groups/teams` 同理至少有一个条目才返回。
- 权限：`require_read_access`（访客可读）。
- 前端（T4）新建 `pages/InsightsPage.tsx` + `.css`：KPI 卡、趋势柱状图（纯 CSS/SVG，不引图表库）、范围切换（1 周…全部）、成员/开发组/团队三张可排序表格（点击表头排序，升降序）、scope 标签徽章、空状态。使用现有设计语言变量。

## 4. 任务总览时间跨度与排序（#13）—— T4

- 时间跨度：`近 1 周 / 2 周 / 1 个月 / 2 个月 / 3 个月`（最小 1 周、最大 3 个月），默认 1 个月；纯前端过滤（`lib/scope.ts` 的 `TASK_RANGES/rangeStartISO/isWithinRange`），任务在窗口内活跃的判定同上：`createdAt/updatedAt/completedAt >= start` 或未完成。
- 排序：至少支持「成员 / 优先级 / 难度 / 负载点数 / 预期完成日期 / 创建时间 / 状态」，可升/降序，表头可点击；保留现有筛选。
- workload 区块显示当前窗口平均值（由后端 `meta.windowLabel` 或前端固定文案说明）。

## 5. 内建邮件服务器（#16）—— 契约（T6）

### 配置（Lead 已加，`config.py`）
```json
"email": {
  "enabled": true,
  "deliveryMode": "builtin",          // builtin | smtp
  "builtin": { "enabled": true, "host": "127.0.0.1", "port": 2525, "hostname": "teamstudio.local", "mailboxLimit": 500, "retentionDays": 90 },
  "smtp": { ... 保留外部 SMTP 作为可选模式 ... },
  "reminders": { ... }
}
```
### 后端
- 新建 `backend/app/services/mail_server.py`，**仅用 Python 标准库 asyncio** 实现轻量 SMTP 服务器（不新增第三方依赖）：
  - `async def start_mail_server() -> None`：当 `email.enabled && deliveryMode=="builtin" && builtin.enabled` 时监听 `builtin.host:port`；已运行则幂等。启动失败只记录日志，不阻塞 API。
  - `async def stop_mail_server() -> None`。
  - `def mail_server_status() -> dict`（running/host/port/stored/limit）。
  - 协议至少支持：`EHLO/HELO`、`MAIL FROM:`、`RCPT TO:`、`DATA`（处理 dot-stuffing、单条消息多个收件人）、`RSET`、`NOOP`、`QUIT`，未知命令 `502`；每连接可连续发多封；单封最大 2MB。
  - 收到邮件后用 `email.policy.default` 解析，写入 `mailbox_messages` 表（Lead 已在 `db.py` 建表：direction/from_addr/to_addrs/cc_addrs/subject/body_text/body_html/raw/kind/group_id/todo_id/status/error/created_at/read_at）。`to_addrs`/`cc_addrs` 用 JSON 数组字符串存。
  - `main.py` lifespan 已按上述函数名调用（Lead 已接好）。
- `email_service.deliver()`：`deliveryMode=="builtin"` 时通过 `smtplib` 投递到本机内置服务器（不校验外部 SMTP），成功/失败都写 `email_logs`；`deliveryMode=="smtp"` 时保留原外部 SMTP 逻辑。内置模式下 `enabled` 视为开启，`smtp_configured()` 的判断改为“内置服务运行中”或“外部 SMTP 已配置（smtp 模式）”。
- `routers/email.py` 新增：
  - `GET /api/email/mailbox?limit=50&box=outbound|all` → `{ messages, total, builtin }`，邮件列表按时间倒序，`bodyText` 可截断到 4000 字。
  - `GET /api/email/mailbox/{id}` → `{ message }`（完整正文，读取时写 `read_at`）。
  - `DELETE /api/email/mailbox/{id}`（管理员）→ `{ deleted: true }`。
  - `POST /api/email/builtin/restart`（管理员）→ `{ running, host, port }`。
  - `GET /api/email/status` 保留旧字段并增加 `deliveryMode`、`builtin: { enabled, running, host, port, stored, limit }`。
  - 修掉旧版 `email_status()` 缺少 `scheduler`/`templatePreview` 字段的问题（前端 `EmailStatus` 类型要求）。
- `email.enabled` 保存后下一轮调度器/邮件中心读取新配置；`POST /api/email/test` 在内置模式必须可离线发送成功（发给 `builtin` 本机）。
### 前端（T6）
- `components/EmailPanel.tsx/.css`（设置 → 邮件提醒标签页）增加：
  - 「投递方式」segmented：内置邮件服务器 / 外部 SMTP；内置时隐藏 SMTP 字段，显示 host/port/hostname/mailboxLimit/retentionDays 表单 + 运行状态 + 「重启内置服务」按钮。
  - 「本地邮件中心」区域：最近邮件列表、点击查看正文（主题/发件人/收件人/时间/正文纯文本）、删除、刷新；说明“内置服务器离线保存邮件，不依赖外部邮件服务”。
  - 测试发送按钮在内置模式下可用。

## 6. 自定义下拉框（#9）—— T3

- `components/Select.tsx` 已由 Lead 放置占位实现（API 固定，见文件头注释）。T3 负责改成完全自绘的下拉框：
  - props 不变：`value/onChange/options[{value,label,description?,color?,disabled?}]/placeholder/ariaLabel/disabled/className/size/searchable/id/name`。
  - 键盘可达（↑↓/Enter/Esc/Home/End/键入搜索）、点击外部关闭、`aria-expanded/aria-activedescendant`、暗色/亮色都使用 CSS 变量、展开面板**不透明**（`background: var(--surface)` 叠加实色，不要 backdrop 透明）、带轻微 pop 动画、`prefers-reduced-motion` 降级。
  - 弹层用 `position: fixed` + 计算定位（避免被 `overflow:hidden` 的对话框裁切）；滚动/窗口 resize 时关闭或重定位。
- 替换原生 `<select>`：`TodoDialog`（指派成员）、`TaskDialog`（成员，T4 使用 Select）、`MatrixPage`（成员筛选/负责人/备份人）、`MemberDrawer`（工作状态，T1 使用 Select）。其余原生 select（月份选择等）可保持。
- 侧边栏开发组/团队 popover 透明问题由 T1 在 `styles.css` 的 `.popover` 统一改为不透明实色，T3 不重复处理。

## 7. 视觉主题（#1-#5、#7、#14）—— T1

- 统一在 `web/src/styles.css` 的 `:root[data-theme="light"]` 调整色板：
  - 纸感：暖白纸底（`--bg/--paper` ~ `#f3f1ea`，`--surface` 更亮偏暖 `#fbfaf6`，`--surface-2/3` 逐级加深），边框更清晰（`--border` 加深、`--border-strong` 再深），阴影略强但柔和；避免纯白刺眼和“一片浅色分不清”。
  - 侧边栏选中：`--sidebar-active-bg` 改为柔和的纸色/淡蓝（例如 `color-mix` 或 `#e9e7df`），文字 `--sidebar-text`，左侧可用 accent 细条；不要黑底白字。
  - `.popover` 改为不透明实色背景（保留边框与阴影，去掉高透明玻璃导致的“透底”）。
- `pages/OverviewPage.css`：
  - `.ov-hero` 在亮色主题下改为纸白/暖色渐变卡片（深色文字 + 柔和蓝色光晕），暗色主题保持现有石墨深色；内层 chip/stats/note 等颜色同步使用变量，确保对比度。
  - 成员卡片密度（#14）：桌面宽度一行 4 张（`repeat(4, minmax(0,1fr))`），中等屏幕 3 张、窄屏 2/1 张；同步缩小卡片内边距、头像/标题尺寸；不要破坏现有信息层次。
- `components/MemberDrawer.tsx`（个人页）：
  - `.md-hero` 亮色下改为纸色卡片（深色文字），暗色保持深色；
  - 抽屉**关闭动画**（#5）：保持组件挂载，增加 `is-closing` 状态 + transform/opacity 过渡（~180ms），遮罩淡出；再次打开可取消关闭态；尊重 `prefers-reduced-motion`。
- #7 设置中「模块与展示」的怪异微光由 T2 处理，T1 不动 SettingsPage。

## 8. 设置页 / JSON 编辑器（#6、#7、#8）—— T2

- #6：`AppearanceSection` 的 `data-preview-mode` 在 `theme.mode === "auto"` 时必须按真实系统主题渲染（`useSyncExternalStore` 或 effect + `matchMedia`，跟随系统变化实时更新），预览徽章文案与配色一致。
- #7：删除「模块与展示 → 模块展示」卡片里多余的渐变/高光造成的不规则微光：`.settings-module-toggle.is-on` 的 `linear-gradient(140deg, var(--accent-soft), var(--surface))`、图标 accent-soft 光晕等改为干净实色/细边框；开关（switch）也不要有发光阴影。
- #8：引入 VSCode 同款编辑器。`monaco-editor@0.57.0` 已通过国内镜像安装。新建 `components/CodeEditor.tsx`：
  - 直接使用 `monaco-editor` ESM（**不要**用 CDN loader、不要 `@monaco-editor/react`）。
  - JSON 语言、`vs`/`vs-dark` 主题跟随 `document.documentElement.dataset.theme`（用 `MutationObserver`）。
  - 暴露 `value: string; onChange(value: string): void; language?: "json"; readOnly?: boolean; height?: number|string; onMount?`。
  - worker：`import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"; self.MonacoEnvironment = { getWorker: () => new editorWorker() }`。`vite.config.ts` 可加 `optimizeDeps`/`build.chunkSizeWarningLimit` 调整。
  - CSS 在组件内自包含（`CodeEditor.css` 或 monaco 自带样式），编辑器卡片使用现有 `--code-*` 变量和圆角。
  - 设置页「高级 JSON」用 CodeEditor 替换 textarea：保留原有的语法校验/路径错误展示/格式化/重置/保存逻辑、行数/字符数统计、错误标记（用 `monaco.editor.setModelMarkers` 标出 JSON 语法错误行）。
- `SettingsPage.tsx` 的 `MODULE_META` 增加 `insights`（“数据洞察”）条目，并调整模块说明。

## 9. 日历勾选（#15）—— T3

- 「协作日历」今日待办勾选用了 `CheckCheck`（双勾图标），看起来像两个勾且对齐偏上。改为单勾 `Check`，并修正 `.cal-check` 图标居中与线条视觉对齐；完成态勾选动画保持轻量。

## 10. 文件所有权（写作用域，禁止越界）

| 角色 | 文件 |
| --- | --- |
| Lead | `backend/app/db.py`、`config.py`、`main.py`、`scope.py`、`seed.py`、`web/src/types.ts`、`api.ts`、`store.tsx`、`App.tsx`、`components/AppShell.tsx`、`components/ShellScope.css`、整体集成/文档/e2e |
| T1 theme-paper | `web/src/styles.css`、`pages/OverviewPage.tsx`、`OverviewPage.css`、`components/MemberDrawer.tsx` |
| T2 settings-editor | `pages/SettingsPage.tsx`、`SettingsPage.css`、`components/CodeEditor.tsx`（+CSS）、`vite.config.ts` |
| T3 shell-select | `components/Select.tsx`（+CSS）、`TodoDialog.tsx`、`CalendarPage.tsx`、`CalendarPage.css`、`MatrixPage.tsx`、`LinksPage.tsx`、`AnnouncementsPage.tsx`、`RedBlackPage.tsx`（原生 select 替换与 scope 适配）及对应页面 CSS（仅在必要时） |
| T4 data-pages | `pages/TaskOverviewPage.tsx`、`TaskOverviewPage.css`、`pages/InsightsPage.tsx`、`InsightsPage.css`、`components/TaskDialog.tsx`、`components/TagPicker.tsx`（+CSS） |
| T5 backend-data | `backend/app/routers/tasks.py`、`calendar.py`、`workspace.py`、`boards.py`、`backend/app/services/tasks_service.py`、新建 `routers/insights.py`、`services/insights_service.py`、新建测试文件 |
| T6 mail-server | `backend/app/services/mail_server.py`、`email_service.py`、`routers/email.py`、`components/EmailPanel.tsx/.css`、新建测试文件 |

跨文件需求通过 Lead 协调；不要直接改别人的文件。若确实必须改，先给 Lead 发消息说明原因并等待确认。

## 11. 完成标准

1. 自己负责的文件类型检查干净、相关后端测试通过；
2. 在 `http://127.0.0.1:5173` 下用 Edge/Playwright 验证关键交互，并把截图放到 `artifacts/`；
3. 向 Lead 发送完成消息：改动摘要 + 验证命令/结果 + 截图路径 + 遗留问题；
4. 不破坏现有功能与 48 个后端测试；新增行为补测试（后端）。
