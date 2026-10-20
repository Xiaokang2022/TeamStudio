# Task Ledger & Workload Contract (v3)

This doc defines the shared shapes for the "任务总览" feature, the non-hour workload model,
the shared per-group tag library, and the multi-scope / time-range / sorting behaviour.
Data insights shapes are documented in `CONTRACT.md` (`GET /insights`) and typed in
`web/src/types.ts` (`InsightsData`).

## Workload model (no hours)

Task load score (1-6, integer) = base task count 1 + difficulty bonus + priority bonus:

| Dimension | Options | Bonus |
| --- | --- | --- |
| Base | every task | +1 |
| Difficulty | easy 简单 / medium 中等 / hard 困难 | +0 / +1 / +2 |
| Priority | low 低 / normal 普通 / high 高 / urgent 紧急 | +0 / +1 / +2 / +3 |

Examples: a normal/easy task = 2 points; a high/medium task = 4 points; an urgent/hard task = 6 points.

- `capacityPoints = 15` per member per week (roughly five normal/medium tasks).
- Current load points = sum of load scores for tasks whose progress status is `pending` or `in_progress`.
- Current load percent = `round(currentPoints / 15 * 100)`.
- Average points = average of weighted active task points across each of the last 4 full 7-day windows. A task is active in a week if `createdAt <= windowEnd` and (`completedAt is null` or `completedAt >= windowStart`).
- Average load percent = `round(averagePoints / 15 * 100)`.
- Level thresholds: `< 40%` low, `< 85%` balanced, `< 110%` high, else overload.
- The UI must not show hours. Display points, task counts, priority and difficulty.

## Backend API

Base: `/api/teams/{team_id}/groups/{group_id}`

`GET /tasks?scope=group|team|all` (default `group`; see `CONTRACT.md` for the `scope` object).
All identities (including guests) may use every browsing view; `all` is not permission-gated.

```json
{
  "scope": { "kind": "group", "label": "前端体验组", "groupIds": ["grp-frontend"], "groups": [] },
  "tasks": [{
    "id": "task-...",
    "groupId": "grp-frontend",
    "groupName": "前端体验组",
    "teamId": "team-aurora",
    "teamName": "星港产品团队",
    "memberId": "m-lin",
    "memberName": "林知夏",
    "memberTitle": "前端负责人",
    "memberAvatarColor": "#7c3aed",
    "title": "任务标题",
    "description": "任务说明",
    "progressStatus": "pending | in_progress | completed",
    "healthStatus": "normal | delayed | blocked",
    "priority": "low | normal | high | urgent",
    "difficulty": "easy | medium | hard",
    "loadPoints": 4,
    "expectedDate": "2026-11-02",
    "tagIds": ["tag-...", "tag-..."],
    "tags": [{ "id": "tag-...", "groupId": "grp-frontend", "groupName": "前端体验组",
               "name": "前端", "color": "#0a59f7" }],
    "createdBy": "Admin",
    "createdAt": "ISO",
    "updatedAt": "ISO",
    "completedAt": null,
    "overdue": false
  }],
  "workloads": [{
    "memberId": "m-lin",
    "memberName": "林知夏",
    "memberTitle": "前端负责人",
    "avatarColor": "#7c3aed",
    "groupId": "grp-frontend",
    "groupName": "前端体验组",
    "teamId": "team-aurora",
    "teamName": "星港产品团队",
    "currentPoints": 8,
    "currentLoadPercent": 53,
    "averagePoints": 6.5,
    "averageLoadPercent": 43,
    "capacityPoints": 15,
    "windowWeeks": 4,
    "openTasks": 2,
    "completedTasks": 1,
    "blockedTasks": 0,
    "overdueTasks": 0,
    "level": "low | balanced | high | overload"
  }],
  "summary": {
    "members": 5,
    "tasks": 12,
    "openTasks": 8,
    "completedTasks": 4,
    "blockedTasks": 1,
    "overdueTasks": 1,
    "currentPoints": 36,
    "averagePoints": 28.5,
    "averageLoadPercent": 38,
    "capacityPoints": 15,
    "windowWeeks": 4
  },
  "meta": {
    "capacityPoints": 15,
    "windowWeeks": 4,
    "windowLabel": "近 4 周",
    "scoring": "任务基础 1 分 + 难度加成 + 优先级加成；每人每周容量 15 分"
  }
}
```

Writes:

- `POST /tasks` body: `{ memberId, title, description?, progressStatus?, healthStatus?, priority?, difficulty?, expectedDate?, tagIds? }`
- `PATCH /tasks/{task_id}` partial same
- `DELETE /tasks/{task_id}`

Permissions unchanged: admins manage in-scope members; linked members self-only; guests read-only.

`GET /overview` includes `workloads` and `workloadSummary` with the same v2 workload shape,
aggregated across the active read scope.

## Shared task tags (v3)

The tag library is shared per development group (`task_tags`) and writable by any signed-in
user:

- `GET /task-tags?scope=` → `{ tags: [{ id, groupId, groupName, name, color, usage, createdBy,
  createdAt, updatedAt }], scope }`; a group with no tags lazily gets 5 defaults.
- `POST /task-tags` `{ name (1-20 chars), color? (#RRGGBB) }`; duplicate names in the same group → 409.
- `PATCH /task-tags/{tagId}` `{ name?, color? }`.
- `DELETE /task-tags/{tagId}` removes the id from every task's `tags` array.
- Task writes accept `tagIds` (max 8, deduplicated, must belong to the task's group → 422 otherwise).

## Browsing scope, time range and sorting (v3)

- All reads accept `?scope=group|team|all`; single-group responses stay field-compatible with v2.
- Every identity (including guests) may use every browsing view; the frontend shows the
  `所有团队` option to everyone.
- `GET /insights?scope=&range=1w|2w|1m|2m|3m|all` powers the analytics board; see `CONTRACT.md`.
- Task ledger UI time range: `1w / 2w / 1m / 2m / 3m` (default `1m`). A task is "active" in the
  window when `createdAt`, `updatedAt` or `completedAt` falls inside it, or it is still open.
  Aggregated KPI cards use the same window.
- Sortable columns: member, priority, difficulty, load points, expected date, created time,
  progress status, health status (asc/desc, `aria-sort`).

## Data migration

Existing `member_tasks` table has `effort_hours`. Additive migrations:

- `priority TEXT NOT NULL DEFAULT 'normal'` and `difficulty TEXT NOT NULL DEFAULT 'medium'`
  (backfilled deterministically from effort hours / health / urgency).
- `tags TEXT NOT NULL DEFAULT '[]'` (JSON array of `task_tags.id`), added automatically on start.

`effort_hours` is kept in DB for compatibility but never returned.

## Shared frontend types/API

`MemberTask`: `priority`, `difficulty`, `loadPoints`, `groupId/groupName/teamId/teamName`,
`tagIds`, hydrated `tags`; no `effortHours`.
`Workload`: `currentPoints`, `currentLoadPercent`, `averagePoints`, `averageLoadPercent`,
`capacityPoints`, plus group/team metadata.
`WorkloadSummary` accordingly.
`lib/taskMeta.ts`: `PRIORITY_META`, `DIFFICULTY_META`, `TASK_LOAD_WEIGHTS`, `formatPoints`, `loadLevel`.
`lib/scope.ts`: `SCOPE_OPTIONS`, `TASK_RANGES`, `INSIGHTS_RANGES`, `rangeStartISO`, `isWithinRange`.

`api.tasks(teamId, groupId, scope)` returns `TaskOverviewData`; `api.taskTags` / `api.insights`
cover the v3 additions.
