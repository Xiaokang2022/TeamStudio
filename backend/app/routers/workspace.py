"""Team overview, member profiles and member work-item routes (round 8).

Base path: ``/api/teams/{team_id}``. Development groups no longer exist: every business
row is isolated by ``team_id`` only, member payloads carry no availability ``status`` and
every member / work payload carries the account's real avatar.

Response envelope is always ``{"ok": true, "data": ...}``; errors use
``HTTPException(status_code, detail={"code", "message", "details"})``.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from ..auth import CurrentUser, get_current_user
from ..config import EMAIL_PATTERN
from ..db import db, json_dumps, json_loads, new_id, now_iso, row, rows, scalar
from ..http import DATE_PATTERN, fail, get_member, get_team, int_value, ok, text
from ..permissions import (
    audit,
    require_member_writer,
    require_read_module,
    require_team_admin,
)
from ..services import accounts
from ..services.groups_service import get_group, list_group_payloads
from ..services.member_identity import (
    account_avatar_map,
    identity_fields,
    member_avatar,
    member_ids,
    team_members,
)
from ..services.tasks_service import build_workload_section

router = APIRouter(prefix="/api/teams/{team_id}", tags=["workspace"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
WORK_STATUSES = {"current", "done", "planned"}
# Member fields that describe the person rather than their place in the team: only a
# super administrator or the linked account owner may edit them.
PERSONAL_FIELDS = ("name", "email", "bio", "avatarColor", "tags", "skills", "avatar", "avatarUrl")


# --------------------------------------------------------------------------- helpers


def _parsed_list(value: Any, *, max_items: int = 40, max_length: int = 40) -> list[str]:
    """Parse a JSON list column into a deduplicated string list, tolerating bad data."""
    parsed = json_loads(value, []) if isinstance(value, str) or value is None else value
    if not isinstance(parsed, list):
        return []
    result: list[str] = []
    for item in parsed:
        if not isinstance(item, str):
            continue
        cleaned = item.strip()
        if cleaned and len(cleaned) <= max_length and cleaned not in result:
            result.append(cleaned)
        if len(result) >= max_items:
            break
    return result


def _string_list(value: Any, field: str, *, max_items: int = 20, max_length: int = 30) -> list[str]:
    """Validate a request payload string list (tags / skills)."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise fail(422, f"{field}必须是字符串数组", "validation_error")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise fail(422, f"{field}必须是字符串数组", "validation_error")
        cleaned = item.strip()
        if not cleaned:
            continue
        if len(cleaned) > max_length:
            raise fail(422, f"{field}中的单项不能超过 {max_length} 字", "validation_error")
        if cleaned not in result:
            result.append(cleaned)
    if len(result) > max_items:
        raise fail(422, f"{field}最多 {max_items} 项", "validation_error")
    return result


def _hex_color(value: Any, field: str = "颜色", fallback: str = "#5865f2") -> str:
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not HEX_PATTERN.fullmatch(value):
        raise fail(422, f"{field}必须是 #RRGGBB 格式", "validation_error")
    return value.lower()


def _email(value: Any) -> str:
    email = text(value, "邮箱", 120)
    if email and not EMAIL_PATTERN.fullmatch(email):
        raise fail(422, "邮箱格式不正确", "validation_error")
    return email


def _avatar_url(value: Any) -> str:
    """Validate an avatar path/URL written through a member payload."""
    if value is None:
        return ""
    return text(value, "头像", 500)


def _can_edit_personal_info(user: CurrentUser, member: dict[str, Any]) -> bool:
    """Super administrators and every archive row of the linked account may edit personal info."""
    if user.is_super_admin:
        return True
    member_id = str(member.get("id") or "")
    if user.is_linked_member(member_id):
        return True
    email = str(member.get("email") or "").strip().lower()
    return bool(email) and email == str(user.email or "").strip().lower()


