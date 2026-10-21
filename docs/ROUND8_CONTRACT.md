# Round 8 Contract — 团队制大改（移除开发组与浏览视角）

> 本文件是第 8 轮重构的**唯一权威契约**。所有实现者（后端、前端、测试）以本文件为准；
> 与旧 README / 旧 CONTRACT / 旧 e2e 冲突时，以本文件为准。**这是破坏性重构**，不做旧 API
> 兼容（旧接口、旧测试、旧文档需要同步改写或删除）。

## 0. 本轮 8 项需求与验收口径

| # | 需求 | 验收口径 |
|---|------|----------|
| 1 | 个人无需展示当前状态 | 成员卡片、成员抽屉、个人主页、头像状态点、账号资料中都不再出现/编辑 `status`（成员可用状态）。数据库新结构不再有 `members.status`，接口不再返回。**注意**：任务进度 `progressStatus`、任务健康 `healthStatus`、待办 `status`、工作项 `status` 是业务状态，必须保留。 |
| 2 | 头像同步所有需要展示头像的地方 | 后端所有“成员/负责人/备份/指派/红黑榜/负载/洞察”载荷都带真实头像 URL；前端所有出现成员的地方都用 `<Avatar src=...>`（含 `Select`、`MultiSelect` 下拉选项，尤其是责任田「备份成员」下拉框）。 |
| 3 | 成员档案卡片按名称排序 | 概览页成员卡、个人主页成员档案卡都按姓名升序（中文用 `Intl.Collator("zh-Hans-CN")`），不得再按 sort_order/创建时间。 |
| 4 | 未激活用户也允许正常登录 | 预创建账号（`email_verified=0`）可以正常走邮箱验证码登录/注册流程并获得会话；验证码校验成功时自动标记已激活。一次性激活链接继续保留为可选快捷方式，不再是登录前置条件。 |
| 5 | 设备管理员不限于 127.0.0.1 | 请求的真实来源 IP 与部署设备一致（loopback、本机网卡 IPv4/IPv6、本机 LAN IP，含 `::ffff:` 映射地址、常见本机反向代理转发头）时，允许以系统内置 Admin 身份登录；远程 IP 拒绝。登录页文案同步说明。 |
| 6 | 管理员可设置访客能访问哪些模块 | 站点设置新增 `guestModules` 开关组（逐模块）；未登录访客只能访问被放行的模块（前端导航/路由 + 后端接口双重校验）。默认放行除「系统设置」外的全部模块，保持旧有访客只读体验。 |
| 7 | 主题跟随系统切换 | 用户个性化设置提供「跟随系统 / 浅色 / 深色」，默认跟随系统；选择跟随系统时监听 `prefers-color-scheme` 实时切换；选择强制主题时覆盖系统。站点 `theme.mode` 不再决定明暗（仅保留字段兼容，界面不再提供该站点级开关）。 |
| 8 | 只有团队，没有开发组/浏览视角 | 数据库、API、前端、角色、设置、工作区管理全部改为**团队（team）为唯一组织单位**；删除 `groups` 表/字段/路由/角色 `group_admin`/`scope` 查询参数/侧边栏「浏览视角」与「开发组切换」；数据只按 `team_id` 隔离。 |

解释约定：第 8 条中“数据只对开发组做隔离和区分”是笔误，按“**数据只对团队做隔离和区分**”执行。

---

## 1. 新数据模型（唯一组织单位 = team）

### 1.1 新库 schema（全新数据库）

删除 `groups` 表。业务表统一用 `team_id`：

```sql
teams(id PK, name, short_name, description, color, sort_order, created_at)

members(id PK, team_id REFERENCES teams ON DELETE CASCADE,
        external_id, name, email, avatar_url, title, role,
        avatar_color, bio, tags JSON, skills JSON,
        joined_at, sort_order, created_at, updated_at)

works(id PK, member_id REFERENCES members ON DELETE CASCADE,
      team_id REFERENCES teams ON DELETE CASCADE,
      title, description, status, period, category, progress,
      sort_order, created_at, updated_at)

todos(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      title, description, due_date, due_time,
      assignee_member_id REFERENCES members ON DELETE SET NULL,
      priority, status, created_by, created_at, updated_at, completed_at)

member_tasks(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      member_id REFERENCES members ON DELETE CASCADE,
      title, description, progress_status, health_status,
      priority, difficulty, expected_date, effort_hours,
      tags JSON, created_by, created_at, updated_at, completed_at)

redblack_boards(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      month, theme, created_at, updated_at, UNIQUE(team_id, month))
redblack_entries(id PK, board_id REFERENCES redblack_boards ON DELETE CASCADE,
      side, member_id, member_name, title, reason, score, sort_order, created_at)

links(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      title, url, description, category, color, sort_order, created_at, updated_at)

matrix_areas(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      area, description, owner_member_id, backup_member_id,
      backup_member_ids JSON, channel, contact, sort_order, created_at, updated_at)

announcements(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      title, content, pinned, level, author_name, created_by, created_at, updated_at)

task_tags(id PK, team_id REFERENCES teams ON DELETE CASCADE,
      name, color, created_by, created_at, updated_at, UNIQUE(team_id, name))

users(id PK, email UNIQUE, name, avatar, avatar_color, bio, skills JSON,
      role CHECK(role IN ('member','team_admin','super')),
      team_ids JSON, email_verified, created_by, created_at, updated_at)
-- 新库不再有 users.group_ids 列
-- email_codes / user_activation_tokens / email_logs / audit_logs / app_meta 不变
-- email_logs 里遗留的 group_id 列可保留为普通 TEXT（新代码写入空串），不影响业务
```

