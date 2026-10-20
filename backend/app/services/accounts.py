"""Account helpers shared by the e-mail login flow and the user administration API.

The ``users`` table is the source of truth for an account's login identity and
personal profile. Group-scoped ``members`` rows are linked by e-mail; personal
fields are synchronised so member cards, the personal home page and account
settings always agree.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import EMAIL_PATTERN, settings_service
from ..db import json_loads, new_id, now_iso, row

USER_ROLES = ("member", "group_admin", "team_admin", "super")
ROLE_LABELS = {
    "member": "成员",
    "group_admin": "开发组管理员",
    "team_admin": "团队管理员",
    "super": "超级管理员",
}
LOCAL_PART_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class AccountError(ValueError):
    def __init__(self, message: str, code: str = "invalid_account", status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code


def normalize_email(value: Any) -> str:
    email = str(value or "").strip().lower()
    if not email or not EMAIL_PATTERN.fullmatch(email) or len(email) > 190:
        raise AccountError("请输入有效的邮箱地址", "invalid_email")
    return email


def email_local_part(email: str) -> str:
    local = email.split("@", 1)[0]
    if not LOCAL_PART_PATTERN.fullmatch(local):
        raise AccountError(
            "邮箱前缀只能包含字母、数字、点、下划线或连字符，且需以字母或数字开头",
            "invalid_email_local_part",
        )
    return local


def derive_user_id(email: str) -> str:
    """A user's immutable id is the lower-cased local part of its e-mail."""
    return email_local_part(email).lower()


def role_label(role: str) -> str:
    return ROLE_LABELS.get(role, "成员")


def _list(value: Any) -> list[str]:
    parsed = json_loads(value, []) if isinstance(value, str) else value
    if not isinstance(parsed, list):
        return []
    result: list[str] = []
    for item in parsed:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def user_payload(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "avatar": user.get("avatar", ""),
        "avatarColor": user.get("avatar_color", "#5865f2"),
        "bio": user.get("bio", ""),
        "skills": _list(user.get("skills")),
        "role": user.get("role", "member"),
        "roleLabel": role_label(user.get("role", "member")),
        "teamIds": _list(user.get("team_ids")),
        "groupIds": _list(user.get("group_ids")),
        "emailVerified": bool(user.get("email_verified")),
        "createdBy": user.get("created_by", ""),
        "createdAt": user.get("created_at", ""),
        "updatedAt": user.get("updated_at", ""),
    }


def get_user(conn: sqlite3.Connection, user_id: str) -> dict[str, Any] | None:
    return row(conn, "SELECT * FROM users WHERE id=?", (user_id,))


def get_user_by_email(conn: sqlite3.Connection, email: str) -> dict[str, Any] | None:
    return row(conn, "SELECT * FROM users WHERE lower(email)=?", (email.lower(),))


def create_user(
    conn: sqlite3.Connection,
    *,
    email: str,
    name: str = "",
    role: str = "member",
    team_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
    email_verified: bool = False,
    created_by: str = "",
) -> dict[str, Any]:
    from ..db import json_dumps

    email = normalize_email(email)
    user_id = derive_user_id(email)
    if role not in USER_ROLES:
        raise AccountError("账号角色不合法", "invalid_role")
    if get_user_by_email(conn, email):
        raise AccountError("该邮箱已存在账号", "email_exists", 409)
    if get_user(conn, user_id):
        raise AccountError(
            "该邮箱前缀已被其他账号占用，请更换邮箱", "user_id_conflict", 409
        )
    now = now_iso()
    display_name = (name or "").strip() or email_local_part(email)
    if len(display_name) > 60:
        raise AccountError("用户名不能超过 60 个字符", "invalid_name")
    conn.execute(
        "INSERT INTO users (id,email,name,avatar,avatar_color,bio,skills,role,team_ids,"
        "group_ids,email_verified,created_by,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            user_id,
            email,
            display_name,
            "",
            "#5865f2",
            "",
            "[]",
            role,
            json_dumps(sorted(set(team_ids or []))),
            json_dumps(sorted(set(group_ids or []))),
            1 if email_verified else 0,
            created_by,
            now,
            now,
        ),
    )
    created = get_user(conn, user_id)
    assert created is not None
    return created


