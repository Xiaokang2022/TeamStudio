# TeamStudio API & File Contract

This document is the source of truth for backend/frontend collaboration. All API routes are
JSON unless noted. Auth is cookie based. Every endpoint returns `{ "ok": true, "data": ... }`
or an error `{ "ok": false, "error": { "code": "...", "message": "...", "details": ... } }`.
All write endpoints require an admin unless explicitly marked "member-self"; signed-in e-mail
accounts may also edit their own profile, linked member data and their own todos.

Round 5 replaced the bundled-mail / reminder stack with password-less e-mail accounts: the
primary sign-in path is a six-digit e-mail code, settings are layered (site vs domain), and the
red/black board follows the active browsing scope.

## Identity & permissions

`GET /api/auth/me` returns the current identity (`source` is one of `local`, `sso`, `email`,
`ip`, `guest`; the response also slides the session cookie):

```json
{
  "id": "lin.zhixia",
  "name": "林知夏",
  "email": "lin.zhixia@corp.example",
  "avatar": "/uploads/avatars/9f1c….png",
  "avatarColor": "#7c3aed",
  "bio": "把体验做细，把协作做顺。",
  "skills": ["React", "设计系统"],
  "authenticated": true,
  "source": "email",
  "isDeviceAdmin": false,
  "isSuperAdmin": false,
  "userRole": "member",
  "emailVerified": true,
  "admin": { "role": null, "teamIds": [], "groupIds": [] },
  "linkedMemberId": "m-lin",
  "linkedMemberName": "林知夏",
  "ssoConfigured": false,
  "deployDevice": false,
  "deviceAdminActive": false,
  "permissions": {
    "canEditSettings": false,
    "canEditAny": false,
    "canEditSelf": true,
    "canManageUsers": false,
    "canViewAllScope": true,
    "canManageWorkspace": false
  }
}
```

Roles (`users` table, `userRole`): `member | group_admin | team_admin | super`.

- `super` = super administrator. It has every permission the deployment device Admin has,
  including site settings and account management. The cross-team `all` browsing scope is not a
  super-only permission: every identity (guests included) may use it.
  `isSuperAdmin` is `true` for the device Admin and for stored `super` accounts.
- `team_admin` = full edit rights over every group of its `teamIds`; may create/delete groups
  inside those teams, but cannot create/delete a team or read site settings.
- `group_admin` = full edit rights over its `groupIds` only.
- `member` = linked member self-service: own profile, own works, own tasks and own todos;
  read-only elsewhere.
