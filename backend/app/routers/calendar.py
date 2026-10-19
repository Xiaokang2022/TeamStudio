"""Group calendar todos and reminder metadata routes.

Base path: ``/api/teams/{team_id}/groups/{group_id}``.

A signed-in member may create todos for themselves; admins may create/assign for anyone.
Creator, assigned member and in-scope admins may edit; the creator, assigned member and
admins may delete. Guests are read-only unless ``features.allowGuestTodoCreate`` is on.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from ..auth import CurrentUser, get_current_user
from ..config import settings_service
from ..db import db, json_dumps, json_loads, new_id, now_iso, row, rows
from ..http import fail, get_group, get_member, ok, parse_date, parse_month, parse_time, text
from ..permissions import (
    audit,
    can_create_todo,
    require_authenticated,
    require_read_access,
    require_todo_write,
)

router = APIRouter(prefix="/api/teams/{team_id}/groups/{group_id}", tags=["calendar"])

PRIORITIES = {"low", "normal", "high", "urgent"}
TODO_STATUSES = {"todo", "done"}
MAX_REMINDER_OFFSET = 60


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


def _flag(value: Any, field: str, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    raise fail(422, f"{field}必须是布尔值", "validation_error")


def _reminder_offsets(value: Any, default: list[int] | None = None) -> list[int]:
    """Validate reminder offsets: integer days 0-60, deduplicated, newest first."""
    if value is None:
        return list(default or [])
    if not isinstance(value, list):
        raise fail(422, "提醒提前天数必须是整数数组", "validation_error")
    offsets: set[int] = set()
    for item in value:
        if isinstance(item, bool):
            raise fail(422, "提醒提前天数必须是 0-60 的整数", "validation_error")
        try:
            offset = int(item)
        except (TypeError, ValueError) as exc:
            raise fail(422, "提醒提前天数必须是 0-60 的整数", "validation_error") from exc
        if offset < 0 or offset > MAX_REMINDER_OFFSET:
            raise fail(422, "提醒提前天数必须在 0-60 之间", "validation_error")
        offsets.add(offset)
    return sorted(offsets, reverse=True)


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


def _todo_payload(todo: dict[str, Any], reminders_sent: list[int] | None = None) -> dict[str, Any]:
    due_at: datetime | None = None
    try:
        due_at = datetime.fromisoformat(f"{todo['due_date']}T{todo.get('due_time') or '18:00'}:00")
    except (TypeError, ValueError):
        due_at = None
    overdue = bool(due_at and todo.get("status") != "done" and due_at < datetime.now())
    offsets = json_loads(todo.get("reminder_offsets_days"), [])
    if not isinstance(offsets, list):
        offsets = []
    return {
        "id": todo["id"],
        "groupId": todo.get("group_id", ""),
        "title": todo["title"],
        "description": todo.get("description", ""),
        "dueDate": todo["due_date"],
        "dueTime": todo.get("due_time", ""),
        "assigneeMemberId": todo.get("assignee_member_id"),
        "assigneeName": todo.get("assignee_name") or "",
        "assigneeEmail": todo.get("assignee_email") or "",
        "assigneeColor": todo.get("assignee_color") or "",
        "priority": todo.get("priority", "normal"),
        "status": todo.get("status", "todo"),
        "reminderOffsetsDays": sorted(
            {
                int(value)
                for value in offsets
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            },
            reverse=True,
        ),
        "emailEnabled": bool(todo.get("email_enabled")),
        "remindersSent": list(reminders_sent or []),
        "createdBy": todo.get("created_by", ""),
        "createdByName": "Admin" if todo.get("created_by") == "device-admin" else (todo.get("created_by") or ""),
        "createdAt": todo.get("created_at", ""),
        "updatedAt": todo.get("updated_at", ""),
        "completedAt": todo.get("completed_at"),
        "overdue": overdue,
    }


def _sent_offsets(conn, group_id: str, todo_id: str) -> list[int]:
    items = rows(
        conn,
        "SELECT DISTINCT offset_days FROM email_reminders_sent WHERE group_id=? AND todo_id=?",
        (group_id, todo_id),
    )
    return sorted({int(item["offset_days"]) for item in items}, reverse=True)


def _sent_offsets_for_group(conn, group_id: str) -> dict[str, list[int]]:
    result: dict[str, list[int]] = {}
    for item in rows(
        conn,
        "SELECT todo_id, offset_days FROM email_reminders_sent WHERE group_id=? "
        "GROUP BY todo_id, offset_days",
        (group_id,),
    ):
        result.setdefault(item["todo_id"], []).append(int(item["offset_days"]))
    for offsets in result.values():
        offsets.sort(reverse=True)
    return result


def _todo_row(conn, todo_id: str, group_id: str) -> dict[str, Any]:
    found = row(
        conn,
        "SELECT t.*, m.name AS assignee_name, m.email AS assignee_email, "
        "m.avatar_color AS assignee_color FROM todos t "
        "LEFT JOIN members m ON m.id=t.assignee_member_id "
        "WHERE t.id=? AND t.group_id=?",
        (todo_id, group_id),
    )
    if not found:
        raise fail(404, "待办不存在", "todo_not_found")
    return found


def _todo_detail(conn, todo_id: str, group_id: str) -> dict[str, Any]:
    return _todo_payload(_todo_row(conn, todo_id, group_id), _sent_offsets(conn, group_id, todo_id))


def _validate_assignee(
    conn,
    group_id: str,
    value: Any,
    *,
    user: CurrentUser,
    team_id: str,
) -> str | None:
    """Validate an assignee reference and the caller's right to assign that member."""
    member_id = _member_id(value)
    if member_id is None:
        return None
    get_member(conn, member_id, group_id)  # 404 when the member is not in this group
    is_admin = user.authenticated and user.can_edit_group(team_id, group_id)
    if not is_admin and user.linked_member_id != member_id:
        raise fail(403, "只能为自己创建或指派待办", "forbidden")
    return member_id


