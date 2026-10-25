"""Member task ledger routes: CRUD, workload payloads and the shared task tag library.

Base path: ``/api/teams/{team_id}`` (round 8: data is isolated by team only — there are no
development groups and no browsing ``scope`` query parameter any more).

Reads use the ``tasks`` module gate (``Depends(require_read_module("tasks"))``), so guests
see them only while the module is enabled for guests. Writes require an authenticated
identity: team administrators (``user.can_edit_team(team_id)``) may manage every member's
tasks, while a plain linked member may only manage tasks belonging to their own archive.
Guests are always denied for writes. Tasks carry a per-team tag library that any signed-in
user may manage (default tags are seeded lazily on first access).
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends

from ..auth import CurrentUser, get_current_user
from ..db import db, json_dumps, json_loads, new_id, now_iso, row, rows
from ..http import fail, get_member, get_team, ok, parse_date, text
from ..permissions import audit, require_authenticated, require_read_module
from ..services.groups_service import get_group
from ..services.member_identity import first_member_in_team
from ..services.tasks_service import (
    DIFFICULTIES,
    HEALTH_STATUSES,
    PRIORITIES,
    PROGRESS_STATUSES,
    build_tasks_payload,
    get_task_row,
    in_clause,
    load_tag_map,
    task_payload,
)

router = APIRouter(prefix="/api/teams/{team_id}", tags=["tasks"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_TAGS_PER_TASK = 8
DEFAULT_TAG_NAMES = ("前端", "后端", "体验", "数据", "协作")
DEFAULT_TAG_COLORS = ("#0a59f7", "#1d7a4d", "#9a6210", "#b3261e", "#7c3aed")


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
        raise fail(422, "优先级必须是 low/normal/high", "validation_error")
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


def _tag_ids(conn: sqlite3.Connection, team_id: str, value: Any) -> list[str]:
    """Validate a task's tag ids: strings, max 8, unique, owned by the task's team."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise fail(422, "标签必须是字符串数组", "validation_error")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise fail(422, "标签必须是字符串数组", "validation_error")
        cleaned = item.strip()
        if not cleaned:
            continue
        if cleaned not in result:
            result.append(cleaned)
    if len(result) > MAX_TAGS_PER_TASK:
        raise fail(422, f"每个任务最多选择 {MAX_TAGS_PER_TASK} 个标签", "validation_error")
    if result:
        found = rows(
            conn,
            "SELECT id FROM task_tags WHERE team_id=? "
            f"AND id IN ({in_clause(result)})",
            (team_id, *result),
        )
        existing = {item["id"] for item in found}
        if any(tag_id not in existing for tag_id in result):
            raise fail(422, "标签不存在或不属于该团队", "invalid_tag")
    return result


def _tag_color(value: Any, fallback: str = "#5865f2") -> str:
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not HEX_PATTERN.fullmatch(value):
        raise fail(422, "标签颜色必须是 #RRGGBB 格式", "validation_error")
    return value.lower()


def _group_id(conn: sqlite3.Connection, team_id: str, value: Any) -> str:
    """Validate a task group reference: empty string means "ungrouped"."""
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        raise fail(400, "任务分组不存在", "invalid_group")
    cleaned = value.strip()
    if not cleaned:
        return ""
    if get_group(conn, team_id, cleaned, "task") is None:
        raise fail(400, "任务分组不存在", "invalid_group")
    return cleaned


# --------------------------------------------------------------------------- permissions


def _is_team_admin(user: CurrentUser, team_id: str) -> bool:
    return bool(user.authenticated and user.can_edit_team(team_id))


def _require_task_manager(
    user: CurrentUser,
    team_id: str,
    member_id: str,
    *,
    task: dict[str, Any] | None = None,
) -> bool:
    """Allow team admins and the linked member; return whether the caller is an admin."""
    require_authenticated(user)
    if _is_team_admin(user, team_id):
        return True
    target_member = task["member_id"] if task is not None else member_id
    if not user.is_linked_member(target_member):
        raise fail(403, "普通成员只能管理自己的任务", "forbidden")
    return False


def _resolve_created_member(
    conn: sqlite3.Connection,
    user: CurrentUser,
    team_id: str,
    raw_member_id: Any,
) -> tuple[str, bool]:
    """Resolve the task owner for POST, defaulting to the caller's archive in this team."""
    is_admin = _is_team_admin(user, team_id)
    raw = text(raw_member_id, "成员 ID", 80)
    if not raw:
        if is_admin:
            raise fail(422, "请指定任务所属成员", "validation_error")
        linked = first_member_in_team(conn, team_id, user.linked_member_id_list())
        if not linked:
            raise fail(403, "只有团队成员可以创建自己的任务", "forbidden")
        return linked["id"], is_admin
    if not is_admin and not user.is_linked_member(raw):
        raise fail(403, "普通成员只能创建自己的任务", "forbidden")
    return raw, is_admin


