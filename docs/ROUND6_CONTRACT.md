# Round 6 optimization contract · 成员档案选人与管理员主页范围

> Working contract for the current optimization round. `CONTRACT.md` remains the long-term
> source of truth and is updated at the end of the round.

本轮只做两项功能优化，不动既有数据模型语义（`users` / `members` / `members.external_id` 继续复用）：

## 1. 成员档案：只能从已注册用户中添加

### 1.1 目标

- 概览页「成员档案 → 添加成员」不再允许自定义姓名 / 邮箱 / 成员 ID。
- 只能从 **已注册账号**（`users` 表，含预创建但未激活的账号）中选择，且该账号
  **尚未出现在当前开发组的成员档案中**。
- 选择控件支持搜索（按姓名 / 邮箱 / 账号 ID）。
- 系统内置管理员是内置身份，不是 `users` 行，因此天然不可被选入团队 / 开发组。

### 1.2 新接口：`GET /api/teams/{teamId}/groups/{groupId}/member-candidates`

- 权限：`require_admin`（系统内置管理员 / 超级管理员 / 本团队团队管理员 / 本开发组开发组管理员）。
  游客 `401 authentication_required`；越权 `403`；团队或开发组不存在 `404 group_not_found`。
- Query：`search?: string`（可选，按姓名 / 邮箱 / 账号 id 做大小写不敏感包含匹配）。
- 返回：

```json
{
  "candidates": [
    {
      "id": "lin.zhixia",
      "name": "林知夏",
      "email": "lin.zhixia@corp.example",
      "avatar": "",
      "avatarColor": "#7c3aed",
      "role": "member",
      "roleLabel": "成员",
      "emailVerified": true,
      "skills": ["React"]
    }
  ],
  "total": 1
}
```

- 排除规则（同一开发组内）：
  - 存在成员档案满足 `lower(members.email) = lower(users.email)`；或
  - 存在成员档案满足 `lower(members.external_id) = lower(users.id)`。
- 预创建未激活账号（`emailVerified=false`）必须包含，前端标注「待激活」。
- 系统内置管理员不出现（不在 `users` 表中）。

### 1.3 修改：`POST /api/teams/{teamId}/groups/{groupId}/members`

- 请求体：`{ "userId": "<账号 id>", "title"?: string, "role"?: string, "status"?: string,
  "sortOrder"?: number }`。
- `userId` 必填（缺失 / 空串 → `422 validation_error`），按账号 id 精确查找，
  也接受用邮箱查找（兼容手动调用）。
- 账号不存在 → `404 user_not_found`；`userId=device-admin` 同样 404（内置身份不可加入）。
- 该账号已在本开发组档案中 → `409 member_exists`（message 说明已在当前开发组）。
- 身份字段一律由账号派生，**忽略**请求体中的 `name` / `email` / `id` / `avatar` 等自定义值：
  - `members.external_id = users.id`
  - `members.name = users.name`（为空时回退账号 id）
  - `members.email = users.email`
  - `members.avatar_url = users.avatar`
  - `members.avatar_color = users.avatar_color`
  - `members.bio = users.bio`
  - `members.skills = users.skills`
  - `members.tags = []`
  - `members.id = new_id("member")`
  - `title` / `role` / `status` / `sortOrder` 仍可设置（组织信息）。
- 返回 `{ member: MemberDetail }`，并写入 `member.create` 审计（detail 含 `userId`）。

### 1.4 前端

- `AddMemberDialog`（`web/src/pages/OverviewPage.tsx`）：
  - 打开时请求候选列表；使用 `web/src/components/Select.tsx` 的 `searchable` 下拉框。
  - 选项：姓名为主标题，描述为 `邮箱 · 角色 + 待激活`；选中后展示头像 / 姓名 / 邮箱 / 待激活徽章。
  - 组织字段保留可选的「职位」「团队角色」。
  - 提交 `{ userId, title, role }`；未选择账号时禁用提交。
  - 无候选时给出说明（到「系统设置 → 账号与角色」创建 / 预创建账号）。
  - 失败时展示后端错误（如 `member_exists`）。