def _work_payload(work: dict[str, Any], team: dict[str, Any]) -> dict[str, Any]:
    """CamelCase projection of one ``works`` row (team-only, no group fields)."""
    return {
        "id": work["id"],
        "memberId": work["member_id"],
        "teamId": work.get("team_id") or team.get("id", ""),
        "teamName": work.get("team_name") or team.get("name", ""),
        "title": work["title"],
        "description": work.get("description", ""),
        "status": work.get("status", "current"),
        "plannedDate": work.get("planned_date", ""),
        "category": work.get("category", ""),
        "progress": int(work.get("progress") or 0),
        "updatedAt": work.get("updated_at", ""),
    }


def _member_payload(
    member: dict[str, Any],
    works: list[dict[str, Any]],
    team: dict[str, Any],
    avatars: dict[str, str],
    open_todos: int = 0,
) -> dict[str, Any]:
    """``Member`` payload (contract §3.3): no status/group, real avatar, team identity."""
    work_items = [_work_payload(work, team) for work in works]
    current = [work for work in work_items if work["status"] == "current"]
    history = [work for work in work_items if work["status"] == "done"]
    return {
        "id": member["id"],
        "name": member["name"],
        "email": member.get("email", ""),
        "avatar": member_avatar(member, avatars),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "avatarColor": member.get("avatar_color", "#5865f2"),
        "bio": member.get("bio", ""),
        "tags": _parsed_list(member.get("tags")),
        "skills": _parsed_list(member.get("skills")),
        # ``duties`` has no dedicated column; tolerate future schema additions.
        "duties": _parsed_list(member.get("duties")),
        "joinedAt": member.get("joined_at", ""),
        "groupId": member.get("group_id") or "",
        "groupName": member.get("group_name") or "",
        "sortOrder": int(member.get("sort_order") or 0),
        "createdAt": member.get("created_at", ""),
        "teamId": team.get("id") or member.get("team_id", ""),
        "teamName": member.get("team_name") or team.get("name", ""),
        "currentWorks": current,
        "historyWorks": history,
        "stats": {"current": len(current), "done": len(history), "todos": open_todos},
    }


def _member_detail(conn, team: dict[str, Any], member: dict[str, Any]) -> dict[str, Any]:
    """One merged-person card for a single member archive (POST/PATCH responses)."""
    works = rows(
        conn,
        "SELECT * FROM works WHERE member_id=? AND team_id=? ORDER BY sort_order, created_at",
        (member["id"], team["id"]),
    )
    open_todos = int(
        scalar(
            conn,
            "SELECT COUNT(*) FROM todos WHERE assignee_member_id=? AND team_id=? AND status<>'done'",
            (member["id"], team["id"]),
            default=0,
        )
        or 0
    )
    avatars = account_avatar_map(conn)
    person = {"personKey": "", "primary": member, "rows": [member]}
    group_name = ""
    if member.get("group_id"):
        group = get_group(conn, team["id"], str(member["group_id"]), "member")
        group_name = str(group.get("name") or "") if group else ""
    card = _member_payload(
        {**member, "group_name": group_name}, works, team, avatars, open_todos
    )
    card.update(identity_fields(person))
    return card


_MEMBER_SELECT = (
    "SELECT m.*, t.name AS team_name, g.name AS group_name FROM members m "
    "JOIN teams t ON t.id=m.team_id "
    "LEFT JOIN team_groups g ON g.id=m.group_id AND g.team_id=m.team_id "
)


def _team_member_rows(conn, team_id: str) -> list[dict[str, Any]]:
    """Member rows for one team ordered by the round-9 sort order (contract section 3)."""
    return rows(
        conn,
        _MEMBER_SELECT + "WHERE m.team_id=? ORDER BY m.sort_order, m.created_at, m.id",
        (team_id,),
    )


