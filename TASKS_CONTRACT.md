# Task Ledger & Workload Contract (v2)

This doc defines the shared shapes for the "任务总览" feature and the non-hour workload model.

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

`GET /tasks`:

```json
{
  "tasks": [{
    "id": "task-...",
    "groupId": "grp-frontend",
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

- `POST /tasks` body: `{ memberId, title, description?, progressStatus?, healthStatus?, priority?, difficulty?, expectedDate? }`
- `PATCH /tasks/{task_id}` partial same
- `DELETE /tasks/{task_id}`

Permissions unchanged: admins manage in-scope members; linked members self-only; guests read-only.

`GET /overview` includes `workloads` and `workloadSummary` with the same v2 workload shape.

## Data migration

Existing `member_tasks` table has `effort_hours`. Add additive `priority TEXT NOT NULL DEFAULT 'normal'` and `difficulty TEXT NOT NULL DEFAULT 'medium'` columns; keep `effort_hours` in DB for compatibility but do not return it. Backfill existing rows deterministically from effort hours / health / urgency before serving. New seed tasks must set realistic priority/difficulty.

## Shared frontend types/API

`MemberTask`: `priority`, `difficulty`, `loadPoints`; no `effortHours`.
`Workload`: `currentPoints`, `currentLoadPercent`, `averagePoints`, `averageLoadPercent`, `capacityPoints`.
`WorkloadSummary` accordingly.
`lib/taskMeta.ts`: `PRIORITY_META`, `DIFFICULTY_META`, `TASK_LOAD_WEIGHTS`, `formatPoints`, `loadLevel`.

`api.tasks` returns `TaskOverviewData`.