# --------------------------------------------------------------------------- task routes


@router.get("/tasks")
def list_tasks(
    team_id: str,
    user: CurrentUser = Depends(require_read_module("tasks")),
):
    with db() as conn:
        get_team(conn, team_id)
        payload = build_tasks_payload(conn, team_id)
    return ok(payload)


@router.post("/tasks")
def create_task(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_team(conn, team_id)
        member_id, _ = _resolve_created_member(
            conn, user, team_id, payload.get("memberId")
        )
        get_member(conn, team_id, member_id)

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
        tag_ids = _tag_ids(conn, team_id, payload.get("tagIds"))
        group_id = _group_id(conn, team_id, payload.get("groupId"))
        now = now_iso()
        task_id = new_id("task")
        conn.execute(
            "INSERT INTO member_tasks (id,team_id,member_id,title,description,"
            "progress_status,health_status,priority,difficulty,expected_date,"
            "group_id,tags,created_by,created_at,updated_at,completed_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id,
                team_id,
                member_id,
                title,
                description,
                progress_status,
                health_status,
                priority,
                difficulty,
                expected_date,
                group_id,
                json_dumps(tag_ids),
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
                "tagIds": tag_ids,
                "groupId": group_id,
            },
        )
        task = get_task_row(conn, task_id, team_id)
        tag_map = load_tag_map(conn, team_id)
        result = task_payload(task or {}, tag_map=tag_map)
    return ok({"task": result})


@router.patch("/tasks/{task_id}")
def update_task(
    team_id: str,
    task_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_team(conn, team_id)
        task = get_task_row(conn, task_id, team_id)
        if not task:
            raise fail(404, "任务不存在", "task_not_found")
        is_admin = _require_task_manager(
            user, team_id, task["member_id"], task=task
        )

        updates: dict[str, Any] = {}
        if "memberId" in payload:
            raw_member = text(payload.get("memberId"), "成员 ID", 80)
            if not raw_member:
                raise fail(422, "成员 ID 不能为空", "validation_error")
            if not is_admin and not user.is_linked_member(raw_member):
                raise fail(403, "普通成员只能管理自己的任务", "forbidden")
            get_member(conn, team_id, raw_member)
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
        if "tagIds" in payload:
            updates["tags"] = json_dumps(_tag_ids(conn, team_id, payload.get("tagIds")))
        if "groupId" in payload:
            updates["group_id"] = _group_id(conn, team_id, payload.get("groupId"))
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE member_tasks SET {assignments} WHERE id=? AND team_id=?",
                (*updates.values(), task_id, team_id),
            )
            audit(
                conn,
                user,
                "task.update",
                "task",
                task_id,
                {"fields": sorted(payload)},
            )
        task = get_task_row(conn, task_id, team_id)
        tag_map = load_tag_map(conn, team_id)
        result = task_payload(task or {}, tag_map=tag_map)
    return ok({"task": result})


