# Round 7 Contract — 一位成员加入多个开发组 / 团队

本文件定义 Round 7 的跨开发组成员身份规则与接口增量。所有改动必须向后兼容：
单开发组（`scope=group`）的现有字段、排序与计数保持不变，新增字段是**追加式**的。

## 1. 身份模型

同一个已注册账号可以在多个开发组（可跨团队）拥有 `members` 档案行。同一账号的这些行
共享登录身份，但没有统一的"人员 ID"列，因此读接口按下列规则归并：

```
personKey = lower(external_id)            # 优先：账号 ID
          = lower(email)                  # 其次：邮箱
          = "member:" + id                # 兜底：独立成员行
```

- `external_id` / `email` 都为空的行各自视为独立人员（不要按空串归并）。
- 同一 `personKey` 的多行按开发组排序（`g.sort_order, g.name`）、再按
  `m.sort_order, m.created_at, m.id` 排列；**第一行**是这次请求的"主档案"。
- 聚合视角（`scope=team|all`）中，同一个人只出现一张成员卡 / 一条负载记录；
  `scope=group` 中一个开发组内同一账号本来就只允许一行，因此行为不变
  （仍然按 personKey 去重，防止历史脏数据产生重复卡片）。
- 个人主页（`GET /api/profile`、`GET /api/users/{id}/profile`）本来就按邮箱 / 账号 ID
  汇总该账号在**所有**开发组的档案行，保留该行为；前端要按成员档案逐条展示团队/开发组。

## 2. 读接口增量

### 2.1 `GET .../overview`

`members[]`（每张成员卡）新增：

```json
{
  "id": "m-front",
  "memberIds": ["m-front", "m-platform"],
  "memberships": [
    {
      "memberId": "m-front",
      "groupId": "grp-frontend",
      "groupName": "前端体验组",
      "teamId": "team-aurora",
      "teamName": "极光产品团队",
      "title": "前端负责人",
      "role": "负责人",
      "status": "available",
      "joinedAt": "2026-01-01T09:00:00+08:00"
    },
    { "memberId": "m-platform", "groupId": "grp-platform", "groupName": "服务端平台组", "...": "..." }
  ],
  "groupIds": ["grp-frontend", "grp-platform"],
  "groupNames": ["前端体验组", "服务端平台组"],
  "teamIds": ["team-aurora"],
  "teamNames": ["极光产品团队"]
}
```

- `id` 保持为**主档案**的 id（单组视角下与原值完全一致）。
- 其余既有字段（`name/title/role/bio/tags/skills/avatar/stats/currentWorks/...`）取自主档案；
  `currentWorks` / `historyWorks` / `stats.current` / `stats.done` / `stats.todos` 汇总该人员
  在**当前 scope 内**全部档案行。
- `memberships` 只包含当前 scope 内的档案行（`scope=group` 时长度为 1）。
- `stats.members` 与 `workloadSummary.members` 改为**去重后的人员数**。
- `works` 顶层列表不变（仍是逐 work 行）。
- `recentActivity` 不变；前端用 `memberIds` 把活动条目映射回合并后的卡片。

### 2.2 `GET .../tasks` 与 `GET .../overview` 的 `workloads[]`

```json
{
  "memberId": "m-front",
  "memberIds": ["m-front", "m-platform"],
  "memberships": [{ "memberId": "m-front", "groupId": "grp-frontend", "groupName": "前端体验组", "teamId": "team-aurora", "teamName": "极光产品团队" }],
  "groupIds": ["grp-frontend", "grp-platform"],
  "groupNames": ["前端体验组", "服务端平台组"],
  "teamIds": ["team-aurora"],
  "teamNames": ["极光产品团队"]
}
```

- 负载数值（`currentPoints` / `averagePoints` / `openTasks` / `completedTasks` /
  `blockedTasks` / `overdueTasks` / `currentLoadPercent` / `averageLoadPercent` / `level`）
  按该人员在 scope 内**全部任务**合并计算（各档案行的点数与计数求和；平均负载按合并后的
  任务集合在同样的 4 个滚动窗口上重新计算）。
- `summary.members` 为去重人员数；其它 summary 数字为合并后的任务统计。
- `scope=group` 的排序、数值与现状一致。

### 2.3 `GET .../insights`

`members[]` 同样按 personKey 去重（合并统计，`memberId` 用主档案 id），但**不新增字段**
（保持既有精确字段集合）。`summary.members` 为去重人员数；`groups[]` / `teams[]` 的
成员计数语义不变（仍按档案行统计，避免跨组归属丢失）。

### 2.4 会话身份（`GET /api/bootstrap` 的 `me`）

- `linkedMemberId`：**当前激活开发组**内的本人档案 id；当前开发组没有本人档案时为 `null`。
  这样右上角「我的成员卡片」在切换开发组后总能定位到当前组的档案。
- `linkedMemberIds`：该账号在全部开发组的档案 id 列表（按开发组排序），供前端判断"这是我"
  以及在聚合视角中定位合并卡片。
- `GET /api/auth/me` 没有激活开发组上下文：`linkedMemberId` 保留全局首个档案（按开发组
  排序），并同样返回 `linkedMemberIds`。
- 写权限（任务/待办/成员个人资料、删除成员时禁止删除自己）用 `linkedMemberIds` 判断，
  即账号在任一开发组的档案都算"本人"；原先只传 `linked_member_id` 的单元测试身份仍然有效。

## 3. 前端要求

1. **概览成员卡**：`scope=team|all` 时同一个人员只有一张卡；卡上展示该人员全部所属开发组
   （每个组一个徽章，超出折叠为 `+N`）。顶部计数、搜索、骨架屏、空状态与卡片数量一致。
   点击 `#/overview?member=<任一成员档案 id>`（含右上角「我的成员卡片」）必须打开合并后的卡。
2. **成员抽屉**：展示该人员全部所属团队 / 开发组（`memberships`），"这是我"判定使用
   `linkedMemberIds`；编辑 / 删除入口仍按主档案所属开发组路由。
3. **任务总览**：成员负载卡与成员筛选也按人员去重；按成员筛选、负载详情的任务列表必须
   覆盖该人员全部档案行的任务；从详情打开成员档案使用主档案 id。
4. **个人主页**：展示该账号全部档案（团队 / 开发组标签、责任田、任务、待办、红黑榜），
   不重复、不丢失；同一开发组的记录只出现一次。
5. **右上角「我的成员卡片」**：在当前开发组有本人档案时必须打开该开发组的成员卡；
   当前开发组没有本人档案时不显示该入口（避免死链）。

## 4. 验收（自动化）

后端测试覆盖：同一账号加入两个开发组 / 两个团队后，
- `scope=team|all` 的 `members`/`workloads` 去重且合并正确，`scope=group` 数值不变；
- bootstrap 的 `linkedMemberId` 随激活开发组切换，`linkedMemberIds` 完整；
- 聚合视角里本人可编辑自己在任一开发组的档案 / 任务（不再被单 id 拦住）；
- 个人主页返回全部档案行。

端到端测试（`web/e2e/round7-membership.mjs`）：真实浏览器里把同一账号加入两个组，
验证概览团队/所有团队视角无重复成员卡、成员卡展示多个开发组、个人主页展示两条档案、
切换开发组后右上角「我的成员卡片」可打开且显示当前组档案。
