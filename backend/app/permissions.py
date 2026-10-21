"""Permission and audit helpers shared by the team-scoped feature routers.

Round 8 rules (see ``docs/ROUND8_CONTRACT.md`` §2.3):

- reads go through :func:`require_read_module`, which lets guests in only while the module
  is enabled for guests (``settings.modules[module]`` + ``settings.guestModules[module]``);
- every write requires an authenticated identity;
- team administrators (``CurrentUser.team_ids`` / ``super``) may restructure their team;
- a linked member may edit their own member profile/works when
  ``features.allowMemberSelfEdit`` is on, and may edit/delete their own or assigned todos;
- guests may create todos only when ``features.allowGuestTodoCreate`` is on.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Callable

from fastapi import Depends

from .auth import CurrentUser, get_current_user
from .config import settings_service
from .db import log_audit
from .http import fail

# Module names accepted by :func:`require_read_module` (contract §2.3).
READ_MODULES: tuple[str, ...] = (
    "overview",
    "tasks",
    "insights",
    "calendar",
    "redblack",
    "announcements",
    "matrix",
    "links",
    "settings",
)


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


def require_team_admin(user: CurrentUser, team_id: str) -> CurrentUser:
    """Require an in-scope team administrator; 401 for guests, 403 for outsiders."""
    require_authenticated(user)
    user.ensure_team(team_id)
    return user


def can_self_edit(user: CurrentUser, member_id: str | None) -> bool:
    if not member_id or not user.is_linked_member(member_id):
        return False
    return settings_service.get().features.allowMemberSelfEdit


def require_member_writer(user: CurrentUser, team_id: str, member_id: str) -> CurrentUser:
    """Allow the linked member (self edit) or a team administrator."""
    require_authenticated(user)
    if can_self_edit(user, member_id):
        return user
    user.ensure_team(team_id)
    return user


def is_todo_creator(user: CurrentUser, todo: dict[str, Any]) -> bool:
    creator = str(todo.get("created_by") or "")
    return bool(creator) and creator == user.id


def is_todo_assignee(user: CurrentUser, todo: dict[str, Any]) -> bool:
    return user.is_linked_member(todo.get("assignee_member_id"))


def require_todo_write(user: CurrentUser, team_id: str, todo: dict[str, Any]) -> CurrentUser:
    """Allow the todo creator, the assigned linked member, or a team administrator."""
    require_authenticated(user)
    if is_todo_creator(user, todo) or is_todo_assignee(user, todo):
        return user
    user.ensure_team(team_id)
    return user


def can_create_todo(user: CurrentUser) -> bool:
    """Guests may create todos only when explicitly enabled in settings."""
    if user.authenticated:
        return True
    return settings_service.get().features.allowGuestTodoCreate


def _module_enabled_for_guests(module: str) -> bool:
    config = settings_service.get()
    if not bool(getattr(config.modules, module, False)):
        return False
    return bool(getattr(config.guestModules, module, False))


def require_read_module(module: str) -> Callable[..., CurrentUser]:
    """Dependency factory: read access plus the guest module allow-list.

    Usage: ``Depends(require_read_module("tasks"))``. Guests are rejected with
    ``403 guest_module_disabled`` when the administrator disabled that module for guests
    or the module itself is switched off.
    """

    def dependency(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        require_read_access(user)
        if not user.authenticated and not _module_enabled_for_guests(module):
            raise fail(403, "该模块未对访客开放", "guest_module_disabled")
        return user

    dependency.__name__ = f"require_read_module_{module}"
    return dependency


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