新增索引：`members(team_id, sort_order)`、`works(team_id)`、`todos(team_id, due_date)`、
`member_tasks(team_id, member_id)`、`redblack_boards(team_id, month)`、`links(team_id)`、
`matrix_areas(team_id)`、`announcements(team_id)`、`task_tags(team_id)`。

### 1.2 旧库迁移（`data/` 已存在的 teamstudio.db）

目标：**不丢业务数据**，把所有开发组数据并入其所属团队，然后移除开发组结构。

1. 检测旧结构：`groups` 表存在，且业务表存在 `group_id` 列。
2. `PRAGMA foreign_keys=OFF`；对每个含 `group_id` 的业务表执行**重建**（create new → copy → drop old →
   rename new），把 `group_id` 替换为 `team_id`，值取 `groups.team_id`。表清单：
   `members`、`works`、`todos`、`member_tasks`、`redblack_boards`、`redblack_entries`（本身无
   group_id，但引用的 board 表要重建，保持 FK 名称不变即可）、`links`、`matrix_areas`、
   `announcements`、`task_tags`。
   - 新表结构见 §1.1；`members.status` 迁移时丢弃；`avatar_url` 保留。
   - 迁移中不要重新生成业务行 id（保留 members/works/... 的 id 及引用关系）。
3. 合并冲突处理：
   - `redblack_boards` 同团队同 `month` 多行：保留最早一行，把其余 board 的 entries 移到保留 board
     （保留 side，sort_order 重新递增），删除多余 board。
   - `task_tags` 同团队同名：保留第一行原 id，后续重命名为 `name (2)`、`name (3)`…（保留引用它的
     `member_tasks.tags` JSON 中的 id 不变）。
   - `members` 同团队同账号多行：**允许保留**（历史数据），读模型按 §3.3 合并展示；新写入保证
     一个账号在一个团队最多一行。
4. `users`：`role='group_admin'` → `role='team_admin'`；`team_ids` 并入其 `group_ids` 对应开发组的
   `team_id`；`group_ids` 列可保留但新代码不再读写（新库无此列）。
5. 迁移完成后可保留旧 `groups` 表为孤立表（不再被读写，避免 FK 重建风险），也可在最后安全删除；
   **新代码不得再访问 groups 表**。
6. 迁移必须幂等（重复 `init_db()` 不重复改数据；通过 `app_meta` 记录 `schema_round8_migrated=1`
   或检测列是否已存在）。
7. 全新库走 §1.1 SCHEMA，不执行旧库重建。
8. 迁移失败要抛出明确错误阻止启动，不能半途写入错误数据。

### 1.3 `data/settings.json` 迁移（版本 3）

- `settings.version = 3`。
- 新增 `guestModules`（见 §4.2）。
- `auth.adminWhitelist.ips/ids[]`：删除 `groupIds` 字段；`role` 只允许 `"team_admin"`；
  旧 `group_admin` 条目迁移为 `team_admin`（`teamId` 优先保留；为空的条目直接丢弃，避免无效授权）。
- 站点 `site.theme.mode` 保留字段（`auto|light|dark`）以兼容旧文件，但**不再参与明暗解析**，
  设置页不再提供该开关。
- 旧 key 清理沿用 `migrate_legacy_settings` 的机制。

---

## 2. 身份、角色与权限

### 2.1 角色

- 账号角色：`member`（成员）、`team_admin`（团队管理员）、`super`（超级管理员）。
  **删除 `group_admin` / 开发组管理员。**
- 系统内置 Admin（部署设备身份）不变：`id="device-admin"`，`role=super`，不写入 users 表。
- `team_admin` 的范围是 `team_ids`；`super` 全站；成员只读 + 本人可编辑。
- 管理员白名单 IP/ID 条目只能授予 `team_admin` + 一个 `teamId`。

### 2.2 `CurrentUser`（`backend/app/auth.py`）

字段：`id, name, email, avatar, avatar_color, bio, skills, authenticated, source, is_device_admin,
admin_role, user_role, team_ids, linked_member_id, linked_member_name, linked_member_ids,
email_verified, sso_configured, deploy_device, device_admin_active, session`。
**删除 `group_ids`。**

