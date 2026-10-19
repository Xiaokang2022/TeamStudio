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

### Overview / members / works

- `GET /overview` – `{ group, members, works, recentActivity, stats }`
  - member shape: `{ id, name, email, title, role, avatarColor, bio, tags[], status,
    duties[], currentWorks[], historyWorks[], stats: { current, done, todos } }`
  - work shape: `{ id, memberId, title, description, status: "current"|"done"|"planned",
    period, category, progress, updatedAt }`
- `PATCH /members/{memberId}` – member-self or admin. Editable: name, title, role, bio,
  tags, skills, status, email.
- `POST /members` (admin) – create member (same fields + id optional)
- `DELETE /members/{memberId}` (admin)
- `GET /members/{memberId}/works`
- `POST /members/{memberId}/works` – member-self or admin
- `PATCH /members/{memberId}/works/{workId}` – member-self or admin
- `DELETE /members/{memberId}/works/{workId}` – member-self or admin

### Calendar todos

- `GET /todos?month=YYYY-MM` – todos in month
- `POST /todos` – any signed-in user may create a todo for self; admins for anyone.
  Body: `{ title, description, dueDate: "YYYY-MM-DD", dueTime: "HH:MM",
  assigneeMemberId, priority: "low"|"normal"|"high"|"urgent", reminderOffsetsDays?: [3,1,0],
  emailEnabled: true }`
- `PATCH /todos/{todoId}` – creator, assignee member-self, or admin
- `DELETE /todos/{todoId}` – creator or admin
- Reminder metadata on a todo: `reminderOffsetsDays`, `emailEnabled`, `remindersSent`.

### Red / black board (monthly)

- `GET /redblack?month=YYYY-MM` – `{ month, board, availableMonths }`
  `board`: `{ id, month, theme, updatedAt, red: Entry[], black: Entry[] }`
  Entry: `{ id, side, memberId, memberName, title, reason, score, createdAt }`
- `PUT /redblack` (admin) – upsert month board:
  `{ month, theme, red: [{ memberId?, memberName, title, reason, score }], black: [...] }`
- `POST /redblack/rollover` (admin) – create next month from current month skeleton.

### Links board

- `GET /links` – `{ links: [{ id, title, url, description, category, color, sortOrder }] }`
- `POST /links` (admin), `PATCH /links/{id}` (admin), `DELETE /links/{id}` (admin)

### Responsibility matrix

- `GET /matrix` – `{ areas: [{ id, area, description, ownerMemberId, ownerName,
  backupMemberId, backupName, channel, contact, sortOrder }] }`
- `POST /matrix` (admin), `PATCH /matrix/{id}` (admin), `DELETE /matrix/{id}` (admin)

### Announcements (max 3 pinned)

- `GET /announcements` – `{ announcements: [{ id, title, content, pinned, level:
  "info"|"important"|"celebration", authorName, createdAt, updatedAt }] }`
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

## Email reminders (admin)

- `GET /api/email/status` – `{ enabled, smtpConfigured, schedulerRunning, lastScanAt,
  nextScanAt, pendingReminders }`
- `GET /api/email/logs?limit=50` – recent outbox records
- `POST /api/email/test` – `{ to? }` send configurable test mail
- `POST /api/email/scan` – run reminder scan now; returns `{ sent, skipped, failed, entries }`

Emails are associated with calendar todos. The scheduler scans every configured interval,
sends at `dueDate - offsetDays` at the configured local send time, and deduplicates by
`(todoId, offsetDays, recipient)`. Templates are configurable and support these variables:
`{{memberName}}`, `{{todoTitle}}`, `{{todoDescription}}`, `{{dueDate}}`, `{{dueTime}}`,
`{{groupName}}`, `{{teamName}}`, `{{priority}}`, `{{announcements}}`, `{{extraContent}}`,
`{{siteName}}`.

## Storage

- `data/settings.json` – all application settings, editable through API and UI
- `data/teamstudio.db` – SQLite business data
- `data/.session_secret` – generated signing key (never exposed)
- `data/email_outbox.jsonl` – SMTP audit log mirror

## Frontend routes (hash based)

`#/overview`, `#/calendar`, `#/redblack`, `#/links`, `#/matrix`, `#/announcements`,
`#/settings`, `#/profile`. Module flags hide nav entries, direct hash remains accessible to
admins so a hidden settings module can be restored.

## File ownership (for parallel work)

- Lead: `backend/app/config.py`, `db.py`, `auth.py`, `main.py`, `seed.py`,
  `routers/settings.py`, `routers/email.py`, `routers/auth.py`, `services/email_service.py`,
  `services/scheduler.py`, `backend/tests/test_core.py`, root docs/scripts.
- Backend feature owner: `backend/app/routers/workspace.py`, `calendar.py`, `boards.py`,
  `backend/app/permissions.py`, `backend/tests/test_group_modules.py`.
- Frontend shell owner: `web/src/App.tsx`, `main.tsx`, `store.tsx`, `api.ts`, `types.ts`,
  `components/*`, `pages/SettingsPage.tsx`, `styles.css`, package config.
- Frontend feature pages owner: `web/src/pages/OverviewPage.tsx`, `CalendarPage.tsx`,
  `RedBlackPage.tsx`, `LinksPage.tsx`, `MatrixPage.tsx`, `AnnouncementsPage.tsx`,
  `components/MemberDrawer.tsx`, `components/TodoDialog.tsx`, page-scoped CSS.
- QA owner: `backend/tests/*` read-only except their own new tests, `scripts/qa_*`.
