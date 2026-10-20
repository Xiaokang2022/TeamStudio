# Round 5 contract · 邮箱验证码账号体系 / 个人主页 / 权限分级

> Historical design contract: this file records the round-5 implementation contract and is kept
> for reference only; `CONTRACT.md` is the long-term source of truth.

This file is the working contract for the round-5 refactor. `CONTRACT.md` is updated at the
end of the round as the long-term source of truth.

## 1. Identity & roles

- `users` table (see `backend/app/db.py`):
  - `id` = e-mail local part, lower-cased, **immutable**
  - `email` unique, lower-cased
  - `name` defaults to the local part; editable by the account owner **and** super admins only
  - `avatar` (`/uploads/avatars/...`), `avatar_color`, `bio`, `skills` (JSON array)
  - `role`: `member | group_admin | team_admin | super`
  - `team_ids` / `group_ids`: JSON arrays used to scope team/group admins
  - `email_verified`: pre-created accounts start at 0 and activate on first code login
- `CurrentUser` additions (`backend/app/auth.py`): `isSuperAdmin`, `userRole`, `avatar`,
  `avatarColor`, `bio`, `skills`, `emailVerified`, `source` can be `email`.
  - `permissions.canEditSettings` = super admin
  - `permissions.canManageUsers` = super admin
  - `permissions.canViewAllScope` = super admin
  - `permissions.canEditSelf` = authenticated cookie/session identity
- The deployment device (loopback) is still the built-in `Admin` (super, never stored).
  Super admins have the same permissions as the device Admin, except the device Admin row is
  not manageable/deletable.
- Sessions are sliding: `/api/bootstrap` and `/api/auth/me` re-issue the cookie; duration is
  `auth.session.maxAgeDays` (default 7).
- Non-super identities may **not** use `scope=all` (`resolve_scope(..., user)` raises
  `403 scope_forbidden`). All feature routers must pass `user` to `resolve_scope`.

## 2. Auth API

- `POST /api/auth/email/request` `{email}` →
  `{sent, email, purpose: "login"|"register", registered, expiresInSeconds, resendAfterSeconds, codeLength}`
  - 429 `code_rate_limited` with `details.retryAfterSeconds`
  - 503 `email_not_configured` when SMTP is incomplete
- `POST /api/auth/email/verify` `{email, code}` →
  `{loggedIn, isNewUser, user, sessionDays}` + sets the signed cookie.
  - Open registration: any valid e-mail creates a `member` account.
  - Pre-created (unverified) accounts are activated on first successful code login.
  - Errors: `code_invalid`, `code_expired`, `code_mismatch` (`details.remainingAttempts`),
    `code_attempts_exceeded`, `user_id_conflict`.
- `GET /api/auth/config` → public auth info incl. `emailService.{enabled,configured}`.
- SSO (`/api/auth/login`, `/api/auth/callback`) and `/api/auth/logout` remain.
- Guests are never auto-redirected to login.

Verification codes live in `email_codes` (HMAC hash, 6 digits, 10 min, max 5 attempts,
60 s resend). The plain code is never stored or logged.

## 3. Users / profile API

- `GET /api/users` (super) → `{users, deviceAdminName, permissions}`. First row is the
  synthetic device Admin (`isDeviceAdmin`, `canManage:false`).
- `POST /api/users` (super) `{email, name?, role?, teamIds?, groupIds?, emailVerified?}`
- `PATCH /api/users/{userId}` (super) `{name?, role?, teamIds?, groupIds?}`
- `DELETE /api/users/{userId}` (super; cannot delete self / device Admin)
- `GET /api/profile` (authenticated) → `ProfilePayload`
- `GET /api/users/{userId}/profile` (read access) → `ProfilePayload`
- `PATCH /api/profile` (self) `{name?, avatarColor?, bio?, skills?}`
- `POST /api/profile/avatar` multipart `file` (PNG/JPEG/WebP/GIF ≤2MB) → `{avatar, user}`
- `DELETE /api/profile/avatar`