方法：
- `is_super_admin`、`is_admin`
- `can_edit_settings()`、`can_manage_users()`
- `can_edit_team(team_id)`：super 全部；否则 `team_id in team_ids`
- `can_manage_team(team_id)`：同上（团队管理员可管理本团队结构；创建/删除团队仍仅 super）
- `can_create_team()`：仅 super
- `ensure_team(team_id)`：无权限抛 403 `{"code":"not_admin","message":"你没有该团队的管理权限"}`
- `can_edit_self()`、`linked_member_id_list()`、`is_linked_member(member_id)`（跨团队档案均算本人）
- `as_dict()` → §3.1 载荷；**删除 `admin.groupIds`、`permissions.canViewAllScope`**。

### 2.3 `backend/app/permissions.py`

导出（供各业务 router 使用，签名固定）：
- `require_read_access(user=Depends(get_current_user)) -> CurrentUser`
- `require_authenticated(user) -> CurrentUser`
- `require_team_admin(user, team_id) -> CurrentUser`（游客 401，越权 403）
- `require_member_writer(user, team_id, member_id) -> CurrentUser`（本人自编辑或团队管理员）
- `require_todo_write(user, team_id, todo) -> CurrentUser`（创建者/被指派本人/团队管理员）
- `can_create_todo(user) -> bool`（游客仅在 `features.allowGuestTodoCreate` 时可创建）
- `require_read_module(module: str)`：**dependency factory**，返回 `CurrentUser`。
  先走 `require_read_access`；若用户是未登录访客，再检查
  `settings.modules[module] and settings.guestModules[module]`，不通过抛
  `403 {"code":"guest_module_disabled","message":"该模块未对访客开放"}`。
- `audit(conn, user, action, entity, entity_id="", detail=None)`

模块名与路由映射：`overview`、`tasks`（tasks + task-tags）、`insights`、`calendar`（todos）、
`redblack`、`announcements`、`matrix`、`links`、`settings`。

### 2.4 `backend/app/http.py`

- `get_team(conn, team_id) -> dict`：不存在抛 404 `{"code":"team_not_found","message":"团队不存在"}`。
- `get_member(conn, team_id, member_id) -> dict`：不存在/不属于该团队抛 404
  `{"code":"member_not_found","message":"成员不存在"}`。
- `ok(...)`、`fail(...)`、`text(...)`、`int_value(...)` 不变。

---

## 3. API 契约（破坏性变更）

### 3.1 公共身份 / 引导

`GET /api/auth/me` → `CurrentUser`：

```json
{
  "id": "lin.zhixia", "name": "林知夏", "email": "...",
  "avatar": "/uploads/avatars/x.png", "avatarColor": "#...", "bio": "", "skills": [],
  "authenticated": true, "source": "email", "isDeviceAdmin": false, "isSuperAdmin": false,
  "userRole": "member", "emailVerified": true,
  "admin": { "role": null, "teamIds": [] },
  "linkedMemberId": "m-...", "linkedMemberName": "...", "linkedMemberIds": ["m-..."],
  "ssoConfigured": false, "deployDevice": false, "deviceAdminActive": false,
  "permissions": {
    "canEditSettings": false, "canEditAny": false, "canEditSelf": true,
    "canManageUsers": false, "canManageWorkspace": false
  }
}
```

`GET /api/bootstrap?teamId=...`：

```json
{
  "me": { ... },
  "config": { ...public config，含 modules 与 guestModules... },
  "teams": [
    { "id": "team-aurora", "name": "极光产品团队", "shortName": "极光",
      "description": "", "color": "#...", "memberCount": 12, "pinnedCount": 2 }
  ],
  "active": { "team": { ...同上 TeamRef... } },
  "stats": { "teams": 2, "members": 12, "todos": 3, "pinned": 2,
             "currentWorks": 7, "serverDate": "2026-10-21" },
  "serverTime": "2026-10-21", "deviceAdminName": "Admin"
}
```

- 不再有 `active.group`、`stats.groups`、`TeamRef.groups`。
- 未传 `teamId` 时取第一个团队；传入不存在团队时回落第一个；没有团队时 `active.team=null`。
- `me.linkedMemberId` 指向**当前激活团队**的本人档案（无则 null）；`linkedMemberIds` 为所有团队档案 id。

### 3.2 业务接口基址

所有业务接口由 `/api/teams/{team_id}/groups/{group_id}/...` 改为：

```
/api/teams/{team_id}/overview
/api/teams/{team_id}/members                 GET(由 overview 提供，无独立 GET 列表) / POST
/api/teams/{team_id}/members/{member_id}     PATCH / DELETE
/api/teams/{team_id}/members/{member_id}/works        GET / POST
/api/teams/{team_id}/members/{member_id}/works/{work_id}  PATCH / DELETE
/api/teams/{team_id}/member-candidates?search=
/api/teams/{team_id}/tasks                   GET / POST
/api/teams/{team_id}/tasks/{task_id}         PATCH / DELETE
/api/teams/{team_id}/task-tags               GET / POST
/api/teams/{team_id}/task-tags/{tag_id}      PATCH / DELETE
/api/teams/{team_id}/todos                   GET / POST
/api/teams/{team_id}/todos/{todo_id}         PATCH / DELETE
/api/teams/{team_id}/redblack?month=YYYY-MM  GET / PUT
/api/teams/{team_id}/redblack/rollover       POST
/api/teams/{team_id}/links                   GET / POST
/api/teams/{team_id}/links/{link_id}         PATCH / DELETE
/api/teams/{team_id}/matrix                  GET / POST
/api/teams/{team_id}/matrix/{area_id}        PATCH / DELETE
/api/teams/{team_id}/announcements           GET / POST
/api/teams/{team_id}/announcements/{id}      PATCH / DELETE
/api/teams/{team_id}/insights?range=1w|2w|1m|2m|3m|all   GET
```