- `api.ts` / `types.ts` 增加 `memberCandidates()` 与 `MemberCandidate` 类型，`createMember` 入参改为
  `{ userId, title?, role?, status? }`。

## 2. 个人主页：说明管理员的管理范围；系统内置管理员对外不可见

### 2.1 目标

- 团队管理员主页要说明管理哪个 / 哪些团队；开发组管理员主页要说明管理哪个 / 哪些开发组。
- 超级管理员只需说明「超级管理员」，不展开具体团队 / 开发组。
- 系统内置管理员：
  - 出现在个人主页 / 账号接口时只作为「超级管理员」说明；
  - 对其它用户不可见（账号列表不再为其他身份渲染系统内置管理员行）；
  - 不可加入团队或开发组（第 1 节已保证；`userId=device-admin` 被拒绝）。

### 2.2 `ProfilePayload` 新增 `adminScope`

```json
{
  "adminScope": {
    "role": "super | team_admin | group_admin | member",
    "roleLabel": "超级管理员 | 团队管理员 | 开发组管理员 | 成员",
    "summary": "超级管理员 | 极光产品团队 团队管理员 | 前端体验组 开发组管理员 | （成员为空串）",
    "teams": [{ "id": "team-aurora", "name": "极光产品团队" }],
    "groups": [{ "id": "grp-frontend", "name": "前端体验组",
                 "teamId": "team-aurora", "teamName": "极光产品团队" }],
    "isDeviceAdmin": false
  }
}
```

- `super`（含系统内置管理员）：`summary="超级管理员"`，`teams=[]`、`groups=[]`。
- `team_admin`：`teams` 按账号（或 IP/SSO 白名单）的 `teamIds` 解析名称，`summary` 为
  “团队名 + 团队管理员”，多个团队用「、」连接。
- `group_admin`：`groups` 解析开发组与所属团队，`summary` 为“开发组名 + 开发组管理员”，
  多个开发组用「、」连接。
- `member`：`summary=""`，两个数组为空。
- 只保留仍存在的团队 / 开发组（解析不到的直接忽略，不报错）。
- 该字段对访问他人主页的已登录用户 / 游客可见（管理员范围是公开的团队信息）。

### 2.3 系统内置管理员可见性

- `GET /api/users`：仅当**请求者本人就是系统内置管理员**时，才返回合成行
  `{ id: "device-admin", isDeviceAdmin: true, ... }`；存储的超级管理员账号不再看到该行。
- `GET /api/users/{userId}/profile`：除自己外，`device-admin` 依旧 `404 user_not_found`。
- `POST /members` 的 `userId` 校验天然拒绝系统内置管理员（不在 `users` 中）。

### 2.4 前端

- `ProfilePage.tsx` 头部展示：
  - 超级管理员（含系统内置管理员）：仅角色徽章「超级管理员」，系统内置管理员另显示「系统内置」徽章；
  - 团队管理员：展示管理团队 chip（如「极光产品团队 · 团队管理员」）；
  - 开发组管理员：展示管理开发组 chip（如「前端体验组 · 开发组管理员」，并注明所属团队）；
  - 普通成员：不额外展示。
- 样式加入 `ProfilePage.css`，明暗主题均需可读。

## 3. 验收

- 后端：pytest 全量通过（含新增 / 更新的成员候选、受限建成员、管理员范围、系统内置管理员可见性用例）。
- 前端：`npm run typecheck --prefix web`、`npm run build --prefix web` 通过。
- E2E：新增 `web/e2e/round6-features.mjs`，在真实浏览器中验证：
  1) 添加成员只能搜索选择已注册账号，自定义输入框不存在；
  2) 团队 / 开发组管理员主页出现对应范围说明，超级管理员只显示超级管理员；
  3) 存储超级管理员账号的账号列表不含系统内置管理员行。
- 文档：`README.md` 功能清单 / 个人主页 / 账号与角色小节、`CONTRACT.md` 对应接口段落更新。