- A member whose e-mail matches a group-scoped `members` row is linked (`linkedMemberId`).
- Only the deployment device's built-in Admin may perform the destructive **system reset**
  (`/api/system/reset`, see [System reset](#system-reset-deployment-device-admin-only)). A stored
  `super` account — even while browsing from the deployment machine — can neither read nor execute
  it and gets `403 device_admin_required`; the settings UI hides the tab for every other identity.

Permission flags:

| Flag | Meaning |
| --- | --- |
| `canEditSettings` | Site-level settings (`/api/settings*`), super admins only |
| `canManageUsers` | Account administration (`/api/users*`), super admins only |
| `canViewAllScope` | Always `true`: every identity (including guests) may use `?scope=all` |
| `canManageWorkspace` | May open the workspace manager (super admin or a team admin) |
| `canEditAny` / `canEditSelf` | In-scope admin writes / member self-service |

The deployment device itself (loopback or one of the machine's own IPv4 addresses) uses the
built-in `Admin` (super, never stored) **until that browser explicitly logs out**. After
`POST /api/auth/logout` on the device, a one-year, HttpOnly `teamstudio_device_logout` marker
suppresses automatic device-admin privileges: the device can then sign in with any e-mail
account (or stay a guest) and that session has exactly the same permissions as on any other
machine — no device-admin privileges are attached. `POST /api/auth/device/login` (accepted only
from the deployment device) clears the marker and any account session, restoring the built-in
Admin. `deployDevice` reports that the request comes from the deployment machine, while
`deviceAdminActive` reports whether the built-in Admin identity is currently in use. A stored
`super` account behaves the same as device Admin on any machine, except that the device Admin
row is not manageable or deletable. The optional ID/IP admin whitelist
(`auth.adminWhitelist`) still grants `team_admin` / `group_admin` scopes to SSO / e-mail or IP
identities; it no longer contains `super` entries — use the accounts API for that. IP grants are
not applied to the deployment device once it has logged out of device-admin mode.

Sessions are sliding: `/api/bootstrap` and `/api/auth/me` re-issue the signed HttpOnly cookie on
every visit, so `auth.session.maxAgeDays` (default 7) counts from the most recent request. SSO
is an optional alternative sign-in path; guests are never redirected automatically.

## Auth

Password-less e-mail code login / registration:

- `POST /api/auth/email/request` `{ email }` → sends a one-time code and returns
  `{ sent, email, purpose: "login"|"register", registered, expiresInSeconds,
  resendAfterSeconds, codeLength }`.
  - `429 code_rate_limited` with `details.retryAfterSeconds` while inside the resend window.
  - `403 email_login_disabled` / `503 email_not_configured` when the flow or SMTP relay is off.
  - `403 account_not_activated` for a pre-created account that has not used its activation
    link yet (no e-mail code is sent for those accounts).
  - `502 email_send_failed` when the SMTP relay rejects the message.
- `POST /api/auth/email/verify` `{ email, code }` →
  `{ loggedIn, isNewUser, user, sessionDays }` and sets the signed cookie.
  - Any valid e-mail registers a `member` account on first use; pre-created (unverified)
    accounts are activated on their first successful code login.
  - Errors: `code_format_invalid`, `code_invalid`, `code_expired`, `code_mismatch`
    (`details.remainingAttempts`), `code_attempts_exceeded`, `user_id_conflict`.
- `GET /api/auth/config` – public auth info: `guestMode`, `allowGuestRead`, `emailLogin`
  (`enabled`, `codeLength`, `codeExpiryMinutes`, `resendSeconds`,
  `precreatedActivationMinutes`), `sessionDays`,
  `sso { enabled, configured, providerName }`, `emailService { enabled, configured }`,
  and the request-scoped `deployDevice` / `deviceAdminActive` flags.

Verification codes live in `email_codes`: HMAC-hashed six-digit codes (length configurable),
10-minute expiry, 60-second resend window, at most 5 attempts; the plain code is never stored or
logged. Sessions are HMAC-SHA256 signed HttpOnly `SameSite=Lax` cookies.

### Pre-created account activation links

When a super administrator pre-creates an account (`POST /api/users`, `emailVerified` false), the
response includes a one-time activation URL:

```json
{
  "user": { "...": "..." },
  "activation": {
    "url": "http://127.0.0.1:8000/api/auth/activate?token=…",
    "expiresAt": "2026-10-20T20:10:00+08:00",
    "expiresInMinutes": 10
  }
}
```

- Opening `GET /api/auth/activate?token=…` validates the token, marks the account verified, sets
  the signed session cookie and redirects to `/#/overview` — no e-mail code and no SMTP required.
- Tokens are one-time and expire after `auth.emailLogin.precreatedActivationMinutes` (default 10,
  configurable 1–120 minutes); only a SHA-256 hash is stored in `user_activation_tokens`.
- Invalid / expired / already-used links redirect to `/#/login?activation=invalid|expired|used`.
- `POST /api/users/{userId}/activation-link` (super) regenerates a link for a still-unverified
  account; already-activated accounts get `409 account_already_activated`.

Optional SSO and common endpoints:

- `GET /api/auth/login?next=/` – starts OIDC authorization-code + PKCE login; falls back to the
  guest view with `?sso=unconfigured` when SSO is not configured and guests are allowed.
- `GET /api/auth/callback?code=&state=` – OIDC callback, sets the session cookie.
- `POST /api/auth/logout` – clears the session, returns `{ loggedOut, endSessionUrl }`
  (`endSessionUrl` is the configured IdP logout URL or `null`). On the deployment device it also
  sets the device-admin sign-out marker described above.
- `POST /api/auth/device/login` – deployment device only; clears the sign-out marker (and any
  account session) and restores the built-in `Admin`. Off-device requests get
  `403 device_admin_unavailable`.

## Bootstrap

`GET /api/bootstrap?teamId=&groupId=` returns navigation config, the workspace tree and the
current context (it also refreshes the sliding session):

```json
{
  "me": { },
  "config": { "site": {...}, "modules": {...}, "announcements": {...}, "calendar": {...},
              "redblack": {...}, "features": {...},
              "email": { "enabled", "configured", "fromEmail", "fromName" },
              "auth": { "guestMode", "allowGuestRead", "emailLogin": {...}, "sessionDays",
                        "sso": { "enabled", "configured", "providerName" } } },
  "teams": [{ "id": "team-aurora", "name": "...", "groups": [{ "id": "grp-frontend", "name": "..." }] }],
  "active": { "team": { }, "group": { } },
  "stats": { "teams": 1, "groups": 3, "members": 8, "todos": 14, "pinned": 3,
             "currentWorks": 5, "serverDate": "2026-10-20" },
  "serverTime": "2026-10-20",
  "deviceAdminName": "Admin"
}
```

- `GET /api/teams` – teams + groups visible to the current user.
- `GET /api/teams/{teamId}/groups/{groupId}/overview` – group overview (members, works,
  activity, stats); there is no separate group-detail endpoint.

## Accounts, users & personal home page

`users` rows are e-mail accounts: `id` is the lower-cased e-mail local part and is immutable,
`email` is unique and lower-cased, `name` defaults to the local part, and `email_verified` is
`0` for accounts pre-created by a super admin (they activate through a one-time link, not an
e-mail code). Personal fields: `avatar`, `avatar_color`, `bio`, `skills` (JSON array).

Account administration (super administrators only):

- `GET /api/users` → `{ users, deviceAdminName, permissions: { canManageUsers } }`. The synthetic
  device Admin row (`isDeviceAdmin: true`, `canManage: false`, `roleLabel: "超级管理员"`) is
  included **only when the caller is the deployment device Admin itself**; stored super
  administrators (`role: "super"` accounts) never see that row.
- `POST /api/users` `{ email, name?, role?, teamIds?, groupIds?, emailVerified? }` – creates an
  account and, for unverified accounts, returns
  `{ user, activation: { url, expiresAt, expiresInMinutes } }` (copy the URL to the member).
- `POST /api/users/{userId}/activation-link` – regenerates a one-time activation link for a
  still-unverified account (`409 account_already_activated` otherwise).
- `PATCH /api/users/{userId}` `{ name?, role?, teamIds?, groupIds? }`
- `DELETE /api/users/{userId}` – cannot delete yourself or the device Admin; also clears the
  account's pending `email_codes` and activation tokens (FK cascade).
- Validation: `invalid_role`, `invalid_team_scope`, `invalid_group_scope`,
  `team_scope_required`, `group_scope_required`, `user_id_conflict`, `email_exists`,
  `device_admin_immutable`, `account_already_activated`.

Profile / personal home page:

- `GET /api/profile` (authenticated) → `ProfilePayload` for the signed-in account. Device,
  IP and SSO identities without a stored account still get a read-only profile.
- `GET /api/users/{userId}/profile` (read access: signed-in member, or guest read mode) → `ProfilePayload`.
- `PATCH /api/profile` (self) `{ name?, avatarColor?, bio?, skills? }`; `name` 1–60 chars,
  `bio` ≤2000 chars, up to 20 skills of ≤30 chars each. Rejected for the device Admin
  (`device_admin_profile`).
- `POST /api/profile/avatar` multipart `file` (PNG / JPEG / WebP / GIF, ≤2 MB) →
  `{ avatar, user }`; the old file is removed. The format is detected from the uploaded bytes
  (magic bytes: PNG signature / `\xff\xd8\xff` / `GIF87a`|`GIF89a` / `RIFF…WEBP`); the
  browser-supplied `Content-Type` is not trusted, so a genuine image is accepted even when the
  client reports an empty, generic (`application/octet-stream`) or non-standard (`image/x-png`)
  type. Unsupported content → `422 avatar_type_unsupported`.
- `DELETE /api/profile/avatar` → `{ user }`, restores the initials avatar.

`ProfilePayload`:

```json
{
  "user": { "id","email","name","avatar","avatarColor","bio","skills","role","roleLabel",
            "teamIds","groupIds","emailVerified","createdBy","createdAt","updatedAt",
            "isDeviceAdmin" },
  "adminScope": { "role": "super | team_admin | group_admin | member",
                  "roleLabel": "超级管理员 | 团队管理员 | 开发组管理员 | 成员",
                  "summary": "超级管理员 | 极光产品团队 团队管理员 | 前端体验组 开发组管理员 | \"\"",
                  "teams": [{ "id": "team-aurora", "name": "极光产品团队" }],
                  "groups": [{ "id": "grp-frontend", "name": "前端体验组",
                               "teamId": "team-aurora", "teamName": "极光产品团队" }],
                  "isDeviceAdmin": false },
  "members": [{ "id","name","email","title","role","avatarColor","avatar","bio","tags",
                "skills","status","groupId","groupName","teamId","teamName" }],
  "duties": [{ "id","area","description","role":"owner|backup","channel","contact",
               "groupId","groupName","teamId","teamName" }],
  "currentTasks": [MemberTask],
  "historyTasks": [MemberTask],
  "todos": [{ "id","title","description","dueDate","dueTime","status":"todo|done","priority",
              "groupId","groupName","teamId","teamName" }],
  "redblack": { "red": [EntryWithGroupAndMonth], "black": [...] },
  "stats": { "duties","currentTasks","completedTasks","openTodos","redEntries","blackEntries" },
  "canEdit": true,
  "isSelf": true
}
```

Profile personal fields are mirrored onto every linked `members` row by e-mail; personal edits
made on a member record are mirrored back to the account, so member cards, the personal home page
and account settings always agree. Avatar files are served from `/uploads/avatars/...`.

`adminScope` describes what the account administers and is public (visible to any signed-in user
or guest reading the profile):

- `super` (including the deployment device Admin): `summary="超级管理员"`, `teams=[]`,
  `groups=[]`; `isDeviceAdmin` reflects the synthetic device identity.
- `team_admin`: `teams` is resolved from the account / whitelist `teamIds`; `summary` is
  `"<team name> 团队管理员"` (multiple teams joined with `、`).
- `group_admin`: `groups` is resolved together with the owning team; `summary` is
  `"<group name> 开发组管理员"` (multiple groups joined with `、`).
- `member`: `summary=""`, both arrays empty. Stale team / group ids that no longer exist are
  silently dropped (no error).

### Member personal vs organizational information

`PATCH /api/teams/{team}/groups/{group}/members/{memberId}`:

- **Personal fields** – `name`, `email`, `bio`, `avatarColor`, `tags`, `skills`, `avatar` /
  `avatarUrl` – only a super administrator or the linked account owner
  (`user.linkedMemberId == memberId`, or the member e-mail matches the signed-in account).
  Otherwise `403 personal_info_forbidden`.
- **Organizational fields** – `title`, `role`, `status` – editable by in-scope team/group admins.
- The member payload carries `avatar`; accepted personal edits sync to the linked `users` row.
  Member creation (`POST /members`) no longer accepts custom personal fields: it links a
  registered account by `userId` and derives the initial personal fields from it (see
  [Overview / members / works](#overview--members--works)).

## Workspace administration (admins)

Base: `/api/workspace`. All routes return `403 not_admin` for identities outside their
permission domain. Destructive routes require the exact target name in the JSON body and answer
`422 confirm_mismatch` (details `{ "expected": "<name>" }`) when it does not match.

- `GET /api/workspace/manage` – management tree for the caller's domain: super admins see
  every team, `team_admin` only its `teamIds`. Team: `{ id, name, shortName, description, color,
  groupCount, memberCount, canDelete, canCreateGroup, groups[] }`; group: `{ id, teamId, name,
  description, color, icon, memberCount, canDelete }`. Top-level `permissions`:
  `{ canCreateTeam, canCreateGroup, canManageAnyTeam }`.
- `POST /api/workspace/teams` (super) – `{ name, shortName?, description?, color? }`
- `DELETE /api/workspace/teams/{teamId}` (super) – `{ confirmName }`; cascades groups, members,
  works, todos, tasks, boards, links, matrix, announcements and tags.
- `POST /api/workspace/teams/{teamId}/groups` (super or that team's `team_admin`) –
  `{ name, description?, color?, icon? }`
- `DELETE /api/workspace/teams/{teamId}/groups/{groupId}` (super or that team's `team_admin`) –
  `{ confirmName }`; cascades the group's business data.

The workspace manager UI (`工作区管理`) lives in the user menu for super administrators and team
admins (`web/src/components/WorkspaceManager.tsx`).

## Group-scoped feature routes

Base: `/api/teams/{teamId}/groups/{groupId}`. All GET routes are available in guest mode.

### Browsing scope (multi-group reads)

Every read route below accepts `?scope=group|team|all` (default `group`). Browsing scope is
**not permission-gated** in round 6: every identity, including guests, may request `all`. An
unknown value is `422 invalid_scope`. Responses add a top-level `scope` object and per-item group
metadata:

```json
{
  "scope": {
    "kind": "group | team | all",
    "label": "前端体验组 | 极光产品团队 | 所有团队",
    "teamIds": ["team-aurora"],
    "groupIds": ["grp-frontend"],
    "groups": [{ "id": "grp-frontend", "teamId": "team-aurora", "teamName": "极光产品团队",
                 "teamShortName": "极光", "name": "前端体验组", "color": "#7c3aed", "icon": "layers" }],
    "team": { "id": "team-aurora", "name": "极光产品团队", "shortName": "极光", "color": "#5865f2" },
    "group": { "id": "grp-frontend", "teamId": "team-aurora", "name": "前端体验组", "color": "#7c3aed" }
  }
}
```

Members/works/todos/links/matrix/announcements gain `groupId` + `groupName`; tasks and todos
also gain `teamId` + `teamName`. Writes stay group-scoped: the frontend routes an edit/delete
to the group that owns the item (`groupId` on the payload), and creates into the currently
selected group. The frontend shows all three browsing views to every identity.

### Overview / members / works

- `GET /overview?scope=` – `{ group, scope, members, works, recentActivity, stats, workloads, workloadSummary }`
  - member shape: `{ id, name, email, avatar, title, role, avatarColor, bio, tags[], skills[],
    status, duties[], currentWorks[], historyWorks[], stats: { current, done, todos },
    groupId, groupName, teamId, teamName }`
  - work shape: `{ id, memberId, title, description, status: "current"|"done"|"planned",
    period, category, progress, updatedAt, groupId, groupName, teamId, teamName }`
- `PATCH /members/{memberId}` – see [Member personal vs organizational information](#member-personal-vs-organizational-information).
- `GET /member-candidates?search=` (admin) – registered accounts (`users` rows, **including
  pre-created but unverified accounts**) that are not yet in this group's member profiles:
  `{ candidates: [{ id, name, email, avatar, avatarColor, role, roleLabel, emailVerified,
  skills }], total }`. `search` matches name / e-mail / account id case-insensitively. A member
  profile is considered a duplicate when `lower(members.email) = lower(users.email)` or
  `lower(members.external_id) = lower(users.id)`. The built-in device Admin is not a `users`
  row, so it can never appear; guests get `401`, out-of-scope admins `403`, unknown teams /
  groups `404 group_not_found`.
- `POST /members` (admin) – `{ userId, title?, role?, status?, sortOrder? }`. `userId` is
  required (account id; an e-mail is also accepted for manual callers) and everything identity
  related is derived from the `users` row — `members.external_id = users.id`, `name` (falling
  back to the account id), `email`, `avatar_url`, `avatar_color`, `bio`, `skills`; `tags` is
  reset to `[]` and any `name` / `email` / `id` / `avatar` in the body is ignored. Unknown
  accounts and `userId=device-admin` → `404 user_not_found`; already in this group →
  `409 member_exists`; missing / empty `userId` → `422 validation_error`. `title` / `role` /
  `status` / `sortOrder` remain settable organizational fields. Writes a `member.create` audit
  whose detail contains `userId` and returns `{ member: MemberDetail }`.
- `DELETE /members/{memberId}` (admin)
- `GET /members/{memberId}/works`
- `POST /members/{memberId}/works` – member-self or admin
- `PATCH /members/{memberId}/works/{workId}` – member-self or admin
- `DELETE /members/{memberId}/works/{workId}` – member-self or admin

### Calendar todos

- `GET /todos?month=YYYY-MM&scope=` – todos in month (month filter applies across the scope)
- `POST /todos` – any signed-in user may create a todo for self; admins for anyone.
  Body: `{ title, description, dueDate: "YYYY-MM-DD", dueTime: "HH:MM",
  assigneeMemberId, priority: "low"|"normal"|"high"|"urgent" }`
- `PATCH /todos/{todoId}` – creator, assignee member-self, or admin
- `DELETE /todos/{todoId}` – creator or admin
- Todo payloads no longer contain `reminderOffsetsDays`, `emailEnabled` or `remindersSent`;
  calendar reminders were removed together with the bundled mail server.

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

### Red / black board (monthly, scope-following)

- `GET /redblack?month=YYYY-MM&scope=` →

```json
{
  "month": "2026-10",
  "scope": { "kind": "group", "label": "前端体验组", "teamIds": [], "groupIds": [],
             "groups": [], "team": null, "group": null },
  "board": { "id": "board-…", "groupId": "grp-frontend", "groupName": "前端体验组",
             "teamId": "team-aurora", "teamName": "极光产品团队", "month": "2026-10",
             "theme": "", "updatedAt": "ISO", "red": [Entry], "black": [Entry],
             "exists": true },
  "boards": [ { "id", "groupId", "groupName", "teamId", "teamName", "month", "theme",
                "updatedAt", "red": [Entry], "black": [Entry], "exists": true } ],
  "availableMonths": ["2026-10", "2026-09"]
}
```

  - Group scope keeps the single-board semantics (`theme` + writable board); `board` is `null`
    when the month has no board.
  - Team / `all` scopes return a merged, read-only `board` (`id: null`, `groupId: null`,
    `theme: ""`, `exists` tells whether any scoped group has a board) plus `boards[]`, one per
    scoped group. Entry: `{ id, side, memberId, memberName, title, reason, score, groupId,
    groupName, teamId, teamName, createdAt }`. The frontend hides editing and month rollover in
    aggregate scopes and shows a read-only hint.
- `PUT /redblack` (admin, group-scoped) – upsert that group's month board:
  `{ month, theme, red: [{ memberId?, memberName, title, reason, score }], black: [...] }`;
  returns `{ month, board, availableMonths }`.
- `POST /redblack/rollover` (admin, group-scoped) – create the next month from the current
  month skeleton; body `{ fromMonth?, toMonth?, month? }`, returns
  `{ month, sourceMonth, created, board, availableMonths }`.

### Links board

- `GET /links?scope=` – `{ links: [{ id, groupId, groupName, title, url, description, category, color, sortOrder }], scope }`
- `POST /links` (admin), `PATCH /links/{id}` (admin), `DELETE /links/{id}` (admin)

### Responsibility matrix

- `GET /matrix?scope=` – `{ areas: [{ id, groupId, groupName, area, description, ownerMemberId,
  ownerName, backupMemberIds: string[], backups: [{ id, name, color }], backupMemberId,
  backupName, backupColor, channel, contact, sortOrder }], scope }`
  Each area has exactly one primary owner (single id or null). Backups are a list: a member
  may back up any number of areas and may also own other areas. `backupMemberId/backupName/
  backupColor` are the legacy projection of the first backup, kept for compatibility.
- `POST /matrix` (admin), `PATCH /matrix/{id}` (admin), `DELETE /matrix/{id}` (admin).
  Writes accept `backupMemberIds: string[]` (max 10, deduplicated, group-scoped; the owner
  cannot also be a backup) and still accept the legacy `backupMemberId`. `[]` clears backups;
  `description` is optional (≤500 chars). The area list shows a dedicated description column.

### Announcements (max 3 pinned)

- `GET /announcements?scope=` – `{ announcements: [{ id, groupId, groupName, title, content, pinned, level:
  "info"|"important"|"celebration", authorName, createdAt, updatedAt }], maxPinned, pinnedCount, scope }`
- `POST /announcements` (admin) – pinned allowed only if fewer than configured max (3)
- `PATCH /announcements/{id}` (admin) – same pinned limit
- `DELETE /announcements/{id}` (admin)

## Settings (two layers)

### Site level (super admins only)

- `GET /api/settings` – full settings JSON + `meta` (path, updatedAt, schemaVersion, deviceAdminName)
- `PUT /api/settings` – replace full config; 422 with `details: [{ path, message }]` on error
- `POST /api/settings/validate` – validate without saving, returns same shape as PUT
- `GET /api/settings/schema` – JSON Schema for the GUI/JSON editor
- `GET /api/settings/defaults` – default config (no secrets)
- `GET /api/settings/workspace` – team/group/member summary for GUI selectors (super only)

Config sections: `site` (name, tagline, theme), `modules` (overview, tasks, insights, calendar,
redblack, links, matrix, announcements, settings — no email module), `announcements`,
`calendar` (weekStartsOn, showWeekends, allowPastDue — no reminder defaults), `redblack`,
`email` (SMTP relay + verification templates, see below), `auth` (`emailLogin`, `sso`,
`adminWhitelist`, `session.maxAgeDays`, guest flags), `features`.

`site.theme.mode` accepts `auto | light | dark` and defaults to `auto`: the public config tells
the frontend to follow `prefers-color-scheme` until the visitor explicitly picks a theme
(stored only in that browser's `localStorage`). The light palette is a neutral low-glare paper
white (`--bg #f7f7f5`), not warm/cream.

Legacy round-4 keys (`email.deliveryMode`, `email.builtin`, `email.reminders`,
`calendar.defaultReminderOffsetsDays/defaultReminderTime/defaultEmailEnabled`,
`modules.email`) are stripped automatically when an older `data/settings.json` is loaded.

### Domain level (any admin)

- `GET /api/settings/domain` – only the caller's teams/groups:

```json
{
  "teams": [{ "id", "name", "shortName", "description", "color", "canEdit",
              "groups": [{ "id", "teamId", "name", "description", "color", "icon", "canEdit" }] }],
  "permissions": { "canEditSite", "canEditStructure", "canEditTeam", "canEditGroup",
                   "isSuperAdmin", "isDeviceAdmin" }
}
```

- `PATCH /api/settings/teams/{teamId}` `{ name?, shortName?, description?, color? }` – super or
  that team's `team_admin`.
- `PATCH /api/settings/teams/{teamId}/groups/{groupId}`
  `{ name?, description?, color?, icon? }` – super, the team's `team_admin`, or that group's
  `group_admin`.
- `canEdit` marks each entity the caller may change. Team/group admins cannot read site
  settings (403); the frontend only renders the domain tab for them.

## System reset (deployment device Admin only)

A destructive "restore defaults and erase everything" operation lives under `/api/system`. It is
reserved for the built-in Admin of the deployment device: a stored `super` account (even while
running on the deployment machine) can neither read nor execute it (`403 device_admin_required`),
and the settings page only renders the tab for `isDeviceAdmin` identities.

- `GET /api/system/reset` → device-admin only. Returns the current site name (the exact phrase
  required for confirmation), the default site name and the row counts of everything that would be
  deleted:

```json
{
  "deviceAdmin": true,
  "canReset": true,
  "siteName": "团队工作室",
  "siteShortName": "TeamStudio",
  "defaultSiteName": "团队工作室",
  "defaultSiteShortName": "TeamStudio",
  "stats": { "teams": 1, "groups": 4, "members": 12, "works": 30, "todos": 20, "tasks": 40,
             "boards": 4, "entries": 12, "links": 12, "matrix": 12, "announcements": 8,
             "tags": 10, "accounts": 12, "emailCodes": 0, "activationTokens": 0,
             "emailLogs": 0, "auditLogs": 25 },
  "lastResetAt": null,
  "lastResetBy": ""
}
```

- `POST /api/system/reset` `{ confirmName, acknowledge: true }` → device-admin only.
  - `confirmName.trim()` must equal the current `settings.site.name` (`422 confirm_mismatch`,
    `details.expected`) and `acknowledge` must be exactly `true` (`422 acknowledge_required`);
    otherwise nothing is touched.
  - On success it deletes every row of the business database (`teams`, `groups`, `members`,
    `works`, `todos`, `member_tasks`, red-black boards/entries, `links`, `matrix_areas`,
    `announcements`, `task_tags`, `users`, e-mail codes/logs, activation tokens, `audit_logs`,
    `app_meta`), removes every uploaded avatar file, restores `data/settings.json` to the defaults,
    rotates the session signing key (all issued account sessions become invalid), and writes one
    audit row (`system.factory_reset`) plus the `app_meta` markers
    `factoryResetAt` / `factoryResetBy`.
  - The database file is also scrubbed on disk: the wiping connection enables
    `PRAGMA secure_delete=ON`, and after the commit the file is compacted (truncating WAL
    checkpoint + `VACUUM`), so the deleted demo rows cannot be recovered from
    `teamstudio.db` or its `-wal` sidecar.
  - Startup never creates demo data: the FastAPI lifespan only initialises the schema, so a
    fresh or factory-reset database stays empty across restarts. Demo data is an explicit
    operator action — `python -m backend.app.seed` (wrapped by `scripts/seed-demo.ps1`) — which
    is idempotent and intentionally bypasses the `factoryResetAt` marker to rebuild the demo
    workspace. `seed_if_empty()` itself still refuses to backfill while
    `app_meta.factoryResetAt` exists when called without `force`. The built-in device Admin
    identity is not stored, so it survives the reset and can rebuild teams through the workspace
    manager.
  - Response: `{ reset: true, resetAt, sessionSecretRotated, uploadsRemoved, cleared: {…stats…},
    siteName, siteShortName }`.

UI: `#/settings?tab=reset` — a 「重置系统」 tab rendered only for the device Admin. Two
confirmations are required: a dialog asking whether to reset, then a dialog that only unlocks the
final destructive button once the complete current site name is typed.

## E-mail service (SMTP relay only)

Round 5 removed the bundled SMTP server, the local mailbox centre and the calendar reminder
scheduler. E-mail is used only to deliver account verification codes through one external SMTP
relay configured in `settings.email`:

```json
{
  "email": {
    "enabled": true,
    "smtp": { "host": "smtp.corp.example", "port": 587, "username": "teamstudio@corp.example",
              "password": "应用专用密码", "fromEmail": "teamstudio@corp.example",
              "fromName": "团队工作室", "useStartTls": true, "useSsl": false,
              "timeoutSeconds": 15 },
    "subjectTemplate": "[{{siteName}}] 邮箱验证码",
    "bodyTemplate": "你的验证码是 {{code}}，{{expiresMinutes}} 分钟内有效。"
  }
}
```

- `enabled`, `smtp.host` and `smtp.fromEmail` must all be present for the code request to send;
  otherwise it fails with `503 email_not_configured`.
- `useStartTls` and `useSsl` are mutually exclusive; `username` / `password` are the relay
  account, `fromEmail` / `fromName` the visible sender.
- Templates support `{{siteName}}`, `{{code}}`, `{{expiresMinutes}}` and `{{purpose}}`.
- Diagnostics (super admin only):
  - `GET /api/email/status` → `{ enabled, configured, host, port, username, fromEmail,
    fromName, useStartTls, useSsl, timeoutSeconds, lastSentAt, lastError, sentToday }`
    (never returns the password).
  - `GET /api/email/logs?limit=30` → `{ logs: [{ id, kind, recipient, subject, status, error,
    created_at }] }`; recipients are masked.
  - `POST /api/email/test` `{ to? }` – send a test message (defaults to `smtp.fromEmail`).
- Delivery attempts are written to `email_logs`; the password never appears in logs.

## Storage

- `data/settings.json` – all application settings, editable through API and UI (atomic writes).
- `data/teamstudio.db` – SQLite business data: `teams`, `groups`, `members` (incl.
  `avatar_url`), `works`, `todos`, `member_tasks`, `redblack_boards`/`entries`, `links`,
  `matrix_areas`, `announcements`, `task_tags`, `users`, `email_codes`,
  `user_activation_tokens`, `email_logs`, `audit_logs`, `app_meta`.
- `data/.session_secret` – generated HMAC signing key (never exposed).
- `data/uploads/avatars/` – uploaded profile photos, served under `/uploads/avatars/...`.
- `app_meta.factoryResetAt` / `factoryResetBy` – written by the device-Admin-only system reset;
  they record the last reset, and presence of `factoryResetAt` keeps `seed_if_empty()` (called
  without `force`) from refilling demo data. Startup never seeds regardless. A reset clears
  every other `app_meta` key.
- There is no local mailbox, outbox mirror or reminder bookkeeping any more: the legacy
  `mailbox_messages` and `email_reminders_sent` tables (plus the `todos` reminder columns) are
  dropped during the additive round-5 migration.

## Frontend routes (hash based)

`#/overview`, `#/tasks`, `#/insights`, `#/calendar`, `#/redblack`, `#/links`, `#/matrix`,
`#/announcements`, `#/profile`, `#/login`, `#/settings`.

- `#/login` – password-less e-mail code login / registration (optional SSO button when
  configured, guest browsing always reachable; guests are never auto-redirected).
- `#/profile` – personal home page for the signed-in account; `#/profile?userId=<id>` views
  another account (personal settings are only editable on your own page; super admins manage
  other accounts through the accounts tab in settings).
- `#/settings` – role-based tabs:
  - super admin: `workspace` (工作区设置), `appearance` (外观与站点), `modules` (模块与展示),
    `access` (成员与权限), `accounts` (账号与角色), `sso` (企业 SSO), `email` (邮件服务),
    `json` (高级 JSON) — hash form `#/settings?tab=workspace|appearance|modules|access|accounts|sso|email|json`.
  - deployment-device Admin only: additionally `reset` (重置系统) — the destructive factory reset
    in [System reset](#system-reset-deployment-device-admin-only). Stored `super` accounts never
    see this tab and `#/settings?tab=reset` falls back to a normal site tab for them.
  - team / group admins: only `workspace` (domain settings), rendered without site settings.
- Module flags hide nav entries; a direct hash remains accessible to admins so a hidden settings
  module can be restored. The `所有团队` (`?scope=all`) browsing scope is available to every
  identity — guests, members, group/team admins and super admins alike. Scope is a view
  preference, not a permission gate: `web/src/lib/scope.ts` exposes all three options to everyone
  and the backend accepts `?scope=all` for every identity.

## File ownership (round 5)

- Lead / foundation: `backend/app/config.py`, `db.py`, `auth.py`, `main.py`, `scope.py`,
  `seed.py`, `services/accounts.py`, `services/email_service.py`,
  `routers/auth.py`, `bootstrap.py`, `settings.py`, `users.py`, `profile.py`, `email.py`,
  `backend/tests/conftest.py`, root docs/scripts, `web/src/types.ts`, `api.ts`, `App.tsx`,
  `store.tsx`, `lib/scope.ts`, `web/e2e/round5-acceptance.mjs`.
- Backend boards owner: `backend/app/routers/boards.py` (red/black scope), `calendar.py`
  (reminder removal), `tasks.py`, `insights.py`, `backend/tests/test_group_modules.py`,
  `test_scope.py`, `test_sso_email.py`.
- Backend members owner: `backend/app/routers/workspace.py` (personal-info permission and avatar
  sync), `backend/tests/test_workspace_admin.py`, `test_matrix_backups.py`.
- Frontend auth owner: `web/src/pages/LoginPage.tsx/.css`, `pages/ProfilePage.tsx/.css`,
  `components/Avatar.tsx`, `components/AppShell.tsx`, `App.tsx`, `store.tsx`, `lib/utils.ts`.
- Frontend settings owner: `web/src/pages/SettingsPage.tsx/.css` (role-based tabs, accounts,
  SMTP, layered settings).
- Frontend pages owner: `web/src/pages/RedBlackPage.tsx/.css`, `CalendarPage.tsx/.css`,
  `components/TodoDialog.tsx`, `components/MemberDrawer.tsx`, `pages/OverviewPage.tsx/.css`.
- Workspace structure (round 3): `routers/workspaces.py`, auth helpers
  `can_manage_team/can_create_team/require_team_manager`, `components/WorkspaceManager.tsx/.css`,
  `components/Modal.tsx` (`ConfirmInputDialog`).
- Responsibility-matrix multi-backup (round 3): `db.py` (`_migrate_matrix_backups`), matrix
  section of `routers/boards.py`, `routers/workspace.py` `delete_member`, `seed.py`
  `_seed_matrix`, `components/MatrixNetwork.tsx`.
- Workload detail (round 3): `components/WorkloadMeter.tsx`,
  `components/WorkloadDetailDialog.tsx/.css`, workload rail in `pages/TaskOverviewPage.tsx/.css`.
- Docs/QA owner: `CONTRACT.md`, `README.md`, `TASKS_CONTRACT.md`, `docs/ROUND5_CONTRACT.md`,
  `web/package.json`, `web/e2e/*` (round-5 acceptance: `web/e2e/round5-acceptance.mjs`).
- System reset (device Admin only): `backend/app/routers/system.py`,
  `backend/app/auth.py` (`rotate_session_secret`), `backend/app/seed.py` (factory-reset marker),
  `backend/tests/test_system_reset.py`, `web/src/pages/SettingsPage.tsx/.css` (重置系统 tab),
  `web/src/components/Modal.tsx` (`ConfirmInputDialog` value), `web/e2e/system-reset.mjs`.