# --------------------------------------------------------------------------- routes


@router.get("/todos")
def list_todos(
    team_id: str,
    group_id: str,
    month: str | None = Query(default=None),
    user: CurrentUser = Depends(require_read_access),
):
    selected = parse_month(month)
    with db() as conn:
        get_group(conn, team_id, group_id)
        todo_rows = rows(
            conn,
            "SELECT t.*, m.name AS assignee_name, m.email AS assignee_email, "
            "m.avatar_color AS assignee_color FROM todos t "
            "LEFT JOIN members m ON m.id=t.assignee_member_id "
            "WHERE t.group_id=? AND t.due_date LIKE ? "
            "ORDER BY t.due_date, t.due_time, t.created_at",
            (group_id, f"{selected}-%"),
        )
        sent_map = _sent_offsets_for_group(conn, group_id)
    return ok(
        {
            "month": selected,
            "todos": [
                _todo_payload(todo, sent_map.get(todo["id"], [])) for todo in todo_rows
            ],
        }
    )


@router.post("/todos")
def create_todo(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    if not can_create_todo(user):
        raise fail(401, "访客不能创建待办，请先登录", "authentication_required")
    config = settings_service.get()
    with db() as conn:
        get_group(conn, team_id, group_id)

        is_admin = user.authenticated and user.can_edit_group(team_id, group_id)
        if user.authenticated and not is_admin:
            linked = user.linked_member_id
            if not linked or not row(
                conn,
                "SELECT 1 FROM members WHERE id=? AND group_id=?",
                (linked, group_id),
            ):
                raise fail(403, "只有该开发组成员可以为该开发组创建待办", "forbidden")

        title = text(payload.get("title"), "待办标题", 120, required=True)
        description = text(payload.get("description"), "待办说明", 2000)
        due_date = parse_date(payload.get("dueDate"), "截止日期")
        due_time = parse_time(payload.get("dueTime") or "18:00", "截止时间")
        if not config.calendar.allowPastDue and due_date < date.today().isoformat():
            raise fail(422, "当前配置不允许创建已过期的待办", "due_date_in_past")
        priority = _priority(payload.get("priority"))
        status = _todo_status(payload.get("status")) if payload.get("status") else "todo"
        reminder_offsets = _reminder_offsets(
            payload.get("reminderOffsetsDays"), config.calendar.defaultReminderOffsetsDays
        )
        email_enabled = _flag(payload.get("emailEnabled"), "邮件提醒", config.calendar.defaultEmailEnabled)

        assignee_id = _validate_assignee(
            conn,
            group_id,
            payload.get("assigneeMemberId"),
            user=user,
            team_id=team_id,
        )
        if assignee_id is None and user.linked_member_id:
            linked = row(
                conn,
                "SELECT id FROM members WHERE id=? AND group_id=?",
                (user.linked_member_id, group_id),
            )
            if linked:
                assignee_id = user.linked_member_id

        todo_id = new_id("todo")
        now = now_iso()
        conn.execute(
            "INSERT INTO todos (id,group_id,title,description,due_date,due_time,assignee_member_id,"
            "priority,status,reminder_offsets_days,email_enabled,created_by,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                todo_id,
                group_id,
                title,
                description,
                due_date,
                due_time,
                assignee_id,
                priority,
                status,
                json_dumps(reminder_offsets),
                1 if email_enabled else 0,
                user.id if user.authenticated else "guest",
                now,
                now,
            ),
        )
        audit(conn, user, "todo.create", "todo", todo_id, {"title": title, "assignee": assignee_id})
        todo = _todo_detail(conn, todo_id, group_id)
    return ok({"todo": todo})