def mark_email_verified(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    conn.execute(
        "UPDATE users SET email_verified=1, updated_at=? WHERE id=?",
        (now_iso(), user_id),
    )
    updated = get_user(conn, user_id)
    assert updated is not None
    return updated


def update_user(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    name: str | None = None,
    avatar: str | None = None,
    avatar_color: str | None = None,
    bio: str | None = None,
    skills: list[str] | None = None,
    role: str | None = None,
    team_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
) -> dict[str, Any]:
    from ..db import json_dumps

    existing = get_user(conn, user_id)
    if not existing:
        raise AccountError("账号不存在", "user_not_found", 404)
    updates: dict[str, Any] = {}
    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise AccountError("用户名不能为空", "invalid_name")
        if len(cleaned) > 60:
            raise AccountError("用户名不能超过 60 个字符", "invalid_name")
        updates["name"] = cleaned
    if avatar is not None:
        updates["avatar"] = avatar
    if avatar_color is not None:
        updates["avatar_color"] = avatar_color
    if bio is not None:
        updates["bio"] = bio
    if skills is not None:
        ordered: list[str] = []
        for item in skills:
            if item and item not in ordered:
                ordered.append(item)
        updates["skills"] = json_dumps(ordered)
    if role is not None:
        if role not in USER_ROLES:
            raise AccountError("账号角色不合法", "invalid_role")
        updates["role"] = role
    if team_ids is not None:
        updates["team_ids"] = json_dumps(sorted(set(team_ids)))
    if group_ids is not None:
        updates["group_ids"] = json_dumps(sorted(set(group_ids)))
    if not updates:
        return existing
    updates["updated_at"] = now_iso()
    assignments = ", ".join(f"{column}=?" for column in updates)
    conn.execute(
        f"UPDATE users SET {assignments} WHERE id=?",
        (*updates.values(), user_id),
    )
    updated = get_user(conn, user_id)
    assert updated is not None
    return updated


def sync_members_from_user(conn: sqlite3.Connection, user: dict[str, Any]) -> None:
    """Mirror personal-profile fields onto every linked group member row."""
    members = conn.execute(
        "SELECT id FROM members WHERE lower(email)=? OR lower(external_id)=?",
        (str(user.get("email") or "").lower(), str(user.get("id") or "").lower()),
    ).fetchall()
    if not members:
        return
    conn.execute(
        "UPDATE members SET name=?, avatar_url=?, bio=?, skills=?, updated_at=? "
        "WHERE lower(email)=? OR lower(external_id)=?",
        (
            user.get("name") or "",
            user.get("avatar") or "",
            user.get("bio") or "",
            user.get("skills") or "[]",
            now_iso(),
            str(user.get("email") or "").lower(),
            str(user.get("id") or "").lower(),
        ),
    )


def sync_user_from_member(conn: sqlite3.Connection, member: dict[str, Any]) -> None:
    """Mirror a member's personal fields back onto the linked account, if any."""
    email = str(member.get("email") or "").strip().lower()
    external = str(member.get("external_id") or "").strip().lower()
    if not email and not external:
        return
    account = get_user_by_email(conn, email) if email else None
    if not account and external:
        account = get_user(conn, external)
    if not account:
        return
    updates: dict[str, Any] = {}
    if member.get("name"):
        updates["name"] = member["name"]
    if member.get("avatar_url") is not None:
        updates["avatar"] = member.get("avatar_url") or ""
    if member.get("avatar_color"):
        updates["avatar_color"] = member["avatar_color"]
    if member.get("bio") is not None:
        updates["bio"] = member.get("bio") or ""
    if member.get("skills") is not None:
        updates["skills"] = member.get("skills")
    if not updates:
        return
    updates["updated_at"] = now_iso()
    assignments = ", ".join(f"{column}=?" for column in updates)
    conn.execute(
        f"UPDATE users SET {assignments} WHERE id=?",
        (*updates.values(), account["id"]),
    )


def _hash_activation_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_activation_token(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    minutes: int,
    created_by: str = "",
) -> tuple[str, str]:
    """Issue a one-time activation token, invalidating older unused tokens."""
    conn.execute(
        "UPDATE user_activation_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL",
        (now_iso(), user_id),
    )
    token = secrets.token_urlsafe(32)
    expires_at = (
        datetime.now(timezone.utc).astimezone() + timedelta(minutes=minutes)
    ).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO user_activation_tokens (token_hash,user_id,expires_at,used_at,"
        "created_at,created_by) VALUES (?,?,?,?,?,?)",
        (_hash_activation_token(token), user_id, expires_at, None, now_iso(), created_by),
    )
    return token, expires_at


def find_activation_token(conn: sqlite3.Connection, token: str) -> dict[str, Any] | None:
    if not token:
        return None
    return row(
        conn,
        "SELECT * FROM user_activation_tokens WHERE token_hash=?",
        (_hash_activation_token(token),),
    )


def consume_activation_token(conn: sqlite3.Connection, token_hash: str) -> None:
    conn.execute(
        "UPDATE user_activation_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL",
        (now_iso(), token_hash),
    )


def account_role_scope(role: str) -> tuple[str | None, list[str], list[str]]:
    """Return the admin role plus default empty team/group scopes for a role."""
    if role == "super":
        return "super", [], []
    if role == "team_admin":
        return "team_admin", [], []
    if role == "group_admin":
        return "group_admin", [], []
    return None, [], []


def account_session_identity(user: dict[str, Any]) -> Any:
    """Build the signed-cookie identity for an e-mail account."""
    from ..auth import SessionIdentity

    return SessionIdentity(
        id=user["id"],
        name=user.get("name") or user["id"],
        email=user.get("email") or "",
        provider="email",
    )


def display_name_for(email: str) -> str:
    return email_local_part(email)


def create_code_id() -> str:
    return new_id("code")


def site_name() -> str:
    return settings_service.get().site.name
