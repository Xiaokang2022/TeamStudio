"""Team calendar todos routes.

Base path: ``/api/teams/{team_id}`` (round 8: todos are isolated by team only — the
development group and the ``scope`` query parameter are gone).

A signed-in member may create todos for themselves; team administrators may
create/assign for anyone. Creator, assigned member and team administrators may edit; the
creator, assigned member and administrators may delete. Guests are read-only unless
``features.allowGuestTodoCreate`` is on. Calendar e-mail reminders were removed in round 5
(see ROUND5_CONTRACT §5).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from ..auth import CurrentUser, get_current_user
from ..config import settings_service
from ..db import db, new_id, now_iso, row, rows
from ..http import fail, get_member, get_team, ok, parse_date, parse_month, parse_time, text
from ..permissions import (
    audit,
    can_create_todo,
    require_authenticated,
    require_read_module,
    require_todo_write,
)
from ..services.member_identity import first_member_in_team
from ..services.tasks_service import member_avatar_sql

router = APIRouter(prefix="/api/teams/{team_id}", tags=["calendar"])

PRIORITIES = {"low", "normal", "high", "urgent"}
TODO_STATUSES = {"todo", "done"}

_TODO_SELECT = (
    "SELECT t.*, m.name AS assignee_name, m.email AS assignee_email, "
    "m.avatar_color AS assignee_color, "
    f"{member_avatar_sql('m')} AS assignee_avatar, "
    "tm.name AS team_name FROM todos t "
    "LEFT JOIN members m ON m.id=t.assignee_member_id "
    "JOIN teams tm ON tm.id=t.team_id "
)


# --------------------------------------------------------------------------- helpers


def _priority(value: Any) -> str:
    if value is None or value == "":
        return "normal"
    if value not in PRIORITIES:
        raise fail(422, "优先级必须是 low/normal/high/urgent", "validation_error")
    return value


def _todo_status(value: Any) -> str:
    if value not in TODO_STATUSES:
        raise fail(422, "待办状态必须是 todo 或 done", "validation_error")
    return value


def _member_id(value: Any, field: str = "指派成员") -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise fail(422, f"{field} ID 必须是字符串", "validation_error")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > 80:
        raise fail(422, f"{field} ID 过长", "validation_error")
    return cleaned


def _creator_name(user: CurrentUser) -> str:
    if not user.authenticated:
        return "访客"
    return user.name or user.id


def _is_team_admin(user: CurrentUser, team_id: str) -> bool:
    return bool(user.authenticated and user.can_edit_team(team_id))


def _todo_payload(todo: dict[str, Any]) -> dict[str, Any]:
    due_at: datetime | None = None
    try:
        due_at = datetime.fromisoformat(
            f"{todo['due_date']}T{todo.get('due_time') or '18:00'}:00"
        )
    except (TypeError, ValueError):
        due_at = None
    overdue = bool(
        due_at and todo.get("status") != "done" and due_at < datetime.now()
    )
    return {
        "id": todo["id"],
        "teamId": todo.get("team_id", ""),
        "teamName": todo.get("team_name") or "",
        "title": todo["title"],
        "description": todo.get("description", ""),
        "dueDate": todo["due_date"],
        "dueTime": todo.get("due_time", ""),
        "assigneeMemberId": todo.get("assignee_member_id"),
        "assigneeName": todo.get("assignee_name") or "",
        "assigneeEmail": todo.get("assignee_email") or "",
        "assigneeAvatar": todo.get("assignee_avatar") or "",
        "assigneeColor": todo.get("assignee_color") or "",
        "priority": todo.get("priority", "normal"),
        "status": todo.get("status", "todo"),
        "createdBy": todo.get("created_by", ""),
        "createdByName": "Admin"
        if todo.get("created_by") == "device-admin"
        else (todo.get("created_by") or ""),
        "createdAt": todo.get("created_at", ""),
        "updatedAt": todo.get("updated_at", ""),
        "completedAt": todo.get("completed_at"),
        "overdue": overdue,
    }


def _todo_row(conn, todo_id: str, team_id: str) -> dict[str, Any]:
    found = row(conn, _TODO_SELECT + "WHERE t.id=? AND t.team_id=?", (todo_id, team_id))
    if not found:
        raise fail(404, "待办不存在", "todo_not_found")
    return found


def _todo_detail(conn, todo_id: str, team_id: str) -> dict[str, Any]:
    return _todo_payload(_todo_row(conn, todo_id, team_id))


def _validate_assignee(
    conn,
    team_id: str,
    value: Any,
    *,
    user: CurrentUser,
) -> str | None:
    """Validate an assignee reference and the caller's right to assign that member."""
    member_id = _member_id(value)
    if member_id is None:
        return None
    get_member(conn, team_id, member_id)  # 404 when the member is not in this team
    is_admin = _is_team_admin(user, team_id)
    if not is_admin and not user.is_linked_member(member_id):
        raise fail(403, "只能为自己创建或指派待办", "forbidden")
    return member_id


# --------------------------------------------------------------------------- routes