@router.patch("/todos/{todo_id}")
def update_todo(
    team_id: str,
    group_id: str,
    todo_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    config = settings_service.get()
    with db() as conn:
        get_group(conn, team_id, group_id)
        todo = _todo_row(conn, todo_id, group_id)
        require_authenticated(user)
        require_todo_write(user, team_id, group_id, todo)
        is_admin = user.can_edit_group(team_id, group_id)

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
        if "reminderOffsetsDays" in payload:
            updates["reminder_offsets_days"] = json_dumps(
                _reminder_offsets(payload.get("reminderOffsetsDays"))
            )
        if "emailEnabled" in payload:
            updates["email_enabled"] = 1 if _flag(payload.get("emailEnabled"), "邮件提醒", True) else 0
        if "assigneeMemberId" in payload:
            raw_assignee = payload.get("assigneeMemberId")
            if raw_assignee is None or raw_assignee == "":
                updates["assignee_member_id"] = None
            else:
                member_id = _member_id(raw_assignee)
                if member_id is not None:
                    get_member(conn, member_id, group_id)
                    if not is_admin and user.linked_member_id != member_id:
                        raise fail(403, "只有管理员可以重新指派待办", "forbidden")
                    updates["assignee_member_id"] = member_id
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE todos SET {assignments} WHERE id=? AND group_id=?",
                (*updates.values(), todo_id, group_id),
            )
            audit(conn, user, "todo.update", "todo", todo_id, {"fields": sorted(payload)})
        todo = _todo_detail(conn, todo_id, group_id)
    return ok({"todo": todo})


@router.delete("/todos/{todo_id}")
def delete_todo(
    team_id: str,
    group_id: str,
    todo_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        todo = _todo_row(conn, todo_id, group_id)
        require_todo_write(user, team_id, group_id, todo)
        conn.execute("DELETE FROM email_reminders_sent WHERE todo_id=?", (todo_id,))
        conn.execute("DELETE FROM todos WHERE id=? AND group_id=?", (todo_id, group_id))
        audit(conn, user, "todo.delete", "todo", todo_id, {"title": todo["title"]})
    return ok({"deleted": True, "id": todo_id})