- **删除 `scope` 查询参数**；传了也忽略（FastAPI 不校验未知 query）。所有返回不再有 `scope` 字段。
- 每个团队路由开头 `team = get_team(conn, team_id)`；写操作用 `require_team_admin` /
  `require_member_writer` 等。
- 读接口使用 `Depends(require_read_module("<module>"))`（见 §2.3），写接口保持原有鉴权。
- 所有 payload 删除 `groupId/groupName`（**保留 `teamId/teamName` 的地方可保留**；团队视角下
  条目 `teamId` 可直接等于路径 team_id，前端可不再依赖）。

### 3.3 成员/工作负载读模型

`GET /overview`：

```json
{
  "team": { "id": "team-aurora", "name": "极光产品团队", "shortName": "极光",
            "description": "", "color": "#...", "memberCount": 12 },
  "members": [ Member ],
  "works": [ WorkItem ],
  "recentActivity": [ ActivityItem ],
  "stats": { "members": 12, "works": 20, "currentWorks": 7, "doneWorks": 10,
             "plannedWorks": 3, "todos": 6, "openTodos": 4, "doneTodos": 2, "pinned": 2 },
  "workloads": [ Workload ],
  "workloadSummary": { ...不变... }
}
```

`Member`（无 `status`，有 `avatar`；同一团队内同一账号的历史重复档案仍合并为一张卡）：

```json
{
  "id": "m-...", "name": "林知夏", "email": "...", "avatar": "/uploads/avatars/x.png",
  "title": "前端负责人", "role": "成员", "avatarColor": "#...", "bio": "", "tags": [],
  "skills": [], "duties": [], "joinedAt": "2025-01-01",
  "teamId": "team-aurora", "teamName": "极光产品团队",
  "currentWorks": [WorkItem], "historyWorks": [WorkItem],
  "stats": { "current": 1, "done": 2, "todos": 0 },
  "memberIds": ["m-..."],
  "memberships": [
    { "memberId": "m-...", "teamId": "team-aurora", "teamName": "极光产品团队",
      "title": "前端负责人", "role": "成员", "joinedAt": "2025-01-01" }
  ],
  "teamIds": ["team-aurora"], "teamNames": ["极光产品团队"]
}
```

- `members` 数组按 `name` 升序返回（Python `sorted(key=name.casefold())` 即可；前端再用
  `Intl.Collator("zh-Hans-CN")` 排序保证中文拼音序）。
- `WorkItem` 删除 `groupId/groupName`，保留 `teamId/teamName`（可省 team 字段）。

`Workload` 在原有字段上：`avatar: string`（成员真实头像）；删除 `groupIds/groupNames`；
`memberships` 结构同 Member；保留 `memberIds/teamIds/teamNames`。

`MemberTask`：删除 `groupId/groupName`；新增 `memberAvatar: string`（成员真实头像 URL）；
`memberAvatarColor` 保留（用于无头像时渐变）。

`Todo`：删除 `groupId/groupName`；新增 `assigneeAvatar: string`；`assigneeColor` 保留。

`RedBlackEntry`：删除 `groupId/groupName`；新增 `memberAvatar: string`。

`MatrixArea`：删除 `groupId`；新增 `ownerAvatar: string`；`backups[]` 元素为
`{ "id", "name", "color", "avatar" }`；legacy `backupColor` 保留，新增 `backupAvatar`。

`Announcement`：删除 `groupId`；新增 `authorAvatar: string`（按 `created_by` 匹配 users.id，
匹配不到再按 author_name 匹配 users.name，仍无则空串）。

`Infer`：`GET /insights` 返回：

```json
{
  "range": { "key": "1m", "label": "近 1 个月", "days": 30, "start": "..." },
  "summary": { "teams": 1, "members": 12, "tasks": 30, "openTasks": 8,
               "completedTasks": 22, "overdueTasks": 1, "blockedTasks": 0,
               "completionRate": 73.3, "todos": 6, "completedTodos": 4,
               "todoCompletionRate": 66.7, "loadPoints": 80, "capacityPoints": 180,
               "averageLoadPercent": 44.4 },
  "members": [ { "memberId", "memberName", "memberTitle", "avatar", "avatarColor",
                 "teamId", "teamName", "tasks", "openTasks", "completedTasks",
                 "overdueTasks", "blockedTasks", "completionRate", "loadPoints",
                 "todos", "completedTodos" } ],
  "trend": { "granularity": "day|week", "buckets": [ ... ] }
}
```

- **删除 `groups` 与 `teams` 对比表**（团队视角下无意义）：`InsightsGroupRow`/`InsightsTeamRow`
  及前端两张表删除。