`ProfilePayload`:
```json
{
  "user": { "id","email","name","avatar","avatarColor","bio","skills",
            "role","roleLabel","teamIds","groupIds","emailVerified","isDeviceAdmin" },
  "members": [{ "id","name","email","title","role","avatarColor","avatar","bio","tags",
                "skills","status","groupId","groupName","teamId","teamName" }],
  "duties": [{ "id","area","description","role":"owner|backup","channel","contact",
               "groupId","groupName","teamId","teamName" }],
  "currentTasks": [MemberTask],
  "historyTasks": [MemberTask],
  "todos": [{ "id","title","dueDate","status","priority",... }],
  "redblack": { "red": [RedBlackEntry + group fields], "black": [...] },
  "stats": { "duties","currentTasks","completedTasks","openTodos","redEntries","blackEntries" },
  "canEdit": true,
  "isSelf": true
}
```
Profile personal fields are mirrored to linked `members` rows by e-mail; member personal
edits mirror back to the account.

## 4. Settings layering

- Site-level (`GET/PUT /api/settings`, `/schema`, `/defaults`, `/workspace`): **super only**.
  Contains site/theme/modules/calendar/redblack/email SMTP/auth(SSO+whitelist+session)/features.
- Domain-level (`GET /api/settings/domain`): any admin. Returns only its teams/groups:
  ```json
  { "teams": [{ "id","name","shortName","description","color","canEdit",
                "groups": [{ "id","teamId","name","description","color","icon","canEdit" }] }],
    "permissions": { "canEditSite","canEditStructure","canEditTeam","canEditGroup",
                     "isSuperAdmin","isDeviceAdmin" } }
  ```
- `PATCH /api/settings/teams/{teamId}` (super or that team's team_admin)
- `PATCH /api/settings/teams/{teamId}/groups/{groupId}` (super / team_admin of the team /
  group_admin of the group)
- Team admins and group admins **cannot** read site settings; the frontend only renders the
  domain tab for them.

## 5. E-mail service

- No bundled SMTP server, no local mailbox, no calendar reminder scheduler.
- `email` settings: `enabled`, `smtp {host(IP/host), port, username, password, fromEmail,
  fromName, useStartTls, useSsl, timeoutSeconds}`, `subjectTemplate`, `bodyTemplate`.
- `GET /api/email/status` (super) → relay status, no password.
- `POST /api/email/test` (super) `{to?}`.
- `GET /api/email/logs` (super) → recent (masked) delivery log.
- Todo payload no longer contains `reminderOffsetsDays`, `emailEnabled`, `remindersSent`.
  Calendar UI removed those controls.

## 6. Member personal information rules

`PATCH /api/teams/{team}/groups/{group}/members/{memberId}`:

- **Personal fields** — `name`, `email`, `bio`, `avatarColor`, `avatar` — only a super
  administrator or the linked account owner (`user.linkedMemberId == memberId`, or the
  member e-mail matches the signed-in account) may change them. Otherwise `403
  personal_info_forbidden`.
- **Organizational fields** — `title`, `role`, `status` — in-scope team/group admins.
- The member payload gains `avatar`; member personal edits sync to the linked `users` row.

## 7. Red/black board scope

`GET .../redblack?month=&scope=` (default `group`, `all` only for super):

```json
{
  "month": "2026-10",
  "scope": { ...ScopeMeta },
  "board": { "id": null, "month": "...", "theme": "", "updatedAt": null,
             "red": [EntryWithGroup], "black": [EntryWithGroup], "exists": true },
  "boards": [{ "groupId","groupName","teamId","teamName","theme","red":[],"black":[] }],
  "availableMonths": ["2026-10", "..."]
}
```
- Entries gain `groupId`, `groupName`, `teamId`, `teamName`.
- Group scope keeps the single-board semantics/theme.
- Aggregate scopes merge entries for read-only display; writes remain group-scoped (`PUT`
  path group). The frontend hides editing/rollover in aggregate scope and shows a hint.

## 8. Frontend routes

- `#/login` – e-mail code login/register (guest → optional SSO + guest browsing)
- `#/profile` – personal home page (own); `#/profile?userId=` for another account
- `#/settings` – tabs depend on role:
  - super: appearance / modules+calendar / access / accounts / sso / email / json / workspace
  - team & group admins: workspace (domain settings) only
- `全部团队` scope option hidden for every non-super identity.
