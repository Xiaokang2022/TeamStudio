"""Personal home page: account profile plus linked team data (round 8).

Each account owns a personal page that shows its basic information / personal settings
and the records linked by e-mail across **teams**: responsibility areas, current and
historical tasks, assigned todos and red/black board entries. Development groups are
gone, so memberships / duties / todos / red-black entries only carry ``teamId`` /
``teamName`` and a member has no availability ``status`` any more. Member archive cards
carry the account's real avatar. Personal profile fields are editable by the account
owner or a super administrator only.
"""

from __future__ import annotations

import re
import secrets
import sqlite3
from datetime import date
from typing import Any

from fastapi import APIRouter, Body, Depends, File, UploadFile

from ..auth import CurrentUser, require_authenticated
from ..config import UPLOAD_DIR
from ..db import db, json_loads, rows
from ..http import fail, ok
from ..permissions import audit, require_read_access
from ..services import accounts
from ..services.member_identity import account_avatar_map, member_avatar, person_key

router = APIRouter(prefix="/api", tags=["profile"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
AVATAR_DIR = UPLOAD_DIR / "avatars"
MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_SKILLS = 20
MAX_SKILL_LENGTH = 30

# Load scoring mirrors the task ledger (profile tasks are display-only here). Kept in
# sync with ``services/tasks_service``: 1 base point + priority + difficulty bonuses.
PRIORITY_WEIGHTS = {"low": 0, "normal": 1, "high": 2, "urgent": 3}
DIFFICULTY_WEIGHTS = {"easy": 0, "medium": 1, "hard": 2}
OPEN_PROGRESS_STATUSES = {"pending", "in_progress"}


# --------------------------------------------------------------------------- helpers


def _scope_members(conn: sqlite3.Connection, account: dict[str, Any]) -> list[dict[str, Any]]:
    """Every member archive row of one account, across all teams."""
    email = str(account.get("email") or "").lower()
    account_id = str(account.get("id") or "").lower()
    if not email:
        # Avoid matching every member that happens to have an empty e-mail address.
        if not account_id or account.get("synthetic") or account_id.startswith("ip:"):
            return []
    return rows(
        conn,
        "SELECT m.*, tm.name AS team_name FROM members m "
        "JOIN teams tm ON tm.id=m.team_id "
        "WHERE lower(m.email)=? OR lower(m.external_id)=? "
        "ORDER BY tm.sort_order, tm.name, m.sort_order, m.id",
        (email, account_id),
    )


def _member_brief(member: dict[str, Any], avatars: dict[str, str]) -> dict[str, Any]:
    """``ProfileMember`` (contract §3.3): team identity only, no group/status."""
    return {
        "id": member["id"],
        "name": member.get("name", ""),
        "email": member.get("email", ""),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "avatarColor": member.get("avatar_color", "#5865f2"),
        "avatar": member_avatar(member, avatars),
        "bio": member.get("bio", ""),
        "tags": json_loads(member.get("tags"), []) or [],
        "skills": json_loads(member.get("skills"), []) or [],
        "teamId": member.get("team_id", ""),
        "teamName": member.get("team_name", ""),
    }


def _membership_payload(member: dict[str, Any]) -> dict[str, Any]:
    """One ``Memberships`` row: an archive row inside its team, no group/status."""
    return {
        "memberId": member["id"],
        "memberName": member.get("name", ""),
        "teamId": member.get("team_id", ""),
        "teamName": member.get("team_name", ""),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "joinedAt": member.get("joined_at", ""),
    }


def _member_ids(members: list[dict[str, Any]]) -> list[str]:
    return [member["id"] for member in members]


def _profile_member_rows(members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One archive card per (person, team): in-team legacy duplicates collapse."""
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for member in members:
        key = (person_key(member), str(member.get("team_id") or ""))
        if key in seen:
            continue
        seen.add(key)
        result.append(member)
    return result


def _id_list(value: Any) -> list[str]:
    """Parse a JSON / list column into an ordered, deduplicated id list."""
    parsed = json_loads(value, []) if isinstance(value, str) else value
    if not isinstance(parsed, list):
        return []
    result: list[str] = []
    for item in parsed:
        cleaned = str(item).strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def _placeholders(items: list[str]) -> str:
    return ",".join("?" for _ in items) if items else "NULL"


# --------------------------------------------------------------------------- linked data


def _duties(conn: sqlite3.Connection, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    placeholders = _placeholders(member_ids)
    backup_clauses = " OR ".join("a.backup_member_ids LIKE ?" for _ in member_ids)
    areas = rows(
        conn,
        "SELECT a.*, tm.name AS team_name FROM matrix_areas a "
        "JOIN teams tm ON tm.id=a.team_id "
        f"WHERE a.owner_member_id IN ({placeholders}) "
        f"OR a.backup_member_id IN ({placeholders}) OR ({backup_clauses}) "
        "ORDER BY tm.sort_order, tm.name, a.sort_order, a.area",
        (*member_ids, *member_ids, *(f'%"{member_id}"%' for member_id in member_ids)),
    )
    wanted = set(member_ids)
    result: list[dict[str, Any]] = []
    for area in areas:
        backups = json_loads(area.get("backup_member_ids"), [])
        if not isinstance(backups, list):
            backups = []
        legacy = area.get("backup_member_id")
        if legacy and legacy not in backups:
            backups.append(legacy)
        role = "owner" if area.get("owner_member_id") in wanted else "backup"
        if role == "backup" and not any(item in wanted for item in backups):
            continue
        result.append(
            {
                "id": area["id"],
                "area": area.get("area", ""),
                "description": area.get("description", ""),
                "role": role,
                "channel": area.get("channel", ""),
                "contact": area.get("contact", ""),
                "teamId": area.get("team_id", ""),
                "teamName": area.get("team_name", ""),
            }
        )
    return result


def _tag_map(conn: sqlite3.Connection, team_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not team_ids:
        return {}
    tags = rows(
        conn,
        "SELECT * FROM task_tags "
        f"WHERE team_id IN ({_placeholders(team_ids)}) ORDER BY name",
        tuple(team_ids),
    )
    return {
        tag["id"]: {
            "id": tag["id"],
            "teamId": tag.get("team_id", ""),
            "name": tag.get("name", ""),
            "color": tag.get("color", "#5865f2"),
        }
        for tag in tags
    }


def _task_load_points(task: dict[str, Any]) -> int:
    priority = str(task.get("priority") or "normal")
    difficulty = str(task.get("difficulty") or "medium")
    return (
        1
        + PRIORITY_WEIGHTS.get(priority, PRIORITY_WEIGHTS["normal"])
        + DIFFICULTY_WEIGHTS.get(difficulty, DIFFICULTY_WEIGHTS["medium"])
    )


def _task_payload(
    task: dict[str, Any],
    avatars: dict[str, str],
    tag_map: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """``MemberTask`` (contract §3.3): team-only, real ``memberAvatar``."""
    stored_tag_ids = [
        item
        for item in (json_loads(task.get("tags"), []) or [])
        if isinstance(item, str) and item
    ]
    member_identity = {
        "email": task.get("m_email", ""),
        "external_id": task.get("m_external_id", ""),
        "avatar_url": task.get("m_avatar_url", ""),
    }
    expected = str(task.get("expected_date") or "")
    overdue = False
    if expected and task.get("progress_status") != "completed":
        try:
            overdue = date.fromisoformat(expected) < date.today()
        except ValueError:
            overdue = False
    return {
        "id": task["id"],
        "teamId": task.get("team_id", ""),
        "teamName": task.get("team_name", ""),
        "memberId": task.get("member_id", ""),
        "memberName": task.get("member_name", ""),
        "memberTitle": task.get("member_title", ""),
        "memberAvatar": member_avatar(member_identity, avatars),
        "memberAvatarColor": task.get("member_avatar_color", "#5865f2"),
        "title": task.get("title", ""),
        "description": task.get("description", ""),
        "progressStatus": task.get("progress_status", "pending"),
        "healthStatus": task.get("health_status", "normal"),
        "priority": task.get("priority") or "normal",
        "difficulty": task.get("difficulty") or "medium",
        "loadPoints": _task_load_points(task),
        "expectedDate": expected,
        "tagIds": stored_tag_ids,
        "tags": [tag_map[tag_id] for tag_id in stored_tag_ids if tag_id in tag_map],
        "createdBy": task.get("created_by", ""),
        "createdAt": task.get("created_at", ""),
        "updatedAt": task.get("updated_at", ""),
        "completedAt": task.get("completed_at") or None,
        "overdue": overdue,
    }


def _tasks(
    conn: sqlite3.Connection,
    member_ids: list[str],
    avatars: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not member_ids:
        return [], []
    placeholders = _placeholders(member_ids)
    task_rows = rows(
        conn,
        "SELECT t.*, m.name AS member_name, m.title AS member_title, "
        "m.avatar_color AS member_avatar_color, m.email AS m_email, "
        "m.external_id AS m_external_id, m.avatar_url AS m_avatar_url, "
        "tm.name AS team_name "
        "FROM member_tasks t JOIN members m ON m.id=t.member_id "
        "JOIN teams tm ON tm.id=t.team_id "
        f"WHERE t.member_id IN ({placeholders}) "
        "ORDER BY t.expected_date DESC, t.updated_at DESC",
        tuple(member_ids),
    )
    team_ids = sorted({str(task["team_id"]) for task in task_rows if task.get("team_id")})
    tag_map = _tag_map(conn, team_ids)
    current: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []
    for task in task_rows:
        payload = _task_payload(task, avatars, tag_map)
        if task.get("progress_status") == "completed":
            history.append(payload)
        else:
            current.append(payload)
    return current, history


def _todos(conn: sqlite3.Connection, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    placeholders = _placeholders(member_ids)
    records = rows(
        conn,
        "SELECT t.*, tm.name AS team_name FROM todos t "
        "JOIN teams tm ON tm.id=t.team_id "
        f"WHERE t.assignee_member_id IN ({placeholders}) "
        "ORDER BY t.due_date DESC, t.due_time DESC LIMIT 30",
        tuple(member_ids),
    )
    return [
        {
            "id": item["id"],
            "title": item["title"],
            "description": item.get("description", ""),
            "dueDate": item.get("due_date", ""),
            "dueTime": item.get("due_time", ""),
            "status": item.get("status", "todo"),
            "priority": item.get("priority", "normal"),
            "teamId": item.get("team_id", ""),
            "teamName": item.get("team_name", ""),
        }
        for item in records
    ]


def _redblack(
    conn: sqlite3.Connection,
    member_ids: list[str],
    avatars: dict[str, str],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {"red": [], "black": []}
    if not member_ids:
        return result
    placeholders = _placeholders(member_ids)
    entries = rows(
        conn,
        "SELECT e.*, b.month, b.team_id, tm.name AS team_name, "
        "m.email AS m_email, m.external_id AS m_external_id, "
        "m.avatar_url AS m_avatar_url "
        "FROM redblack_entries e "
        "JOIN redblack_boards b ON b.id=e.board_id "
        "JOIN teams tm ON tm.id=b.team_id "
        "LEFT JOIN members m ON m.id=e.member_id "
        f"WHERE e.member_id IN ({placeholders}) "
        "ORDER BY b.month DESC, e.sort_order",
        tuple(member_ids),
    )
    for entry in entries:
        member_identity = {
            "email": entry.get("m_email", ""),
            "external_id": entry.get("m_external_id", ""),
            "avatar_url": entry.get("m_avatar_url", ""),
        }
        payload = {
            "id": entry["id"],
            "side": entry["side"],
            "memberId": entry.get("member_id"),
            "memberName": entry.get("member_name", ""),
            "memberAvatar": member_avatar(member_identity, avatars),
            "title": entry["title"],
            "reason": entry.get("reason", ""),
            "score": float(entry.get("score") or 0),
            "month": entry.get("month", ""),
            "teamId": entry.get("team_id", ""),
            "teamName": entry.get("team_name", ""),
            "createdAt": entry.get("created_at", ""),
        }
        side = entry.get("side")
        if side in result:
            result[side].append(payload)
    return result


# --------------------------------------------------------------------------- account scope


def _synthetic_account(user: CurrentUser) -> dict[str, Any]:
    """Build a read-only profile account for device/SSO identities without a row."""
    if user.is_device_admin:
        name, role = "Admin", "super"
        bio = "系统内置管理员，在部署设备浏览器中自动获得全部管理权限。"
        color = "#0ea5e9"
    elif user.source == "ip":
        name = user.name or "IP 管理员"
        role = user.user_role if user.user_role in {"team_admin", "member"} else (
            "team_admin" if user.team_ids else "member"
        )
        bio = "通过部署方的 IP 白名单获得管理权限。"
        color = "#0ea5e9"
    else:
        name = user.name or user.id
        role = user.user_role if user.user_role in accounts.USER_ROLES else "member"
        bio = user.bio or ""
        color = user.avatar_color or "#5865f2"
    # ``accounts.user_payload`` reads snake_case DB column names, so the synthetic
    # account mirrors that shape to keep avatar colour / verification state intact.
    return {
        "id": user.id,
        "email": user.email,
        "name": name,
        "avatar": user.avatar,
        "avatar_color": color,
        "bio": bio,
        "skills": list(user.skills),
        "role": role,
        "team_ids": sorted(user.team_ids),
        "email_verified": True,
        "created_by": "system",
        "created_at": "",
        "updated_at": "",
        "isDeviceAdmin": user.is_device_admin,
        "synthetic": True,
    }


def _admin_scope(conn: sqlite3.Connection, account: dict[str, Any]) -> dict[str, Any]:
    """Describe what an account administers: teams only (no groups, no group_admin).

    Super administrators only summarise their role; team administrators get the names of
    the teams they manage. Membership never expands the array. Stale ids (team already
    deleted) are silently dropped.
    """
    is_device_admin = bool(account.get("isDeviceAdmin"))
    role = str(account.get("role") or "member")
    if is_device_admin or role == "super":
        role = "super"
    elif role != "team_admin":
        role = "member"
    payload: dict[str, Any] = {
        "role": role,
        "roleLabel": accounts.role_label(role),
        "summary": "",
        "teams": [],
        "isDeviceAdmin": is_device_admin,
    }
    if role == "super":
        payload["summary"] = "超级管理员"
        return payload
    if role == "team_admin":
        team_ids = _id_list(account.get("team_ids"))
        if not team_ids:
            return payload
        found = {
            str(item["id"]): str(item["name"])
            for item in rows(
                conn,
                f"SELECT id, name FROM teams WHERE id IN ({_placeholders(team_ids)})",
                tuple(team_ids),
            )
        }
        payload["teams"] = [
            {"id": team_id, "name": found[team_id]}
            for team_id in team_ids
            if team_id in found
        ]
        payload["summary"] = "、".join(
            f"{team['name']} 团队管理员" for team in payload["teams"]
        )
    return payload


def build_profile(
    conn: sqlite3.Connection,
    user: CurrentUser,
    account: dict[str, Any],
    *,
    can_edit_override: bool | None = None,
) -> dict[str, Any]:
    members = _scope_members(conn, account)
    member_ids = _member_ids(members)
    avatars = account_avatar_map(conn)
    duties = _duties(conn, member_ids)
    current_tasks, history_tasks = _tasks(conn, member_ids, avatars)
    todos = _todos(conn, member_ids)
    redblack = _redblack(conn, member_ids, avatars)
    # Requirement #3: archive cards are ordered by name ascending.
    member_cards = [
        _member_brief(member, avatars) for member in _profile_member_rows(members)
    ]
    member_cards.sort(key=lambda item: str(item.get("name") or "").casefold())
    if can_edit_override is not None:
        can_edit = can_edit_override
    else:
        can_edit = bool(
            user.is_super_admin
            or (user.authenticated and str(user.id) == str(account.get("id")))
        )
    payload_user = accounts.user_payload(account)
    payload_user["isDeviceAdmin"] = bool(account.get("isDeviceAdmin"))
    payload_user["roleLabel"] = account.get("roleLabel") or payload_user.get("roleLabel")
    return {
        "user": payload_user,
        "adminScope": _admin_scope(conn, account),
        "members": member_cards,
        "memberships": [_membership_payload(member) for member in members],
        "duties": duties,
        "currentTasks": current_tasks,
        "historyTasks": history_tasks,
        "todos": todos,
        "redblack": redblack,
        "stats": {
            "duties": len(duties),
            "currentTasks": len(current_tasks),
            "completedTasks": len(history_tasks),
            "openTodos": sum(1 for todo in todos if todo.get("status") != "done"),
            "redEntries": len(redblack["red"]),
            "blackEntries": len(redblack["black"]),
        },
        "canEdit": can_edit,
        "isSelf": user.is_device_admin or str(user.id) == str(account.get("id")),
    }


def _load_account(conn: sqlite3.Connection, user_id: str) -> dict[str, Any] | None:
    return accounts.get_user(conn, user_id)


# --------------------------------------------------------------------------- routes


@router.get("/profile")
def get_my_profile(user: CurrentUser = Depends(require_authenticated)):
    with db() as conn:
        account = _load_account(conn, user.id)
        if not account:
            # Device Admin / IP admins / SSO identities without a stored e-mail account
            # still get a read-only personal page with their linked team data.
            return ok(
                build_profile(conn, user, _synthetic_account(user), can_edit_override=False)
            )
        return ok(build_profile(conn, user, account))


@router.get("/users/{user_id}/profile")
def get_user_profile(user_id: str, user: CurrentUser = Depends(require_read_access)):
    with db() as conn:
        account = _load_account(conn, user_id)
        if not account:
            if user_id == user.id:
                return ok(
                    build_profile(conn, user, _synthetic_account(user), can_edit_override=False)
                )
            raise fail(404, "账号不存在", "user_not_found")
        return ok(build_profile(conn, user, account))


def _detect_avatar_format(content: bytes) -> tuple[str, str] | None:
    """Detect the avatar format from magic bytes only.

    The browser-declared ``UploadFile.content_type`` and the filename are *not*
    trustworthy: Windows / some browsers report genuine PNGs as ``image/x-png``,
    ``application/octet-stream`` or with an empty type. File content is the single
    source of truth, and the returned extension is derived from that detection.
    """
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", ".png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpeg", ".jpg"
    if content.startswith(b"GIF87a") or content.startswith(b"GIF89a"):
        return "gif", ".gif"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp", ".webp"
    return None


def _avatar_bytes(content: bytes) -> str:
    if len(content) > MAX_AVATAR_BYTES:
        raise fail(413, "头像图片不能超过 2MB", "avatar_too_large")
    if not content:
        raise fail(422, "头像文件为空", "avatar_empty")
    detected = _detect_avatar_format(content)
    if detected is None:
        raise fail(
            422,
            "头像仅支持 PNG / JPEG / WebP / GIF 格式",
            "avatar_type_unsupported",
        )
    _kind, extension = detected
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{secrets.token_hex(12)}{extension}"
    (AVATAR_DIR / filename).write_bytes(content)
    return f"/uploads/avatars/{filename}"


def _remove_avatar_file(value: str) -> None:
    if not value or not value.startswith("/uploads/avatars/"):
        return
    candidate = (UPLOAD_DIR / value.removeprefix("/uploads/")).resolve()
    try:
        if candidate.is_file() and AVATAR_DIR.resolve() in candidate.parents:
            candidate.unlink()
    except OSError:  # pragma: no cover - best effort cleanup
        pass


@router.post("/profile/avatar")
def upload_my_avatar(
    file: UploadFile = File(...),
    user: CurrentUser = Depends(require_authenticated),
):
    if user.is_device_admin:
        raise fail(403, "系统内置管理员没有个人账号头像", "device_admin_profile")
    content = file.file.read()
    avatar_url = _avatar_bytes(content)
    with db() as conn:
        account = _load_account(conn, user.id)
        if not account:
            _remove_avatar_file(avatar_url)
            raise fail(404, "账号不存在，请重新登录", "user_not_found")
        previous = account.get("avatar") or ""
        updated = accounts.update_user(conn, user.id, avatar=avatar_url)
        # Requirement #2: mirror the new avatar onto every team member row.
        accounts.sync_members_from_user(conn, updated)
        audit(conn, user, "profile.avatar", "user", user.id)
        _remove_avatar_file(previous)
    return ok({"avatar": avatar_url, "user": accounts.user_payload(updated)})


@router.delete("/profile/avatar")
def delete_my_avatar(user: CurrentUser = Depends(require_authenticated)):
    if user.is_device_admin:
        raise fail(403, "系统内置管理员没有个人账号头像", "device_admin_profile")
    with db() as conn:
        account = _load_account(conn, user.id)
        if not account:
            raise fail(404, "账号不存在，请重新登录", "user_not_found")
        previous = account.get("avatar") or ""
        updated = accounts.update_user(conn, user.id, avatar="")
        accounts.sync_members_from_user(conn, updated)
        audit(conn, user, "profile.avatar_remove", "user", user.id)
        _remove_avatar_file(previous)
    return ok({"user": accounts.user_payload(updated)})


@router.patch("/profile")
def update_my_profile(
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(require_authenticated),
):
    if user.is_device_admin:
        raise fail(403, "系统内置管理员资料由系统固定", "device_admin_profile")
    name = payload.get("name")
    if name is not None:
        name = str(name).strip()
        if not name or len(name) > 60:
            raise fail(422, "用户名长度需在 1–60 个字符之间", "invalid_name")
    avatar_color = payload.get("avatarColor")
    if avatar_color is not None and not HEX_PATTERN.fullmatch(str(avatar_color)):
        raise fail(422, "头像颜色必须是 #RRGGBB 格式", "invalid_color")
    bio = payload.get("bio")
    if bio is not None and len(str(bio)) > 2000:
        raise fail(422, "个人简介不能超过 2000 个字符", "invalid_bio")
    skills = payload.get("skills")
    if skills is not None:
        if not isinstance(skills, list):
            raise fail(422, "技能标签必须是字符串数组", "invalid_skills")
        cleaned = []
        for item in skills:
            value = str(item).strip()
            if not value:
                continue
            if len(value) > MAX_SKILL_LENGTH:
                raise fail(422, f"单个技能标签不能超过 {MAX_SKILL_LENGTH} 个字符", "invalid_skills")
            if value not in cleaned:
                cleaned.append(value)
        if len(cleaned) > MAX_SKILLS:
            raise fail(422, f"技能标签最多 {MAX_SKILLS} 个", "invalid_skills")
        skills = cleaned
    with db() as conn:
        account = _load_account(conn, user.id)
        if not account:
            raise fail(404, "账号不存在，请重新登录", "user_not_found")
        updated = accounts.update_user(
            conn,
            user.id,
            name=name,
            avatar_color=str(avatar_color).lower() if avatar_color is not None else None,
            bio=str(bio) if bio is not None else None,
            skills=skills,
        )
        accounts.sync_members_from_user(conn, updated)
        audit(
            conn,
            user,
            "profile.update",
            "user",
            user.id,
            {"fields": sorted(payload.keys())},
        )
    return ok({"user": accounts.user_payload(updated)})