- `members` 行新增 `avatar`；不再有 `groupId/groupName`。

Redblack 返回（团队视角，无聚合）：`{ month, board: {id, teamId, month, theme, updatedAt, red, black},
availableMonths }`；不再有 `scope` / `boards[]` / 只读汇总分支。

Profile（`GET /api/profile`、`GET /api/users/{id}/profile`）：
- `Memberships` 每条为 `{ memberId, memberName?, teamId, teamName, title, role, joinedAt }`，
  **无 group 字段、无 status**。
- `ProfileMember`：`{ id, name, email, title, role, avatarColor, avatar, bio, tags, skills,
  teamId, teamName }`。
- `ProfileDuty` / `ProfileTodo` / `ProfileRedBlackEntry`：`teamId/teamName`，无 group。
- `adminScope`：

```json
{
  "role": "super|team_admin|member",
  "roleLabel": "超级管理员|团队管理员|成员",
  "summary": "极光产品团队 团队管理员",
  "teams": [{ "id": "team-aurora", "name": "极光产品团队" }],
  "isDeviceAdmin": false
}
```
删除 `groups` 字段。

### 3.4 账号、工作区、领域设置

`GET /api/users` → `UserAccount` 删除 `groupIds`；`roleLabel` 仅三种。
`POST /api/users` / `PATCH /api/users/{id}` body：`{ email, name?, role?, teamIds? }`，**
**不再接受 `groupIds`**（传了忽略）。`role` 只允许 member/team_admin/super。

`GET /api/workspace/manage`：

```json
{
  "teams": [ { "id", "name", "shortName", "description", "color",
               "memberCount": 12, "canDelete": true } ],
  "permissions": { "canCreateTeam": true, "canManageAnyTeam": true }
}
```
删除 groups/groupCount/canCreateGroup。`POST /api/workspace/teams`、`DELETE /api/workspace/teams/{id}`
保留（`DELETE` 仍需 `confirmName`，级联删除团队下全部业务数据并写审计）。删除
`/api/workspace/teams/{team}/groups...` 接口。

`GET /api/settings/domain`：

```json
{
  "teams": [ { "id", "name", "shortName", "description", "color", "canEdit": true } ],
  "permissions": { "canEditSite": true, "canEditStructure": true,
                   "canEditTeam": true, "isSuperAdmin": true, "isDeviceAdmin": false }
}
```
删除 groups / canEditGroup / `PATCH /api/settings/teams/{team}/groups/{group}`。

`GET /api/settings/workspace` 辅助接口：仅返回 `teams`（`{id,name,short_name,color}`），删除 groups。

### 3.5 设备管理员检测（需求 5）

`backend/app/auth.py` 重写本机判定：

- 取候选 IP：TCP peer (`request.client.host`)；`X-Forwarded-For` 的**最后一个**条目（本地代理追加
  的真实来源）、`X-Real-IP`、`Forwarded` 的 `for=`；全部去空白、去引号。
- 归一化 IPv4-mapped IPv6（`::ffff:192.168.1.5` → `192.168.1.5`）。
- 本机地址集合（启动时计算并缓存，另可每次补算）：`127.0.0.1`、`::1`、`localhost`、`testclient`、
  `socket.gethostname()` / `socket.getfqdn()` 的 `getaddrinfo` 全部地址、`gethostbyname_ex` 全部地址；
  支持环境变量 `TEAMSTUDIO_DEVICE_IPS`（逗号分隔，追加放行）。
- `is_local_request(request)`：任一候选 IP 命中本机地址集合即 true。peer 是本机、但 forwarded 头里
  真实 IP 是远程（本机反代）时返回 false。
- `POST /api/auth/device/login`、`GET /api/auth/config` 的 `deployDevice/deviceAdminActive`、
  `build_user` 自动设备管理员逻辑均复用该判定。
- 登录页文案改为「在部署设备上访问（本机或与设备一致的 IP）时，可直接以系统内置管理员身份登录」。

### 3.6 未激活账号登录（需求 4）

- `POST /api/auth/email/request`：删除 `account_not_activated` 403 分支；未激活账号与普通账号
  一样发验证码（`registered=false,purpose=register` 或 `login` 均可，建议未激活视为
  `purpose="register"`，但不要阻止发送）。
- `POST /api/auth/email/verify`：保持「未验证账号校验成功后 `mark_email_verified`」行为。
- 激活链接接口保持不变，仅作为快捷方式。
- 登录页删除“未激活只能走激活链接”的提示，改为可正常输入邮箱获取验证码。

---

## 4. 配置（`backend/app/config.py`）

### 4.1 新模型

```python
class GuestModuleFlags(StrictModel):
    overview: bool = True
    calendar: bool = True
    redblack: bool = True
    links: bool = True
    matrix: bool = True
    announcements: bool = True
    tasks: bool = True
    insights: bool = True
    settings: bool = False

class Settings(StrictModel):
    version: int = 3
    ...
    modules: ModuleFlags = Field(default_factory=ModuleFlags)
    guestModules: GuestModuleFlags = Field(default_factory=GuestModuleFlags)
    ...
```