def _member_cards(
    conn,
    team: dict[str, Any],
    member_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merged-person member cards ordered by sort_order, created_at, id."""
    works = rows(
        conn,
        "SELECT w.*, t.name AS team_name FROM works w "
        "JOIN teams t ON t.id=w.team_id WHERE w.team_id=? "
        "ORDER BY w.member_id, w.sort_order, w.created_at",
        (team["id"],),
    )
    todos = rows(
        conn,
        "SELECT id, assignee_member_id, status FROM todos WHERE team_id=?",
        (team["id"],),
    )
    avatars = account_avatar_map(conn)
    works_by_member: dict[str, list[dict[str, Any]]] = {}
    for work in works:
        works_by_member.setdefault(work["member_id"], []).append(work)
    open_todos_by_member: dict[str, int] = {}
    for todo in todos:
        assignee = todo.get("assignee_member_id")
        if assignee and todo.get("status") != "done":
            open_todos_by_member[assignee] = open_todos_by_member.get(assignee, 0) + 1
    members: list[dict[str, Any]] = []
    for person in team_members(member_rows):
        person_archive_ids = member_ids(person)
        person_works: list[dict[str, Any]] = []
        for archive_id in person_archive_ids:
            person_works.extend(works_by_member.get(archive_id, []))
        open_todos = sum(
            open_todos_by_member.get(archive_id, 0) for archive_id in person_archive_ids
        )
        card = _member_payload(person["primary"], person_works, team, avatars, open_todos)
        card.update(identity_fields(person))
        members.append(card)
    members.sort(
        key=lambda item: (
            int(item.get("sortOrder") or 0),
            str(item.get("createdAt") or ""),
            str(item.get("id") or ""),
        )
    )
    return members


def _team_detail(team: dict[str, Any], member_count: int = 0) -> dict[str, Any]:
    """Frontend-facing camelCase projection of one team (contract §3.3)."""
    return {
        "id": team["id"],
        "name": team["name"],
        "shortName": team.get("short_name", ""),
        "description": team.get("description", ""),
        "color": team.get("color", "#5865f2"),
        "memberCount": member_count,
    }


def _recent_activity(conn, team: dict[str, Any], limit: int = 12) -> list[dict[str, Any]]:
    """Cross-module recent activity for one team; no group fields."""
    team_id = team["id"]
    team_name = team.get("name", "")
    entries: list[dict[str, Any]] = []
    for todo in rows(
        conn,
        "SELECT t.id, t.title, t.status, t.updated_at, t.completed_at, "
        "m.name AS assignee_name "
        "FROM todos t LEFT JOIN members m ON m.id=t.assignee_member_id "
        "WHERE t.team_id=? ORDER BY t.updated_at DESC LIMIT 6",
        (team_id,),
    ):
        entries.append(
            {
                "id": todo["id"],
                "type": "todo",
                "title": todo["title"],
                "description": "待办已完成" if todo["status"] == "done" else "待办更新",
                "memberName": todo.get("assignee_name") or "",
                "memberId": None,
                "teamId": team_id,
                "teamName": team_name,
                "at": todo.get("completed_at") or todo.get("updated_at") or "",
            }
        )
    for announcement in rows(
        conn,
        "SELECT id, title, author_name, created_at FROM announcements "
        "WHERE team_id=? ORDER BY created_at DESC LIMIT 4",
        (team_id,),
    ):
        entries.append(
            {
                "id": announcement["id"],
                "type": "announcement",
                "title": announcement["title"],
                "description": "发布公告",
                "memberName": announcement.get("author_name", ""),
                "memberId": None,
                "teamId": team_id,
                "teamName": team_name,
                "at": announcement.get("created_at", ""),
            }
        )
    for work in rows(
        conn,
        "SELECT w.id, w.title, w.status, w.updated_at, w.member_id, m.name AS member_name "
        "FROM works w LEFT JOIN members m ON m.id=w.member_id "
        "WHERE w.team_id=? ORDER BY w.updated_at DESC LIMIT 4",
        (team_id,),
    ):
        entries.append(
            {
                "id": work["id"],
                "type": "work",
                "title": work["title"],
                "description": f"工作进展 · {work['status']}",
                "memberName": work.get("member_name", ""),
                "memberId": work.get("member_id"),
                "teamId": team_id,
                "teamName": team_name,
                "at": work.get("updated_at", ""),
            }
        )
    for entry in rows(
        conn,
        "SELECT e.id, e.side, e.title, e.reason, e.member_id, e.member_name, e.created_at "
        "FROM redblack_entries e JOIN redblack_boards b ON b.id=e.board_id "
        "WHERE b.team_id=? ORDER BY e.created_at DESC LIMIT 4",
        (team_id,),
    ):
        side = "红榜" if entry["side"] == "red" else "黑榜"
        description = side + (f" · {entry['reason']}" if entry.get("reason") else "")
        entries.append(
            {
                "id": entry["id"],
                "type": "redblack",
                "title": entry["title"],
                "description": description,
                "memberName": entry.get("member_name", ""),
                "memberId": entry.get("member_id"),
                "teamId": team_id,
                "teamName": team_name,
                "at": entry.get("created_at", ""),
            }
        )
    entries.sort(key=lambda item: str(item.get("at") or ""), reverse=True)
    return entries[:limit]


def _work_status(value: Any, default: str = "current") -> str:
    if value is None or value == "":
        return default
    if value not in WORK_STATUSES:
        raise fail(422, "工作状态必须是 current/done/planned", "validation_error")
    return value


def _planned_date(value: Any) -> str:
    """Validate the round-9 planned completion date (YYYY-MM-DD or empty)."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise fail(400, "计划完成时间格式应为 YYYY-MM-DD", "invalid_planned_date")
    cleaned = value.strip()
    if not cleaned:
        return ""
    if not DATE_PATTERN.fullmatch(cleaned):
        raise fail(400, "计划完成时间格式应为 YYYY-MM-DD", "invalid_planned_date")
    try:
        date.fromisoformat(cleaned)
    except ValueError:
        raise fail(400, "计划完成时间格式应为 YYYY-MM-DD", "invalid_planned_date")
    return cleaned


# --------------------------------------------------------------------------- overview


@router.get("/overview")
def team_overview(
    team_id: str,
    user: CurrentUser = Depends(require_read_module("overview")),
):
    with db() as conn:
        team = get_team(conn, team_id)
        member_rows = _team_member_rows(conn, team_id)
        work_rows = rows(
            conn,
            "SELECT w.*, t.name AS team_name FROM works w "
            "JOIN teams t ON t.id=w.team_id WHERE w.team_id=? "
            "ORDER BY w.member_id, w.sort_order, w.created_at",
            (team_id,),
        )
        todo_rows = rows(
            conn,
            "SELECT id, assignee_member_id, status FROM todos WHERE team_id=?",
            (team_id,),
        )
        pinned = int(
            scalar(
                conn,
                "SELECT COUNT(*) FROM announcements WHERE team_id=? AND pinned=1",
                (team_id,),
                default=0,
            )
            or 0
        )
        activity = _recent_activity(conn, team)
        workload_section = build_workload_section(conn, team_id)
        member_groups = list_group_payloads(conn, team_id, "member")
        # Round 9 requirement #3: merged-person cards follow the manual member order
        # (sort_order, created_at, id) instead of the old name ordering.
        members = _member_cards(conn, team, member_rows)

    works = [_work_payload(work, team) for work in work_rows]
    done_todos = sum(1 for todo in todo_rows if todo.get("status") == "done")
    stats = {
        "members": len(members),
        "works": len(work_rows),
        "currentWorks": sum(1 for work in works if work["status"] == "current"),
        "doneWorks": sum(1 for work in works if work["status"] == "done"),
        "plannedWorks": sum(1 for work in works if work["status"] == "planned"),
        "todos": len(todo_rows),
        "openTodos": len(todo_rows) - done_todos,
        "doneTodos": done_todos,
        "pinned": pinned,
    }
    return ok(
        {
            "team": _team_detail(team, len(members)),
            "members": members,
            "memberGroups": member_groups,
            "works": works,
            "recentActivity": activity,
            "stats": stats,
            "workloads": workload_section["workloads"],
            "workloadSummary": workload_section["summary"],
        }
    )


# --------------------------------------------------------------------------- members


@router.get("/member-candidates")
def list_member_candidates(
    team_id: str,
    search: str = Query(default=""),
    user: CurrentUser = Depends(get_current_user),
):
    """Registered accounts that can still join this team's member list.

    Candidates are ``users`` rows (pre-created but unverified accounts included) that
    have no member profile in this team yet. Accounts are matched to existing member rows
    by e-mail *or* immutable account id, so both link styles are recognised. The built-in
    device Admin is not a ``users`` row and can never appear.
    """
    with db() as conn:
        get_team(conn, team_id)
        require_team_admin(user, team_id)

        taken_emails: set[str] = set()
        taken_ids: set[str] = set()
        for existing in rows(
            conn,
            "SELECT lower(email) AS email, lower(external_id) AS external_id "
            "FROM members WHERE team_id=?",
            (team_id,),
        ):
            if existing.get("email"):
                taken_emails.add(str(existing["email"]))
            if existing.get("external_id"):
                taken_ids.add(str(existing["external_id"]))

        needle = text(search, "搜索关键词", 120).lower()
        candidates: list[dict[str, Any]] = []
        for account in rows(
            conn, "SELECT * FROM users ORDER BY name COLLATE NOCASE, id"
        ):
            account_id = str(account.get("id") or "")
            email = str(account.get("email") or "")
            if email.strip().lower() in taken_emails:
                continue
            if account_id.strip().lower() in taken_ids:
                continue
            if needle:
                haystacks = (
                    str(account.get("name") or "").lower(),
                    email.lower(),
                    account_id.lower(),
                )
                if not any(needle in value for value in haystacks):
                    continue
            role = str(account.get("role") or "member")
            candidates.append(
                {
                    "id": account_id,
                    "name": account.get("name") or account_id,
                    "email": email,
                    "avatar": account.get("avatar") or "",
                    "avatarColor": account.get("avatar_color") or "#5865f2",
                    "role": role,
                    "roleLabel": accounts.role_label(role),
                    "emailVerified": bool(account.get("email_verified")),
                    "skills": _parsed_list(account.get("skills")),
                }
            )
    return ok({"candidates": candidates, "total": len(candidates)})


@router.patch("/members/order")
def reorder_members(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Persist the manual member order (team administrators only).

    The body carries the complete ``memberIds`` list in display order; ids must be
    unique and belong to this team. ``sort_order`` becomes the index (0-based).
    """
    with db() as conn:
        team = get_team(conn, team_id)
        require_team_admin(user, team_id)
        raw_ids = payload.get("memberIds")
        if not isinstance(raw_ids, list):
            raise fail(400, "memberIds 必须是成员编号数组", "validation_error")
        ordered_ids: list[str] = []
        for item in raw_ids:
            if not isinstance(item, str) or not item.strip():
                raise fail(400, "成员编号格式不正确", "validation_error")
            cleaned = item.strip()
            if cleaned in ordered_ids:
                raise fail(400, "成员编号不能重复", "validation_error")
            ordered_ids.append(cleaned)
        existing_ids = {str(item["id"]) for item in _team_member_rows(conn, team_id)}
        if set(ordered_ids) != existing_ids:
            raise fail(400, "成员顺序必须包含该团队全部成员", "validation_error")
        now = now_iso()
        for index, member_id in enumerate(ordered_ids):
            conn.execute(
                "UPDATE members SET sort_order=?, updated_at=? WHERE id=? AND team_id=?",
                (index, now, member_id, team_id),
            )
        audit(conn, user, "member.reorder", "member", team_id, {"memberIds": ordered_ids})
        members = _member_cards(conn, team, _team_member_rows(conn, team_id))
    return ok({"members": members})


@router.patch("/members/{member_id}")
def update_member(
    team_id: str,
    member_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Update one member of a team.

    Personal fields (``name``/``email``/``bio``/``avatarColor``/``tags``/``skills``/
    ``avatar``) may only be changed by a super administrator or by the linked account
    owner; team administrators may still edit the organizational fields
    (``title``/``role``). Accepted personal edits are mirrored onto the linked ``users``
    row and every archive row of that account so avatars stay in sync everywhere.
    Availability ``status`` no longer exists (round 8 requirement #1) and is ignored.
    """
    with db() as conn:
        team = get_team(conn, team_id)
        member = get_member(conn, team_id, member_id)

        personal_fields = [field for field in PERSONAL_FIELDS if field in payload]
        if personal_fields and not _can_edit_personal_info(user, member):
            raise fail(403, "个人信息仅超级管理员和本人可编辑", "personal_info_forbidden")
        require_member_writer(user, team_id, member_id)

        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = text(payload.get("name"), "姓名", 60, required=True)
        if "email" in payload:
            updates["email"] = _email(payload.get("email"))
        if "title" in payload:
            updates["title"] = text(payload.get("title"), "职位", 60)
        if "role" in payload:
            updates["role"] = text(payload.get("role"), "角色", 40)
        if "bio" in payload:
            updates["bio"] = text(payload.get("bio"), "个人简介", 2000)
        if "avatarColor" in payload:
            updates["avatar_color"] = _hex_color(payload.get("avatarColor"), "头像颜色")
        if "tags" in payload:
            updates["tags"] = json_dumps(_string_list(payload.get("tags"), "标签"))
        if "skills" in payload:
            updates["skills"] = json_dumps(_string_list(payload.get("skills"), "技能"))
        if "avatar" in payload or "avatarUrl" in payload:
            raw_avatar = payload["avatar"] if "avatar" in payload else payload.get("avatarUrl")
            updates["avatar_url"] = _avatar_url(raw_avatar)
        if "groupId" in payload:
            # Round 9 requirement #8: grouping is organisational, so only team
            # administrators may move a member ("" or null clears the group).
            require_team_admin(user, team_id)
            raw_group = payload.get("groupId")
            if raw_group is None or raw_group == "":
                updates["group_id"] = ""
            elif not isinstance(raw_group, str):
                raise fail(400, "成员分组格式不正确", "validation_error")
            else:
                group_id = raw_group.strip()
                if not group_id:
                    updates["group_id"] = ""
                elif get_group(conn, team_id, group_id, "member") is None:
                    raise fail(400, "成员分组不存在", "group_not_found")
                else:
                    updates["group_id"] = group_id
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE members SET {assignments} WHERE id=? AND team_id=?",
                (*updates.values(), member_id, team_id),
            )
            audit(conn, user, "member.update", "member", member_id, {"fields": sorted(payload)})
        updated = get_member(conn, team_id, member_id)
        if personal_fields:
            # Mirror onto the account that owned this member *before* the edit. When the
            # member e-mail itself is changed the row would otherwise resolve to another
            # account and overwrite that stranger's profile.
            sync_row = dict(updated)
            if "email" in payload:
                sync_row["email"] = member.get("email", "")
                sync_row["external_id"] = member.get("external_id", "")
            accounts.sync_user_from_member(conn, sync_row)
            # Round 8 requirement #2: propagate the personal fields to every archive row
            # of the account (other teams) so avatars are identical everywhere.
            account = accounts.get_user_by_email(conn, str(updated.get("email") or ""))
            if account is None and updated.get("external_id"):
                account = accounts.get_user(conn, str(updated.get("external_id") or ""))
            if account:
                accounts.sync_members_from_user(conn, account)
            updated = get_member(conn, team_id, member_id)
        member_payload = _member_detail(conn, team, updated)
    return ok({"member": member_payload})


@router.post("/members")
def create_member(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Add a registered account to this team's member profiles.

    The request only selects a person via ``userId`` (account id, or an e-mail for manual
    callers). Every identity field is derived from the ``users`` row; custom
    ``name`` / ``email`` / ``id`` / ``avatar`` values are deliberately ignored so a
    member profile can never disagree with the account it represents. New writes keep at
    most one archive row per account per team.
    """
    with db() as conn:
        team = get_team(conn, team_id)
        require_team_admin(user, team_id)

        raw_user_id = text(payload.get("userId"), "账号 ID", 190, required=True)
        account = accounts.get_user(conn, raw_user_id)
        if not account and "@" in raw_user_id:
            account = accounts.get_user_by_email(conn, raw_user_id)
        if not account:
            # Internal identities (device Admin) are not stored in ``users`` either, so
            # they are rejected by the same lookup.
            raise fail(404, "账号不存在，请先在「系统设置 → 账号与角色」中创建账号", "user_not_found")
        account_id = str(account.get("id") or "")
        account_email = str(account.get("email") or "")
        existing = row(
            conn,
            "SELECT id FROM members WHERE team_id=? AND (lower(email)=? OR lower(external_id)=?) "
            "LIMIT 1",
            (team_id, account_email.lower(), account_id.lower()),
        )
        if existing:
            raise fail(409, "该账号已在当前团队的成员档案中", "member_exists")

        member_id = new_id("member")
        name = str(account.get("name") or "").strip() or account_id
        title = text(payload.get("title"), "职位", 60)
        role = text(payload.get("role"), "角色", 40)
        sort_order = (
            int_value(payload.get("sortOrder"), "排序", 0, 100_000)
            if payload.get("sortOrder") is not None
            else int(
                scalar(
                    conn,
                    "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM members WHERE team_id=?",
                    (team_id,),
                    default=1,
                )
                or 1
            )
        )
        now = now_iso()
        conn.execute(
            "INSERT INTO members (id,team_id,external_id,name,email,avatar_url,"
            "title,role,avatar_color,bio,tags,skills,joined_at,sort_order,created_at,"
            "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                member_id,
                team_id,
                account_id,
                name,
                account_email,
                account.get("avatar") or "",
                title,
                role,
                account.get("avatar_color") or "#5865f2",
                account.get("bio") or "",
                "[]",
                json_dumps(_parsed_list(account.get("skills"))),
                now,
                sort_order,
                now,
                now,
            ),
        )
        audit(conn, user, "member.create", "member", member_id, {"userId": account_id, "name": name})
        member = _member_detail(conn, team, get_member(conn, team_id, member_id))
    return ok({"member": member})


def _prune_matrix_backups(conn, team_id: str, member_id: str) -> None:
    """Remove a deleted member id from every responsibility area's backup JSON array."""
    for area in rows(
        conn,
        "SELECT id, backup_member_ids FROM matrix_areas "
        "WHERE team_id=? AND backup_member_ids LIKE ?",
        (team_id, f"%{member_id}%"),
    ):
        parsed = json_loads(area.get("backup_member_ids"), None)
        if not isinstance(parsed, list) or member_id not in parsed:
            continue
        remaining = [item for item in parsed if item != member_id]
        conn.execute(
            "UPDATE matrix_areas SET backup_member_ids=?, backup_member_id=? WHERE id=?",
            (
                json_dumps(remaining),
                remaining[0] if remaining else None,
                area["id"],
            ),
        )


@router.delete("/members/{member_id}")
def delete_member(
    team_id: str,
    member_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_team(conn, team_id)
        member = get_member(conn, team_id, member_id)
        require_team_admin(user, team_id)
        if user.is_linked_member(member_id):
            raise fail(409, "不能删除与当前登录身份关联的成员", "cannot_delete_self")
        # Responsibility matrix columns have no FK; detach them before the cascade delete.
        conn.execute(
            "UPDATE matrix_areas SET owner_member_id=NULL "
            "WHERE team_id=? AND owner_member_id=?",
            (team_id, member_id),
        )
        conn.execute(
            "UPDATE matrix_areas SET backup_member_id=NULL "
            "WHERE team_id=? AND backup_member_id=?",
            (team_id, member_id),
        )
        _prune_matrix_backups(conn, team_id, member_id)
        conn.execute(
            "UPDATE todos SET assignee_member_id=NULL WHERE team_id=? AND assignee_member_id=?",
            (team_id, member_id),
        )
        conn.execute("DELETE FROM members WHERE id=? AND team_id=?", (member_id, team_id))
        audit(conn, user, "member.delete", "member", member_id, {"name": member["name"]})
    return ok({"deleted": True, "id": member_id})


@router.get("/members/{member_id}/works")
def list_member_works(
    team_id: str,
    member_id: str,
    user: CurrentUser = Depends(require_read_module("overview")),
):
    with db() as conn:
        team = get_team(conn, team_id)
        get_member(conn, team_id, member_id)
        works = rows(
            conn,
            "SELECT w.*, t.name AS team_name FROM works w "
            "JOIN teams t ON t.id=w.team_id "
            "WHERE w.member_id=? AND w.team_id=? ORDER BY w.sort_order, w.created_at",
            (member_id, team_id),
        )
    return ok(
        {
            "memberId": member_id,
            "works": [_work_payload(work, team) for work in works],
        }
    )


def _get_work(conn, work_id: str, member_id: str, team_id: str) -> dict[str, Any]:
    found = row(
        conn,
        "SELECT * FROM works WHERE id=? AND member_id=? AND team_id=?",
        (work_id, member_id, team_id),
    )
    if not found:
        raise fail(404, "工作项不存在", "work_not_found")
    return found


@router.post("/members/{member_id}/works")
def create_work(
    team_id: str,
    member_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        team = get_team(conn, team_id)
        get_member(conn, team_id, member_id)
        require_member_writer(user, team_id, member_id)

        status = _work_status(payload.get("status"))
        title = text(payload.get("title"), "工作标题", 120, required=True)
        description = text(payload.get("description"), "工作描述", 2000)
        planned_date = _planned_date(payload.get("plannedDate"))
        category = text(payload.get("category"), "分类", 60)
        default_progress = 100 if status == "done" else 0
        progress = int_value(payload.get("progress", default_progress), "进度", 0, 100)
        sort_order = int(
            scalar(
                conn,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM works WHERE member_id=? AND team_id=?",
                (member_id, team_id),
                default=0,
            )
            or 0
        )
        work_id = new_id("work")
        now = now_iso()
        conn.execute(
            "INSERT INTO works (id,member_id,team_id,title,description,status,planned_date,"
            "category,progress,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                work_id,
                member_id,
                team_id,
                title,
                description,
                status,
                planned_date,
                category,
                progress,
                sort_order,
                now,
                now,
            ),
        )
        audit(conn, user, "work.create", "work", work_id, {"memberId": member_id, "title": title})
        work = _work_payload(_get_work(conn, work_id, member_id, team_id), team)
    return ok({"work": work})


@router.patch("/members/{member_id}/works/{work_id}")
def update_work(
    team_id: str,
    member_id: str,
    work_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        team = get_team(conn, team_id)
        get_member(conn, team_id, member_id)
        _get_work(conn, work_id, member_id, team_id)
        require_member_writer(user, team_id, member_id)

        updates: dict[str, Any] = {}
        if "title" in payload:
            updates["title"] = text(payload.get("title"), "工作标题", 120, required=True)
        if "description" in payload:
            updates["description"] = text(payload.get("description"), "工作描述", 2000)
        if "status" in payload:
            status = _work_status(payload.get("status"))
            updates["status"] = status
            if status == "done" and "progress" not in payload:
                updates["progress"] = 100
        if "plannedDate" in payload:
            updates["planned_date"] = _planned_date(payload.get("plannedDate"))
        if "category" in payload:
            updates["category"] = text(payload.get("category"), "分类", 60)
        if "progress" in payload:
            updates["progress"] = int_value(payload.get("progress"), "进度", 0, 100)
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE works SET {assignments} WHERE id=? AND member_id=? AND team_id=?",
                (*updates.values(), work_id, member_id, team_id),
            )
            audit(conn, user, "work.update", "work", work_id, {"fields": sorted(payload)})
        work = _work_payload(_get_work(conn, work_id, member_id, team_id), team)
    return ok({"work": work})


@router.delete("/members/{member_id}/works/{work_id}")
def delete_work(
    team_id: str,
    member_id: str,
    work_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_team(conn, team_id)
        get_member(conn, team_id, member_id)
        _get_work(conn, work_id, member_id, team_id)
        require_member_writer(user, team_id, member_id)
        conn.execute(
            "DELETE FROM works WHERE id=? AND member_id=? AND team_id=?",
            (work_id, member_id, team_id),
        )
        audit(conn, user, "work.delete", "work", work_id, {"memberId": member_id})
    return ok({"deleted": True, "id": work_id})
