"""Permission and audit helpers shared by the group-scoped feature routers.

Rules implemented here (see CONTRACT.md):
- GET routes are readable by authenticated users, and by guests while guest read is enabled.
- Every write requires an authenticated identity.
- Admin writes require the identity to be in scope for the target team/group.
- A member without an admin role may edit their linked member profile/works only when
  ``features.allowMemberSelfEdit`` is on, and may edit/delete their own or assigned todos.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import Depends

from .auth import CurrentUser, get_current_user
from .config import settings_service
from .db import log_audit
from .http import fail


def require_read_access(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Allow authenticated users and, when configured, guest readers."""
    if user.authenticated:
        return user
    config = settings_service.get()
    if config.auth.guestMode and config.auth.allowGuestRead:
        return user
    raise fail(401, "访客只读模式已关闭，请先登录", "authentication_required")


def require_authenticated(user: CurrentUser) -> CurrentUser:
    if user.authenticated:
        return user
    raise fail(401, "请先登录后再执行写操作", "authentication_required")


def require_admin(user: CurrentUser, team_id: str, group_id: str) -> CurrentUser:
    """Require an in-scope admin; raises 401 for guests and 403 for out-of-scope users."""
    require_authenticated(user)
    user.ensure_group(team_id, group_id)
    return user


def can_self_edit(user: CurrentUser, member_id: str | None) -> bool:
    if not member_id or not user.is_linked_member(member_id):
        return False
    return settings_service.get().features.allowMemberSelfEdit


def require_member_writer(
    user: CurrentUser, team_id: str, group_id: str, member_id: str
) -> CurrentUser:
    """Allow the linked member (self edit) or an in-scope admin."""
    require_authenticated(user)
    if can_self_edit(user, member_id):
        return user
    user.ensure_group(team_id, group_id)
    return user


def is_todo_creator(user: CurrentUser, todo: dict[str, Any]) -> bool:
    creator = str(todo.get("created_by") or "")
    return bool(creator) and creator == user.id


def is_todo_assignee(user: CurrentUser, todo: dict[str, Any]) -> bool:
    return user.is_linked_member(todo.get("assignee_member_id"))


def require_todo_write(
    user: CurrentUser, team_id: str, group_id: str, todo: dict[str, Any]
) -> CurrentUser:
    """Allow the todo creator, the assigned linked member, or an in-scope admin."""
    require_authenticated(user)
    if is_todo_creator(user, todo) or is_todo_assignee(user, todo):
        return user
    user.ensure_group(team_id, group_id)
    return user


def can_create_todo(user: CurrentUser) -> bool:
    """Guests may create todos only when explicitly enabled in settings."""
    if user.authenticated:
        return True
    return settings_service.get().features.allowGuestTodoCreate


def audit(
    conn: sqlite3.Connection,
    user: CurrentUser,
    action: str,
    entity: str,
    entity_id: str = "",
    detail: Any = None,
) -> None:
    """Write an audit trail entry when ``features.auditLog`` is enabled."""
    if not settings_service.get().features.auditLog:
        return
    log_audit(conn, user.name or user.id or "system", action, entity, entity_id, detail)