- `AdminIdEntry` / `AdminIpEntry`：`role: Literal["team_admin"] = "team_admin"`、`teamId: str = ""`、
  删除 `groupIds`。校验：role 只允许 team_admin；`teamId` 为空时该条目不授予任何权限（允许保存，
  避免旧配置无法加载）。
- `public()` 增加 `"guestModules": cfg.guestModules.model_dump(mode="json")`。
- `migrate_legacy_settings`：补 `guestModules`、清理 whitelist `groupIds`/`group_admin`、
  删除旧 `modules.email`、版本升 3、`site.theme.mode` 保留不参与解析。
- `settings.schema()` 自动反映新字段即可。

### 4.2 前端 `PublicConfig`

```ts
guestModules: ModuleFlags;   // settings 字段可为 false
```

---

## 5. 前端契约

### 5.1 `store.tsx`

```ts
type ThemePreference = "auto" | "light" | "dark";

interface AppContextValue {
  data: BootstrapData | null;
  config: PublicConfig | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  route: string;
  theme: "light" | "dark";              // 实际生效主题
  themePreference: ThemePreference;     // 用户偏好
  setThemePreference: (pref: ThemePreference) => void;
  canManageActiveTeam: boolean;
  canEditSelf: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  permissions: CurrentUser["permissions"] | null;
  currentTeam: TeamRef | null;
  moduleVisible: (module: keyof ModuleFlags) => boolean; // 访客叠加 guestModules
  reload: (silent?: boolean) => Promise<void>;
  selectTeam: (teamId: string) => Promise<void>;
  navigate: (page: string, params?: Record<string, string>) => void;
}
```

- localStorage：`teamstudio.team`（保留）、`teamstudio.theme.preference`（新，默认 `auto`；
  首次读取时把旧的 `teamstudio.theme` 的 `light/dark` 迁移为偏好并删除旧 key）。
- `theme` 解析：偏好非 auto 用偏好；否则 `matchMedia("(prefers-color-scheme: dark)")`；
  **无论站点配置如何，偏好 auto 时必须实时监听系统变化**。`config.site.theme.mode` 不参与。
- accent / accentSecondary / radius / title 仍来自 `config.site`。
- bootstrap 调 `api.bootstrap(teamId)`，只维护 team 选择。
- 删除 `scope`、`scopeLabel`、`scopeOptions`、`setScope`、`currentGroup`、`selectGroup`、
  `toggleTheme`。
- `isGuest = !me.authenticated || me.source === "guest"`；`moduleVisible(module)`：
  `Boolean(config.modules[module]) && (!isGuest || Boolean(config.guestModules[module]))`。
- AppContext 依赖数组保持正确。

### 5.2 `types.ts`

- 删除：`GroupRef`、`GroupDetail`、`ScopeKind`、`ScopeMeta`、`ScopeGroupRef`、
  `InsightsGroupRow`、`InsightsTeamRow`、`InsightsSummary.groups`、`ProfileAdminScopeGroup`、
  `Member.status`、`Member.memberships[].groupId/groupName/status`、`ManagedGroup`、
  `DomainGroupSettings`、`GroupDetail` 等 group 概念。
- 修改：`TeamRef { id,name,shortName,description,color,memberCount,pinnedCount }`；
  `BootstrapData.active { team: TeamRef | null }`；`stats { teams,members,todos,pinned,currentWorks?,serverDate? }`；
  `Member`、`MemberTask`、`Todo`、`Workload`、`RedBlackEntry`、`MatrixArea`、
  `MatrixBackupMember`、`Announcement`、`InsightsMemberRow`、`InsightsData`、`ProfileData`、
  `WorkspaceManageData`、`DomainSettingsData`、`UserAccount`、`AdminIdEntry/AdminIpEntry`、
  `MemberMembership`、`TaskMemberOption`(? 见 TaskDialog) 按 §3 调整。
- 新增 `PublicConfig.guestModules`；`ScopeKind` 相关一律删除。
- `ProfileAdminScope` 只保留 `role/roleLabel/summary/teams/isDeviceAdmin`。
- 所有新头像字段使用 `avatar`（成员）或 `memberAvatar` / `assigneeAvatar` / `ownerAvatar` /
  `authorAvatar` 命名，见 §3.3。

### 5.3 `api.ts`

所有业务方法去掉 `groupId` 参数与 `scope` 参数；基址改为
`const teamBase = (teamId) => \`/api/teams/${encodeURIComponent(teamId)}\``。

