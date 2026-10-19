# TeamStudio API & File Contract

This document is the source of truth for backend/frontend collaboration. All API routes are
JSON unless noted. Auth is cookie based. Every endpoint returns `{ "ok": true, "data": ... }`
or an error `{ "ok": false, "error": { "code": "...", "message": "...", "details": ... } }`.
All write endpoints require an admin unless explicitly marked "member-self".

## Identity & permissions

`GET /api/auth/me` returns:

```json
{
  "id": "admin@local",
  "name": "Admin",
  "email": "",
  "authenticated": true,
  "source": "local | sso | guest",
  "isDeviceAdmin": true,
  "admin": { "role": "super", "teamIds": [], "groupIds": [] },
  "linkedMemberId": null,
  "permissions": {
    "canEditSettings": true,
    "canEditAny": true,
    "canEditGroup": true,
    "canEditSelf": true
  },
  "ssoConfigured": false
}
```

Admin roles: `super` (deployment device, name always `Admin`, never stored in config),
`team_admin` (all groups of `teamIds`), `group_admin` (specific `groupIds`). A member
without an admin role may only edit their linked member profile/works and their own todos.

Local requests (loopback or one of the deployment machine's own IPv4 addresses) are always
the `Admin` super user. SSO identities are matched against `auth.adminWhitelist.ids` by
id/email. IP entries accept exact IPs and CIDR ranges.

## Auth

- `GET /api/auth/me` – current identity (guest is unauthenticated but readable)
- `GET /api/auth/login?next=/` – starts OIDC login; redirects back with `?sso=unconfigured`
  when SSO is not configured (automatic guest fallback)
- `GET /api/auth/callback?code=&state=` – OIDC callback, sets HttpOnly session cookie
- `POST /api/auth/logout` – clears session
- `GET /api/auth/config` – safe public SSO info (`enabled`, `providerName`, `configured`)

## Bootstrap

`GET /api/bootstrap?teamId=&groupId=` returns config for navigation plus workspace tree and
current context. The active team/group is resolved server-side from the query or from the
first team/group.

```json
{
  "me": { },
  "config": { "site": {...}, "modules": {...}, "features": {...}, "auth": { "sso": {...} } },
  "teams": [{ "id": "team-aurora", "name": "...", "groups": [{ "id": "grp-frontend", "name": "..." }] }],
  "active": { "team": { }, "group": { } },
  "stats": { "members": 8, "todos": 14, "pinned": 3 }
}
```

- `GET /api/teams` – teams + groups visible to current user (all demo data is visible)
- `GET /api/teams/{teamId}/groups/{groupId}` – group detail with members

## Group-scoped feature routes

Base: `/api/teams/{teamId}/groups/{groupId}`. All GET routes are available in guest mode.

### Browsing scope (multi-group reads)

Every read route below accepts `?scope=group|team|all` (default `group`, fully backward
compatible). Responses add a top-level `scope` object and per-item group metadata:

```json
{
  "scope": {
    "kind": "group | team | all",
    "label": "前端体验组 | 星港产品团队 · 全团队 | 全部团队",
    "teamIds": ["team-aurora"],
    "groupIds": ["grp-frontend"],
    "groups": [{ "id": "grp-frontend", "teamId": "team-aurora", "teamName": "星港产品团队",
                 "teamShortName": "星港", "name": "前端体验组", "color": "#7c3aed", "icon": "layers" }],
    "team": { "id": "team-aurora", "name": "星港产品团队", "shortName": "星港", "color": "#5865f2" },
    "group": { "id": "grp-frontend", "teamId": "team-aurora", "name": "前端体验组", "color": "#7c3aed" }
  }
}
```

Members/works/todos/links/matrix/announcements gain `groupId` + `groupName`; tasks and todos
also gain `teamId` + `teamName`. Writes stay group-scoped: the frontend routes an edit/delete
to the group that owns the item (`groupId` on the payload), and creates into the currently
selected group. Invalid scope → `422 invalid_scope`.

### Overview / members / works

- `GET /overview?scope=` – `{ group, scope, members, works, recentActivity, stats, workloads, workloadSummary }`
  - member shape: `{ id, name, email, title, role, avatarColor, bio, tags[], status,
    duties[], currentWorks[], historyWorks[], stats: { current, done, todos },
    groupId, groupName, teamId, teamName }`
  - work shape: `{ id, memberId, title, description, status: "current"|"done"|"planned",
    period, category, progress, updatedAt, groupId, groupName, teamId, teamName }`
- `PATCH /members/{memberId}` – member-self or admin. Editable: name, title, role, bio,
  tags, skills, status, email.
- `POST /members` (admin) – create member (same fields + id optional)
- `DELETE /members/{memberId}` (admin)
- `GET /members/{memberId}/works`
- `POST /members/{memberId}/works` – member-self or admin
- `PATCH /members/{memberId}/works/{workId}` – member-self or admin
- `DELETE /members/{memberId}/works/{workId}` – member-self or admin

### Calendar todos

- `GET /todos?month=YYYY-MM&scope=` – todos in month (month filter applies across the scope)
- `POST /todos` – any signed-in user may create a todo for self; admins for anyone.
  Body: `{ title, description, dueDate: "YYYY-MM-DD", dueTime: "HH:MM",
  assigneeMemberId, priority: "low"|"normal"|"high"|"urgent", reminderOffsetsDays?: [3,1,0],
  emailEnabled: true }`
- `PATCH /todos/{todoId}` – creator, assignee member-self, or admin
- `DELETE /todos/{todoId}` – creator or admin
- Reminder metadata on a todo: `reminderOffsetsDays`, `emailEnabled`, `remindersSent`.

### Task ledger, workload & shared tags

Full task/workload payloads and the load-point model live in `TASKS_CONTRACT.md`.

- `GET /tasks?scope=` – tasks + workloads + summary + meta (+ scope)
- `POST /tasks`, `PATCH /tasks/{taskId}`, `DELETE /tasks/{taskId}` – task CRUD; payload accepts
  `tagIds: string[]` (max 8, must belong to the task's group)
- `GET /task-tags?scope=` – shared per-group tag library + `usage` counts + scope
- `POST /task-tags` (any signed-in user) – `{ name, color? }`; duplicate name → `409`
- `PATCH /task-tags/{tagId}` (any signed-in user) – `{ name?, color? }`
- `DELETE /task-tags/{tagId}` (any signed-in user) – removes the tag from every task
- Tag shape: `{ id, groupId, groupName, name, color, usage, createdBy, createdAt, updatedAt }`
- Task payload gains `tagIds` + hydrated `tags[]`; guests can read but not write tags.

### Data insights

- `GET /insights?scope=&range=1w|2w|1m|2m|3m|all` – analytics for the read scope:
  `{ scope, range: { key, label, days, start }, summary, members[], groups[], teams[],
  trend: { granularity: "day"|"week", buckets: [{ label, start, created, completed, todos }] } }`
  - `summary`: `teams, groups, members, tasks, openTasks, completedTasks, overdueTasks,
    blockedTasks, completionRate, todos, completedTodos, todoCompletionRate, loadPoints,
    capacityPoints, averageLoadPercent`
  - Rows include the fields declared in `web/src/types.ts` (`InsightsMemberRow`,
    `InsightsGroupRow`, `InsightsTeamRow`); rates are 0–100 integers.
  - 1w/2w use daily buckets; 1m/2m/3m use weekly buckets; `all` uses the last 26 weekly
    buckets with `days=null, start=null`.
  - Invalid range → `422 invalid_range`; guests may read.

### Red / black board (monthly)

- `GET /redblack?month=YYYY-MM` – `{ month, board, availableMonths }`
  `board`: `{ id, month, theme, updatedAt, red: Entry[], black: Entry[] }`
  Entry: `{ id, side, memberId, memberName, title, reason, score, createdAt }`
- `PUT /redblack` (admin) – upsert month board:
  `{ month, theme, red: [{ memberId?, memberName, title, reason, score }], black: [...] }`
- `POST /redblack/rollover` (admin) – create next month from current month skeleton.

### Links board

- `GET /links?scope=` – `{ links: [{ id, groupId, groupName, title, url, description, category, color, sortOrder }], scope }`
- `POST /links` (admin), `PATCH /links/{id}` (admin), `DELETE /links/{id}` (admin)

### Responsibility matrix

- `GET /matrix?scope=` – `{ areas: [{ id, groupId, groupName, area, description, ownerMemberId, ownerName,
  backupMemberId, backupName, channel, contact, sortOrder }], scope }`
- `POST /matrix` (admin), `PATCH /matrix/{id}` (admin), `DELETE /matrix/{id}` (admin)

### Announcements (max 3 pinned)

- `GET /announcements?scope=` – `{ announcements: [{ id, groupId, groupName, title, content, pinned, level:
  "info"|"important"|"celebration", authorName, createdAt, updatedAt }], maxPinned, pinnedCount, scope }`
- `POST /announcements` (admin) – pinned allowed only if fewer than configured max (3)
- `PATCH /announcements/{id}` (admin) – same pinned limit
- `DELETE /announcements/{id}` (admin)

## Settings (super admin only unless noted)

- `GET /api/settings` – full settings JSON + `meta` (path, updatedAt, schemaVersion)
- `PUT /api/settings` – replace full config; 422 with `details: [{ path, message }]` on error
- `POST /api/settings/validate` – validate without saving, returns same shape as PUT
- `GET /api/settings/schema` – JSON Schema for the GUI/JSON editor
- `GET /api/settings/defaults` – default config (no secrets)
- `GET /api/settings/workspace` – admin: team/group/member summary for GUI selectors

## Email reminders & bundled mail server (admin)

- `GET /api/email/status` – `{ enabled, remindersEnabled, deliveryMode, builtin:
  { enabled, running, host, port, hostname, stored, limit, retentionDays, lastError },
  smtpConfigured, fromEmail, lastScanAt, pendingReminders, sentToday, failedToday,
  scheduler: { running, lastScanAt, nextScanAt, lastError }, templatePreview }`
- `GET /api/email/logs?limit=50` – recent outbox records
- `GET /api/email/mailbox?limit=50&box=all|outbound|inbound` – `{ messages, total, builtin }`
  (`bodyText` truncated in list mode)
- `GET /api/email/mailbox/{id}` – `{ message }` with full body; marks `read_at`
- `DELETE /api/email/mailbox/{id}` (admin) – `{ deleted: true }`
- `POST /api/email/builtin/restart` (admin) – restart the bundled SMTP server
- `POST /api/email/test` – `{ to? }` send a test mail (works offline in `builtin` mode)
- `POST /api/email/scan` – run reminder scan now; returns `{ sent, skipped, failed, entries }`

`email.deliveryMode` is `builtin` (default) or `smtp`. In `builtin` mode the app delivers to
the bundled SMTP server (`email.builtin`, default `127.0.0.1:2525`) which stores messages in
`mailbox_messages`; no external SMTP account is needed. `smtp` mode keeps the previous external
SMTP behaviour. The scheduler scans every configured interval, sends at
`dueDate - offsetDays` at the configured local send time, and deduplicates by
`(todoId, offsetDays, recipient)`. Templates are configurable and support these variables:
`{{memberName}}`, `{{todoTitle}}`, `{{todoDescription}}`, `{{dueDate}}`, `{{dueTime}}`,
`{{groupName}}`, `{{teamName}}`, `{{priority}}`, `{{announcements}}`, `{{extraContent}}`,
`{{siteName}}`.

## Storage

- `data/settings.json` – all application settings, editable through API and UI
- `data/teamstudio.db` – SQLite business data, including `task_tags`, `member_tasks.tags`
  and `mailbox_messages` (bundled mail)
- `data/.session_secret` – generated signing key (never exposed)
- `data/email_outbox.jsonl` – SMTP audit log mirror

## Frontend routes (hash based)

`#/overview`, `#/tasks`, `#/insights`, `#/calendar`, `#/redblack`, `#/links`, `#/matrix`,
`#/announcements`, `#/settings`, `#/profile`. Module flags hide nav entries, direct hash
remains accessible to admins so a hidden settings module can be restored. Settings tabs:
`#/settings?tab=appearance|modules|access|sso|email|json`.

## File ownership (for parallel work)

- Lead: `backend/app/config.py`, `db.py`, `auth.py`, `main.py`, `scope.py`, `seed.py`,
  `routers/settings.py`, `routers/auth.py`, `routers/bootstrap.py`, `services/scheduler.py`,
  `backend/tests/conftest.py`, root docs/scripts, `web/src/App.tsx`, `store.tsx`, `api.ts`,
  `types.ts`, `lib/scope.ts`, `components/AppShell.tsx`, `components/ShellScope.css`.
- Backend data owner: `backend/app/routers/tasks.py`, `calendar.py`, `workspace.py`,
  `boards.py`, `insights.py`, `services/tasks_service.py`, `services/insights_service.py`,
  `backend/app/permissions.py`, new tests.
- Backend mail owner: `backend/app/services/mail_server.py`, `email_service.py`,
  `routers/email.py`, `backend/tests/test_mail_server.py`.
- Frontend theme owner: `web/src/styles.css`, `pages/OverviewPage.tsx/.css`,
  `components/MemberDrawer.tsx`.
- Frontend settings owner: `pages/SettingsPage.tsx/.css`, `components/CodeEditor.tsx/.css`,
  `web/vite.config.ts`.
- Frontend interaction owner: `components/Select.tsx/.css`, `TodoDialog.tsx`,
  `pages/CalendarPage.tsx/.css`, `MatrixPage.tsx`, `LinksPage.tsx`,
  `AnnouncementsPage.tsx`, `RedBlackPage.tsx`.
- Frontend data owner: `pages/TaskOverviewPage.tsx/.css`, `pages/InsightsPage.tsx/.css`,
  `components/TaskDialog.tsx`, `components/TagPicker.tsx/.css`.
- QA owner: `backend/tests/*` read-only except their own new tests, `web/e2e/*`.
