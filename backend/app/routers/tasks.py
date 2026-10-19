"""Member task ledger routes: CRUD plus workload quantification payloads.

Base path: ``/api/teams/{team_id}/groups/{group_id}``.

Reads follow the shared guest-read gate. Writes require an authenticated identity: in-scope
admins may manage every member's tasks, while a plain SSO-linked member may only manage tasks
belonging to their linked member. Guests are always denied for writes.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends

from ..auth import CurrentUser, get_current_user
from ..db import db, new_id, now_iso
from ..http import fail, get_group, get_member, ok, parse_date, text
from ..permissions import audit, require_authenticated, require_read_access
from ..services.tasks_service import (
    DIFFICULTIES,
    HEALTH_STATUSES,
    PRIORITIES,
    PROGRESS_STATUSES,
    build_tasks_payload,
    get_task_row,
    task_payload,
)

router = APIRouter(prefix="/api/teams/{team_id}/groups/{group_id}", tags=["tasks"])


# --------------------------------------------------------------------------- validation


def _progress_status(value: Any) -> str:
    if value is None or value == "":
        raise fail(422, "任务状态不能为空", "validation_error")
    if not isinstance(value, str) or value not in PROGRESS_STATUSES:
        raise fail(
            422,
            "任务状态必须是 pending/in_progress/completed",
            "validation_error",
        )
    return value


def _health_status(value: Any) -> str:
    if value is None or value == "":
        raise fail(422, "健康状态不能为空", "validation_error")
    if not isinstance(value, str) or value not in HEALTH_STATUSES:
        raise fail(422, "健康状态必须是 normal/delayed/blocked", "validation_error")
    return value


def _priority(value: Any) -> str:
    if value is None or value == "":
        raise fail(422, "优先级不能为空", "validation_error")
    if not isinstance(value, str) or value not in PRIORITIES:
        raise fail(422, "优先级必须是 low/normal/high/urgent", "validation_error")
    return value


def _difficulty(value: Any) -> str:
    if value is None or value == "":
        raise fail(422, "难度不能为空", "validation_error")
    if not isinstance(value, str) or value not in DIFFICULTIES:
        raise fail(422, "难度必须是 easy/medium/hard", "validation_error")
    return value


def _expected_date(value: Any) -> str:
    """Expected date accepts an empty value (no expectation) or YYYY-MM-DD."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise fail(422, "预期完成日期格式应为 YYYY-MM-DD", "invalid_date")
    cleaned = value.strip()
    if not cleaned:
        return ""
    return parse_date(cleaned, "预期完成日期")


# --------------------------------------------------------------------------- permissions


def _is_group_admin(user: CurrentUser, team_id: str, group_id: str) -> bool:
    return user.authenticated and user.can_edit_group(team_id, group_id)


def _require_task_manager(
    user: CurrentUser,
    team_id: str,
    group_id: str,
    member_id: str,
    *,
    task: dict[str, Any] | None = None,
) -> bool:
    """Allow in-scope admins and the linked member; return whether the caller is an admin."""
    require_authenticated(user)
    if _is_group_admin(user, team_id, group_id):
        return True
    target_member = task["member_id"] if task is not None else member_id
    if not user.linked_member_id or user.linked_member_id != target_member:
        raise fail(403, "普通成员只能管理自己的任务", "forbidden")
    return False


def _resolve_created_member(
    user: CurrentUser, team_id: str, group_id: str, raw_member_id: Any
) -> tuple[str, bool]:
    """Resolve the task owner for POST, defaulting to the caller's linked member."""
    is_admin = _is_group_admin(user, team_id, group_id)
    raw = text(raw_member_id, "成员 ID", 80)
    if not raw:
        if is_admin:
            raise fail(422, "请指定任务所属成员", "validation_error")
        if not user.linked_member_id:
            raise fail(403, "只有开发组成员可以创建自己的任务", "forbidden")
        return user.linked_member_id, is_admin
    if not is_admin and user.linked_member_id != raw:
        raise fail(403, "普通成员只能创建自己的任务", "forbidden")
    return raw, is_admin


# --------------------------------------------------------------------------- routes