@router.get("/todos")
def list_todos(
    team_id: str,
    month: str | None = Query(default=None),
    user: CurrentUser = Depends(require_read_module("calendar")),
):
    selected = parse_month(month)
    with db() as conn:
        get_team(conn, team_id)
        todo_rows = rows(
            conn,
            _TODO_SELECT + "WHERE t.team_id=? AND t.due_date LIKE ? "
            "ORDER BY t.due_date, t.due_time, t.created_at",
            (team_id, f"{selected}-%"),
        )
    return ok(
        {
            "month": selected,
            "todos": [_todo_payload(todo) for todo in todo_rows],
        }
    )


@router.post("/todos")
def create_todo(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    if not can_create_todo(user):
        raise fail(401, "访客不能创建待办，请先登录", "authentication_required")
    config = settings_service.get()
    with db() as conn:
        get_team(conn, team_id)

        is_admin = _is_team_admin(user, team_id)
        if user.authenticated and not is_admin:
            linked = first_member_in_team(
                conn, team_id, user.linked_member_id_list()
            )
            if not linked:
                raise fail(403, "只有该团队成员可以为该团队创建待办", "forbidden")

        title = text(payload.get("title"), "待办标题", 120, required=True)
        description = text(payload.get("description"), "待办说明", 2000)
        due_date = parse_date(payload.get("dueDate"), "截止日期")
        due_time = parse_time(payload.get("dueTime") or "18:00", "截止时间")
        if not config.calendar.allowPastDue and due_date < date.today().isoformat():
            raise fail(422, "当前配置不允许创建已过期的待办", "due_date_in_past")
        priority = _priority(payload.get("priority"))
        status = _todo_status(payload.get("status")) if payload.get("status") else "todo"

        assignee_id = _validate_assignee(
            conn,
            team_id,
            payload.get("assigneeMemberId"),
            user=user,
        )
        if assignee_id is None:
            linked = first_member_in_team(
                conn, team_id, user.linked_member_id_list()
            )
            if linked:
                assignee_id = linked["id"]

        todo_id = new_id("todo")
        now = now_iso()
        conn.execute(
            "INSERT INTO todos (id,team_id,title,description,due_date,due_time,"
            "assignee_member_id,priority,status,created_by,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                todo_id,
                team_id,
                title,
                description,
                due_date,
                due_time,
                assignee_id,
                priority,
                status,
                user.id if user.authenticated else "guest",
                now,
                now,
            ),
        )
        audit(
            conn,
            user,
            "todo.create",
            "todo",
            todo_id,
            {"title": title, "assignee": assignee_id},
        )
        todo = _todo_detail(conn, todo_id, team_id)
    return ok({"todo": todo})


@router.patch("/todos/{todo_id}")
def update_todo(
    team_id: str,
    todo_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    config = settings_service.get()
    with db() as conn:
        get_team(conn, team_id)
        todo = _todo_row(conn, todo_id, team_id)
        require_authenticated(user)
        require_todo_write(user, team_id, todo)
        is_admin = _is_team_admin(user, team_id)

        updates: dict[str, Any] = {}
        if "title" in payload:
            updates["title"] = text(payload.get("title"), "待办标题", 120, required=True)
        if "description" in payload:
            updates["description"] = text(payload.get("description"), "待办说明", 2000)
        if "dueDate" in payload:
            due_date = parse_date(payload.get("dueDate"), "截止日期")
            if not config.calendar.allowPastDue and due_date < date.today().isoformat():
                raise fail(422, "当前配置不允许把待办改到过去", "due_date_in_past")
            updates["due_date"] = due_date
        if "dueTime" in payload:
            updates["due_time"] = parse_time(payload.get("dueTime"), "截止时间")
        if "priority" in payload:
            updates["priority"] = _priority(payload.get("priority"))
        if "status" in payload:
            status = _todo_status(payload.get("status"))
            updates["status"] = status
            updates["completed_at"] = now_iso() if status == "done" else None
        if "assigneeMemberId" in payload:
            raw_assignee = payload.get("assigneeMemberId")
            if raw_assignee is None or raw_assignee == "":
                updates["assignee_member_id"] = None
            else:
                member_id = _member_id(raw_assignee)
                if member_id is not None:
                    get_member(conn, team_id, member_id)
                    if not is_admin and not user.is_linked_member(member_id):
                        raise fail(403, "只有管理员可以重新指派待办", "forbidden")
                    updates["assignee_member_id"] = member_id
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE todos SET {assignments} WHERE id=? AND team_id=?",
                (*updates.values(), todo_id, team_id),
            )
            audit(conn, user, "todo.update", "todo", todo_id, {"fields": sorted(payload)})
        todo = _todo_detail(conn, todo_id, team_id)
    return ok({"todo": todo})


@router.delete("/todos/{todo_id}")
def delete_todo(
    team_id: str,
    todo_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_team(conn, team_id)
        todo = _todo_row(conn, todo_id, team_id)
        require_todo_write(user, team_id, todo)
        conn.execute("DELETE FROM todos WHERE id=? AND team_id=?", (todo_id, team_id))
        audit(conn, user, "todo.delete", "todo", todo_id, {"title": todo["title"]})
    return ok({"deleted": True, "id": todo_id})