签名示例（**所有调用点按此改写**）：
```ts
bootstrap(teamId?)；
overview(teamId)；
tasks(teamId)；
taskTags(teamId)；createTaskTag(teamId, body)；updateTaskTag(teamId, tagId, body)；
deleteTaskTag(teamId, tagId)；
createTask(teamId, body)；updateTask(teamId, taskId, body)；deleteTask(teamId, taskId)；
updateMember(teamId, memberId, body)；memberCandidates(teamId, search?)；
createMember(teamId, body)；deleteMember(teamId, memberId)；
createWork(teamId, memberId, body)；updateWork(teamId, memberId, workId, body)；
deleteWork(teamId, memberId, workId)；
todos(teamId, month?)；createTodo(teamId, body)；updateTodo(teamId, todoId, body)；
deleteTodo(teamId, todoId)；
redblack(teamId, month?)；saveRedblack(teamId, body)；rolloverRedblack(teamId, month)；
links(teamId)；createLink(teamId, body)；updateLink(teamId, linkId, body)；deleteLink(teamId, linkId)；
matrix(teamId)；createMatrix(teamId, body)；updateMatrix(teamId, areaId, body)；deleteMatrix(teamId, areaId)；
announcements(teamId)；createAnnouncement(teamId, body)；updateAnnouncement(teamId, id, body)；
deleteAnnouncement(teamId, id)；
insights({ teamId, range? })；
domainSettings()；updateDomainTeam(teamId, body)；  // 删除 updateDomainGroup
manageWorkspace()；createTeam(body)；deleteTeam(teamId, confirmName)； // 删除 group 接口
listUsers()；createUser(body 无 groupIds)；updateUser(userId, body 无 groupIds)；deleteUser；
```
`createUser` body `{ email, name?, role?, teamIds? }`。

### 5.4 页面/组件改造清单

- `AppShell.tsx`：
  - 删除「开发组切换」`.group-switcher`、删除「浏览视角」`.scope-switcher` 整块；
  - 团队切换器显示 `memberCount`；文案「数据按团队隔离」；
  - 面包屑：团队名 / 页面名（删除 scope 分支）；
  - 导航按 `moduleVisible` 过滤（访客自动受 guestModules 限制）；
  - 角色文案删除 group_admin；`me.admin.groupIds` 引用删除；
  - 主题：顶栏主题按钮改为三选一菜单（跟随系统/浅色/深色）+ 直接切换按钮（保持可用），
    与 store 的 `themePreference/setThemePreference` 联动；
  - 删除 `.group-switcher`/`.scope-switcher` 对应的 CSS（styles.css / ShellScope.css）。
- `App.tsx`：页面守卫用新的 `moduleVisible`；guest 非授权模块显示「模块未对访客开放」。
- `WorkspaceManager.tsx`：仅团队增删；删除开发组面板/列/创建入口；文案改为团队。
- `LoginPage.tsx`：设备管理员说明改为「部署设备 / 真实 IP 与部署设备一致」；未激活账号可正常
  验证码登录；删除未激活限制提示；设备登录按钮 `deployDevice` 时可见。
- `OverviewPage.tsx`：
  - 删除 scope/group 相关徽章、分组、`groupName` 文案；
  - 成员卡按姓名排序（`Intl.Collator("zh-Hans-CN")`）；
  - 删除成员 `status` 展示（若有）；
  - 头像使用 `member.avatar`；负载区成员头像使用 `workload.avatar`；
  - 新建成员/任务等调用按新 api 改（team 级）。
- `ProfilePage.tsx`：删除 group 档案/`groupName`/status；成员档案卡按姓名排序；
  新增「个性化设置」卡片：主题三选（跟随系统/浅色/深色，默认跟随系统），使用
  `useApp().themePreference/setThemePreference`；档案条目带团队标签。
- `MemberDrawer.tsx`：删除 `status` 展示与编辑（保存 payload 不带 status）；删除开发组徽章，
  显示所属团队；头像用 `member.avatar`。
- 各业务页面（TaskOverview、TaskDialog、Calendar、TodoDialog、RedBlack、Links、Matrix、
  MatrixNetwork、Announcements、Insights）：删除 group/scope 概念与徽章、删除 `api` 调用的
  groupId/scope 参数；头像按 §3.3 新字段渲染；`Select`/`MultiSelect` 选项传头像。
- `Select.tsx` / `MultiSelect.tsx`：`SelectOption` / `MultiSelectOption` 增加 `avatar?: string`；
  选项与触发器用 `<Avatar name src={option.avatar} color={option.color} ...>` 渲染，替代纯色点。
  调用点（TaskDialog 成员、TodoDialog 负责人、MatrixPage 负责人/备份成员、TagPicker 不需头像）
  传 `avatar`。
- `MatrixPage.tsx`：责任田负责人/备份成员以真实头像展示；**备份成员下拉框必须显示真实头像**。
- `InsightsPage.tsx`：删除「开发组 / 团队」两张表；成员表增加头像；KPI 删除 groups 指标。
- `AnnouncementsPage.tsx`：作者头像用 `authorAvatar`。
- `SettingsPage.tsx`：
  - 外观：删除站点「明暗模式」选择（主题由用户个性化设置决定），保留强调色/圆角；
  - 模块：新增「访客可访问模块」逐项开关（`guestModules`，settings 模块不可放行或隐藏）；
  - 账号与角色：角色仅成员/团队管理员/超级管理员，范围只选团队；
  - 管理员白名单：仅团队管理员 + 团队；
  - 领域设置（工作区设置）：只展示团队，删除开发组编辑；
  - 所有 `groupIds/group_admin/group` 文案、类型、请求参数删除；JSON 编辑器 schema 自动同步。