@router.get("/tasks")
def list_tasks(
    team_id: str,
    group_id: str,
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        payload = build_tasks_payload(conn, group_id)
    return ok(payload)


@router.post("/tasks")
def create_task(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_group(conn, team_id, group_id)
        member_id, _ = _resolve_created_member(
            user, team_id, group_id, payload.get("memberId")
        )
        get_member(conn, member_id, group_id)

        title = text(payload.get("title"), "任务标题", 120, required=True)
        description = text(payload.get("description"), "任务说明", 2000)
        progress_status = (
            _progress_status(payload.get("progressStatus"))
            if payload.get("progressStatus") not in (None, "")
            else "pending"
        )
        health_status = (
            _health_status(payload.get("healthStatus"))
            if payload.get("healthStatus") not in (None, "")
            else "normal"
        )
        priority = (
            _priority(payload.get("priority"))
            if payload.get("priority") not in (None, "")
            else "normal"
        )
        difficulty = (
            _difficulty(payload.get("difficulty"))
            if payload.get("difficulty") not in (None, "")
            else "medium"
        )
        expected_date = _expected_date(payload.get("expectedDate"))
        now = now_iso()
        task_id = new_id("task")
        conn.execute(
            "INSERT INTO member_tasks (id,group_id,member_id,title,description,"
            "progress_status,health_status,priority,difficulty,expected_date,created_by,"
            "created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id,
                group_id,
                member_id,
                title,
                description,
                progress_status,
                health_status,
                priority,
                difficulty,
                expected_date,
                user.name or user.id,
                now,
                now,
                now if progress_status == "completed" else None,
            ),
        )
        audit(
            conn,
            user,
            "task.create",
            "task",
            task_id,
            {
                "memberId": member_id,
                "title": title,
                "progressStatus": progress_status,
                "priority": priority,
                "difficulty": difficulty,
            },
        )
        task = get_task_row(conn, task_id, group_id)
    return ok({"task": task_payload(task or {})})


@router.patch("/tasks/{task_id}")
def update_task(
    team_id: str,
    group_id: str,
    task_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_group(conn, team_id, group_id)
        task = get_task_row(conn, task_id, group_id)
        if not task:
            raise fail(404, "任务不存在", "task_not_found")
        is_admin = _require_task_manager(
            user, team_id, group_id, task["member_id"], task=task
        )

        updates: dict[str, Any] = {}
        if "memberId" in payload:
            raw_member = text(payload.get("memberId"), "成员 ID", 80)
            if not raw_member:
                raise fail(422, "成员 ID 不能为空", "validation_error")
            if not is_admin and user.linked_member_id != raw_member:
                raise fail(403, "普通成员只能管理自己的任务", "forbidden")
            get_member(conn, raw_member, group_id)
            updates["member_id"] = raw_member
        if "title" in payload:
            updates["title"] = text(payload.get("title"), "任务标题", 120, required=True)
        if "description" in payload:
            updates["description"] = text(payload.get("description"), "任务说明", 2000)
        if "progressStatus" in payload:
            status = _progress_status(payload.get("progressStatus"))
            updates["progress_status"] = status
            previous = task.get("progress_status")
            if status == "completed" and previous != "completed":
                updates["completed_at"] = now_iso()
            elif status != "completed":
                updates["completed_at"] = None
        if "healthStatus" in payload:
            updates["health_status"] = _health_status(payload.get("healthStatus"))
        if "priority" in payload:
            updates["priority"] = _priority(payload.get("priority"))
        if "difficulty" in payload:
            updates["difficulty"] = _difficulty(payload.get("difficulty"))
        if "expectedDate" in payload:
            updates["expected_date"] = _expected_date(payload.get("expectedDate"))
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE member_tasks SET {assignments} WHERE id=? AND group_id=?",
                (*updates.values(), task_id, group_id),
            )
            audit(
                conn,
                user,
                "task.update",
                "task",
                task_id,
                {"fields": sorted(payload)},
            )
        task = get_task_row(conn, task_id, group_id)
    return ok({"task": task_payload(task or {})})


@router.delete("/tasks/{task_id}")
def delete_task(
    team_id: str,
    group_id: str,
    task_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_group(conn, team_id, group_id)
        task = get_task_row(conn, task_id, group_id)
        if not task:
            raise fail(404, "任务不存在", "task_not_found")
        _require_task_manager(user, team_id, group_id, task["member_id"], task=task)
        conn.execute(
            "DELETE FROM member_tasks WHERE id=? AND group_id=?", (task_id, group_id)
        )
        audit(
            conn,
            user,
            "task.delete",
            "task",
            task_id,
            {"memberId": task["member_id"], "title": task.get("title", "")},
        )
    return ok({"deleted": True, "id": task_id})