@router.delete("/tasks/{task_id}")
def delete_task(
    team_id: str,
    task_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_team(conn, team_id)
        task = get_task_row(conn, task_id, team_id)
        if not task:
            raise fail(404, "任务不存在", "task_not_found")
        _require_task_manager(user, team_id, task["member_id"], task=task)
        conn.execute(
            "DELETE FROM member_tasks WHERE id=? AND team_id=?", (task_id, team_id)
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


# --------------------------------------------------------------------------- tag library


def _ensure_default_tags(conn: sqlite3.Connection, team_id: str) -> None:
    """Lazily seed the five default tags for a team whose library is still empty."""
    count = int(
        row(
            conn,
            "SELECT COUNT(*) AS count FROM task_tags WHERE team_id=?",
            (team_id,),
        )["count"]
    )
    if count:
        return
    now = now_iso()
    for name, color in zip(DEFAULT_TAG_NAMES, DEFAULT_TAG_COLORS):
        conn.execute(
            "INSERT INTO task_tags (id,team_id,name,color,created_by,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (new_id("tag"), team_id, name, color, "system", now, now),
        )


def _tag_usage(conn: sqlite3.Connection, team_id: str) -> dict[str, int]:
    """Count tasks of the team referencing each tag id."""
    usage: dict[str, int] = {}
    for item in rows(
        conn,
        "SELECT tags FROM member_tasks WHERE team_id=?",
        (team_id,),
    ):
        parsed = json_loads(item.get("tags"), [])
        if not isinstance(parsed, list):
            continue
        for tag_id in {value for value in parsed if isinstance(value, str)}:
            usage[tag_id] = usage.get(tag_id, 0) + 1
    return usage


def _tag_payload(tag: dict[str, Any], usage: int = 0) -> dict[str, Any]:
    return {
        "id": tag["id"],
        "teamId": tag.get("team_id", ""),
        "name": tag.get("name", ""),
        "color": tag.get("color", "#5865f2"),
        "usage": int(usage),
        "createdBy": tag.get("created_by", ""),
        "createdAt": tag.get("created_at", ""),
        "updatedAt": tag.get("updated_at", ""),
    }


def _get_tag(conn: sqlite3.Connection, tag_id: str, team_id: str) -> dict[str, Any]:
    found = row(
        conn,
        "SELECT * FROM task_tags WHERE id=? AND team_id=?",
        (tag_id, team_id),
    )
    if not found:
        raise fail(404, "标签不存在", "tag_not_found")
    return found


def _tag_name(conn: sqlite3.Connection, team_id: str, value: Any) -> str:
    name = text(value, "标签名称", 20, required=True)
    existing = row(
        conn,
        "SELECT id FROM task_tags WHERE team_id=? AND name=? LIMIT 1",
        (team_id, name),
    )
    if existing:
        raise fail(409, "标签名称已存在", "tag_exists")
    return name


def _tag_detail(conn: sqlite3.Connection, tag: dict[str, Any]) -> dict[str, Any]:
    usage = _tag_usage(conn, tag["team_id"]).get(tag["id"], 0)
    return _tag_payload(tag, usage)


@router.get("/task-tags")
def list_task_tags(
    team_id: str,
    user: CurrentUser = Depends(require_read_module("tasks")),
):
    with db() as conn:
        get_team(conn, team_id)
        _ensure_default_tags(conn, team_id)
        usage = _tag_usage(conn, team_id)
        tags = rows(
            conn,
            "SELECT * FROM task_tags WHERE team_id=? ORDER BY name",
            (team_id,),
        )
    return ok({"tags": [_tag_payload(tag, usage.get(tag["id"], 0)) for tag in tags]})


@router.post("/task-tags")
def create_task_tag(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_team(conn, team_id)
        name = _tag_name(conn, team_id, payload.get("name"))
        color = _tag_color(payload.get("color"))
        tag_id = new_id("tag")
        now = now_iso()
        conn.execute(
            "INSERT INTO task_tags (id,team_id,name,color,created_by,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (tag_id, team_id, name, color, user.name or user.id, now, now),
        )
        audit(conn, user, "task_tag.create", "task_tag", tag_id, {"name": name})
        tag = _get_tag(conn, tag_id, team_id)
        result = _tag_detail(conn, tag)
    return ok({"tag": result})


@router.patch("/task-tags/{tag_id}")
def update_task_tag(
    team_id: str,
    tag_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_team(conn, team_id)
        _get_tag(conn, tag_id, team_id)
        updates: dict[str, Any] = {}
        if "name" in payload:
            name = text(payload.get("name"), "标签名称", 20, required=True)
            duplicate = row(
                conn,
                "SELECT id FROM task_tags WHERE team_id=? AND name=? AND id<>? LIMIT 1",
                (team_id, name, tag_id),
            )
            if duplicate:
                raise fail(409, "标签名称已存在", "tag_exists")
            updates["name"] = name
        if "color" in payload:
            updates["color"] = _tag_color(payload.get("color"))
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE task_tags SET {assignments} WHERE id=? AND team_id=?",
                (*updates.values(), tag_id, team_id),
            )
            audit(
                conn,
                user,
                "task_tag.update",
                "task_tag",
                tag_id,
                {"fields": sorted(payload)},
            )
        tag = _get_tag(conn, tag_id, team_id)
        result = _tag_detail(conn, tag)
    return ok({"tag": result})


@router.delete("/task-tags/{tag_id}")
def delete_task_tag(
    team_id: str,
    tag_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    require_authenticated(user)
    with db() as conn:
        get_team(conn, team_id)
        tag = _get_tag(conn, tag_id, team_id)
        conn.execute(
            "DELETE FROM task_tags WHERE id=? AND team_id=?", (tag_id, team_id)
        )
        # Drop the reference from every task of the team that still points at the tag.
        for item in rows(
            conn,
            "SELECT id, tags FROM member_tasks WHERE team_id=?",
            (team_id,),
        ):
            parsed = json_loads(item.get("tags"), [])
            if not isinstance(parsed, list) or tag_id not in parsed:
                continue
            remaining = [value for value in parsed if value != tag_id]
            conn.execute(
                "UPDATE member_tasks SET tags=?, updated_at=? WHERE id=? AND team_id=?",
                (json_dumps(remaining), now_iso(), item["id"], team_id),
            )
        audit(
            conn,
            user,
            "task_tag.delete",
            "task_tag",
            tag_id,
            {"name": tag.get("name", "")},
        )
    return ok({"deleted": True, "id": tag_id})
