"""Personal home page: account profile plus linked team data.

Each account owns a personal page that shows basic information / personal settings
and the group-scoped records linked by e-mail: responsibility areas, current and
historical tasks, assigned todos and red/black board entries. Personal profile
fields are editable by the account owner or a super administrator only.
"""

from __future__ import annotations

import re
import secrets
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, File, UploadFile

from ..auth import CurrentUser, require_authenticated
from ..config import UPLOAD_DIR
from ..db import db, json_loads, rows
from ..http import fail, ok
from ..permissions import audit, require_read_access
from ..services import accounts
from ..services.tasks_service import load_tag_map, task_payload

router = APIRouter(prefix="/api", tags=["profile"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
AVATAR_DIR = UPLOAD_DIR / "avatars"
MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_SKILLS = 20
MAX_SKILL_LENGTH = 30


# --------------------------------------------------------------------------- helpers


def _scope_members(conn: sqlite3.Connection, account: dict[str, Any]) -> list[dict[str, Any]]:
    email = str(account.get("email") or "").lower()
    account_id = str(account.get("id") or "").lower()
    if not email:
        # Avoid matching every member that happens to have an empty e-mail address.
        if not account_id or account.get("synthetic") or account_id.startswith("ip:"):
            return []
    return rows(
        conn,
        "SELECT m.*, g.name AS group_name, g.team_id AS group_team_id, g.color AS group_color, "
        "tm.name AS team_name FROM members m "
        "JOIN groups g ON g.id=m.group_id JOIN teams tm ON tm.id=g.team_id "
        "WHERE lower(m.email)=? OR lower(m.external_id)=? "
        "ORDER BY g.sort_order, g.name, m.sort_order, m.id",
        (email, account_id),
    )


def _member_brief(member: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": member["id"],
        "name": member.get("name", ""),
        "email": member.get("email", ""),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "avatarColor": member.get("avatar_color", "#5865f2"),
        "avatar": member.get("avatar_url", ""),
        "bio": member.get("bio", ""),
        "tags": json_loads(member.get("tags"), []) or [],
        "skills": json_loads(member.get("skills"), []) or [],
        "status": member.get("status", "available"),
        "groupId": member.get("group_id", ""),
        "groupName": member.get("group_name", ""),
        "teamId": member.get("group_team_id", ""),
        "teamName": member.get("team_name", ""),
    }


def _member_ids(members: list[dict[str, Any]]) -> list[str]:
    return [member["id"] for member in members]


def _duties(conn: sqlite3.Connection, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    placeholders = ",".join("?" for _ in member_ids)
    backup_clauses = " OR ".join("a.backup_member_ids LIKE ?" for _ in member_ids)
    areas = rows(
        conn,
        "SELECT a.*, g.name AS group_name, g.team_id AS group_team_id, tm.name AS team_name "
        "FROM matrix_areas a JOIN groups g ON g.id=a.group_id "
        "JOIN teams tm ON tm.id=g.team_id "
        f"WHERE a.owner_member_id IN ({placeholders}) "
        f"OR a.backup_member_id IN ({placeholders}) OR ({backup_clauses}) "
        "ORDER BY g.sort_order, g.name, a.sort_order, a.area",
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
                "groupId": area.get("group_id", ""),
                "groupName": area.get("group_name", ""),
                "teamId": area.get("group_team_id", ""),
                "teamName": area.get("team_name", ""),
            }
        )
    return result


def _tasks(conn: sqlite3.Connection, member_ids: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not member_ids:
        return [], []
    placeholders = ",".join("?" for _ in member_ids)
    task_rows = rows(
        conn,
        "SELECT t.*, m.name AS member_name, m.title AS member_title, "
        "m.avatar_color AS member_avatar_color, g.name AS group_name, "
        "g.team_id AS group_team_id, tm.name AS team_name "
        "FROM member_tasks t JOIN members m ON m.id=t.member_id "
        "JOIN groups g ON g.id=t.group_id JOIN teams tm ON tm.id=g.team_id "
        f"WHERE t.member_id IN ({placeholders}) "
        "ORDER BY t.expected_date DESC, t.updated_at DESC",
        tuple(member_ids),
    )
    group_ids = sorted({task["group_id"] for task in task_rows if task.get("group_id")})
    tag_map = load_tag_map(conn, group_ids) if group_ids else {}
    current: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []
    for task in task_rows:
        payload = task_payload(task, tag_map=tag_map)
        if task.get("progress_status") == "completed":
            history.append(payload)
        else:
            current.append(payload)
    return current, history


def _todos(conn: sqlite3.Connection, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    placeholders = ",".join("?" for _ in member_ids)
    records = rows(
        conn,
        "SELECT t.*, g.name AS group_name, g.team_id AS group_team_id, tm.name AS team_name "
        "FROM todos t JOIN groups g ON g.id=t.group_id "
        "JOIN teams tm ON tm.id=g.team_id "
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
            "groupId": item.get("group_id", ""),
            "groupName": item.get("group_name", ""),
            "teamId": item.get("group_team_id", ""),
            "teamName": item.get("team_name", ""),
        }
        for item in records
    ]


def _redblack(conn: sqlite3.Connection, member_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {"red": [], "black": []}
    if not member_ids:
        return result
    placeholders = ",".join("?" for _ in member_ids)
    entries = rows(
        conn,
        "SELECT e.*, b.month, b.group_id, g.name AS group_name, g.team_id AS group_team_id, "
        "tm.name AS team_name FROM redblack_entries e "
        "JOIN redblack_boards b ON b.id=e.board_id "
        "JOIN groups g ON g.id=b.group_id JOIN teams tm ON tm.id=g.team_id "
        f"WHERE e.member_id IN ({placeholders}) "
        "ORDER BY b.month DESC, e.sort_order",
        tuple(member_ids),
    )
    for entry in entries:
        payload = {
            "id": entry["id"],
            "side": entry["side"],
            "memberId": entry.get("member_id"),
            "memberName": entry.get("member_name", ""),
            "title": entry["title"],
            "reason": entry.get("reason", ""),
            "score": float(entry.get("score") or 0),
            "month": entry.get("month", ""),
            "groupId": entry.get("group_id", ""),
            "groupName": entry.get("group_name", ""),
            "teamId": entry.get("group_team_id", ""),
            "teamName": entry.get("team_name", ""),
            "createdAt": entry.get("created_at", ""),
        }
        side = entry.get("side")
        if side in result:
            result[side].append(payload)
    return result


def _synthetic_account(user: CurrentUser) -> dict[str, Any]:
    """Build a read-only profile account for device/IP/SSO identities without a row."""
    if user.is_device_admin:
        name, role, role_label = "Admin", "super", "超级管理员"
        bio = "系统内置管理员，在本机浏览器中自动获得全部管理权限。"
        color = "#0ea5e9"
    elif user.source == "ip":
        name, role, role_label = user.name or "IP 管理员", user.user_role or "team_admin", "IP 白名单管理员"
        bio = "通过部署方的 IP 白名单获得管理权限。"
        color = "#0ea5e9"
    else:
        name = user.name or user.id
        role = user.user_role or "member"
        role_label = accounts.role_label(role)
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
        "roleLabel": role_label,
        "team_ids": sorted(user.team_ids),
        "group_ids": sorted(user.group_ids),
        "email_verified": True,
        "created_by": "system",
        "created_at": "",
        "updated_at": "",
        "isDeviceAdmin": user.is_device_admin,
        "synthetic": True,
    }


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


def _admin_scope(conn: sqlite3.Connection, account: dict[str, Any]) -> dict[str, Any]:
    """Describe what an account administers (round 6 §2.2).

    Super administrators only summarise their role; team / group administrators get the
    names of the teams / development groups they manage. Membership never expands the
    arrays. Stale ids (team or group already deleted) are silently dropped.
    """
    is_device_admin = bool(account.get("isDeviceAdmin"))
    role = str(account.get("role") or "member")
    if is_device_admin or role == "super":
        role = "super"
    elif role not in {"team_admin", "group_admin"}:
        role = "member"
    payload: dict[str, Any] = {
        "role": role,
        "roleLabel": accounts.role_label(role),
        "summary": "",
        "teams": [],
        "groups": [],
        "isDeviceAdmin": is_device_admin,
    }
    if role == "super":
        payload["summary"] = "超级管理员"
        return payload
    if role == "team_admin":
        team_ids = _id_list(account.get("team_ids"))
        if not team_ids:
            return payload
        placeholders = ",".join("?" for _ in team_ids)
        found = {
            str(item["id"]): str(item["name"])
            for item in rows(
                conn,
                f"SELECT id, name FROM teams WHERE id IN ({placeholders})",
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
    if role == "group_admin":
        group_ids = _id_list(account.get("group_ids"))
        if not group_ids:
            return payload
        placeholders = ",".join("?" for _ in group_ids)
        found = {
            str(item["id"]): item
            for item in rows(
                conn,
                "SELECT g.id, g.name, g.team_id, tm.name AS team_name FROM groups g "
                "JOIN teams tm ON tm.id=g.team_id "
                f"WHERE g.id IN ({placeholders})",
                tuple(group_ids),
            )
        }
        payload["groups"] = [
            {
                "id": group_id,
                "name": str(found[group_id]["name"]),
                "teamId": str(found[group_id]["team_id"]),
                "teamName": str(found[group_id]["team_name"]),
            }
            for group_id in group_ids
            if group_id in found
        ]
        payload["summary"] = "、".join(
            f"{group['name']} 开发组管理员" for group in payload["groups"]
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
    current_tasks, history_tasks = _tasks(conn, member_ids)
    duties = _duties(conn, member_ids)
    todos = _todos(conn, member_ids)
    redblack = _redblack(conn, member_ids)
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
        "members": [_member_brief(member) for member in members],
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
            # Device Admin, IP admins and SSO identities without a stored e-mail
            # account still get a read-only personal page with their linked team data.
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