- `styles.css` / `ShellScope.css`：删除不再使用的 group/scope 样式；保留团队切换、访客提示等。

### 5.5 头像数据传播（需求 2 的核心）

后端在以下载荷中补充真实头像（优先 `users.avatar`，通过
`lower(users.email)=lower(members.email) OR lower(users.id)=lower(members.external_id)` 关联；
无账号时用 `members.avatar_url`）：
`Member.avatar`、`Workload.avatar`、`MemberTask.memberAvatar`、`Todo.assigneeAvatar`、
`RedBlackEntry.memberAvatar`、`MatrixArea.ownerAvatar`、`MatrixArea.backups[].avatar`、
`InsightsMemberRow.avatar`、`Announcement.authorAvatar`、`ProfileMember.avatar`、
`MemberCandidate.avatar`（已有）。

前端所有列表/卡片/抽屉/下拉/浮层中的成员头像统一用 `<Avatar src=...>`，不得再用
`initials`/纯色圆点代替（设备管理员 Admin 无上传头像时允许用默认字母头像）。

---

## 6. 工作拆分与文件写作用域（并行开发用）

> 每个成员只改自己作用域内的文件；共享文件（types/api/store）由 frontend-core 独占。
> 需要跨作用域改动时先报告 Lead，不要直接改别人的文件。

| 任务 | 负责人 | 写作用域 |
|------|--------|----------|
| T1 后端核心 | backend-core | `backend/app/db.py`、`auth.py`、`permissions.py`、`config.py`、`http.py`、`main.py`、`routers/auth.py`、`routers/bootstrap.py`、`routers/workspaces.py`、`routers/system.py`、`services/accounts.py`、删除 `backend/app/scope.py` |
| T2 后端成员/账号/种子 | backend-workspace | `backend/app/routers/workspace.py`、`profile.py`、`users.py`、`services/member_identity.py`、`backend/app/seed.py` |
| T3 后端业务/设置 | backend-features | `backend/app/routers/tasks.py`、`boards.py`、`calendar.py`、`insights.py`、`settings.py`、`services/tasks_service.py`、`services/insights_service.py` |
| T4 前端核心 | frontend-core | `web/src/types.ts`、`api.ts`、`store.tsx`、`App.tsx`、`components/AppShell.tsx`、`LoginPage.tsx/.css`、`Avatar.tsx`、`Select.tsx/.css`、`MultiSelect.tsx/.css`、`WorkspaceManager.tsx/.css`、`lib/utils.ts`、`lib/scope.ts`（删除）、`ShellScope.css`、`styles.css` |
| T5 前端页面 | frontend-pages | `web/src/pages/OverviewPage.tsx/.css`、`TaskOverviewPage.tsx/.css`、`CalendarPage.tsx/.css`、`RedBlackPage.tsx/.css`、`LinksPage.tsx/.css`、`MatrixPage.tsx/.css`、`AnnouncementsPage.tsx/.css`、`InsightsPage.tsx/.css`、`ProfilePage.tsx/.css`、`components/MemberDrawer.tsx`、`TaskDialog.tsx`、`TodoDialog.tsx`、`WorkloadMeter.tsx`、`WorkloadDetailDialog.tsx/.css`、`MatrixNetwork.tsx/.css` |
| T6 前端设置页 | frontend-settings | `web/src/pages/SettingsPage.tsx/.css` |
| T7 测试/验收 | qa | `backend/tests/**`、`web/e2e/**`、`scripts/verify.ps1`（必要时） |
| T8 文档/集成 | lead | `README.md`、`docs/ROUND8_CONTRACT.md`、最终修复与验证 |

依赖：T2/T3 依赖 T1 的 `http.py`/`auth.py`/`permissions.py` 接口（契约已固定，可并行写）；
T5/T6 依赖 T4 的 `types.ts/api.ts/store.tsx`（契约已固定，可并行写，最后统一 `npm run typecheck`）。
T7 在 T1–T6 完成后运行。

---

## 7. 验证命令

```powershell
# 后端测试
.\.venv\Scripts\python.exe -m pytest backend\tests -q

# 前端类型检查 / 构建
npm run typecheck --prefix web
npm run build --prefix web

# 启动
.\scripts\start.ps1 -NoBrowser
# 演示数据（重建后）
.\scripts\seed-demo.ps1
```

验收必须覆盖：
1. 侧边栏没有「浏览视角」「开发组切换」，团队切换正常；
2. 成员卡/抽屉/个人主页没有“当前状态”，成员卡按姓名排序；
3. 责任田负责人/备份成员下拉框及各处头像显示真实图片；
4. 预创建未激活账号可直接用邮箱验证码登录成功；
5. 本机用 LAN IP / localhost 访问时可用系统内置管理员登录，远程 IP 不可；
6. 设置中关闭某模块的访客访问后，访客前端入口消失、直接访问接口被拒；
7. 操作系统明暗切换时页面跟随（偏好 auto）；强制浅/深色后不再跟随；
8. 所有页面不再出现“开发组”字样与 group 字段。
