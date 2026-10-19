"""Group overview, member profiles and member work-item routes.

Base path: ``/api/teams/{team_id}/groups/{group_id}``.

Response envelope is always ``{"ok": true, "data": ...}``; errors use
``HTTPException(status_code, detail={"code", "message", "details"})``.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Body, Depends

from ..auth import CurrentUser, get_current_user
from ..config import EMAIL_PATTERN
from ..db import db, json_dumps, json_loads, new_id, now_iso, row, rows, scalar
from ..http import fail, get_group, get_member, int_value, ok, text
from ..permissions import (
    audit,
    require_admin,
    require_member_writer,
    require_read_access,
)
from ..services.tasks_service import build_workload_section

router = APIRouter(
    prefix="/api/teams/{team_id}/groups/{group_id}", tags=["workspace"]
)

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
MEMBER_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
WORK_STATUSES = {"current", "done", "planned"}


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


def _work_payload(work: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": work["id"],
        "memberId": work["member_id"],
        "title": work["title"],
        "description": work.get("description", ""),
        "status": work.get("status", "current"),
        "period": work.get("period", ""),
        "category": work.get("category", ""),
        "progress": int(work.get("progress") or 0),
        "updatedAt": work.get("updated_at", ""),
    }


def _member_payload(
    member: dict[str, Any],
    works: list[dict[str, Any]],
    open_todos: int = 0,
) -> dict[str, Any]:
    work_items = [_work_payload(work) for work in works]
    current = [work for work in work_items if work["status"] == "current"]
    history = [work for work in work_items if work["status"] == "done"]
    return {
        "id": member["id"],
        "name": member["name"],
        "email": member.get("email", ""),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "avatarColor": member.get("avatar_color", "#5865f2"),
        "bio": member.get("bio", ""),
        "tags": _parsed_list(member.get("tags")),
        "skills": _parsed_list(member.get("skills")),
        # ``duties`` has no dedicated column yet; tolerate future schema additions.
        "duties": _parsed_list(member.get("duties")),
        "status": member.get("status", "available"),
        "joinedAt": member.get("joined_at", ""),
        "currentWorks": current,
        "historyWorks": history,
        "stats": {"current": len(current), "done": len(history), "todos": open_todos},
    }


def _member_detail(conn, member: dict[str, Any]) -> dict[str, Any]:
    works = rows(
        conn,
        "SELECT * FROM works WHERE member_id=? AND group_id=? ORDER BY sort_order, created_at",
        (member["id"], member["group_id"]),
    )
    open_todos = int(
        scalar(
            conn,
            "SELECT COUNT(*) FROM todos WHERE assignee_member_id=? AND group_id=? AND status<>'done'",
            (member["id"], member["group_id"]),
            default=0,
        )
        or 0
    )
    return _member_payload(member, works, open_todos)


def _group_detail(group: dict[str, Any], member_count: int = 0) -> dict[str, Any]:
    """Frontend-facing camelCase projection of a group joined with its team."""
    return {
        "id": group["id"],
        "teamId": group["team_id"],
        "teamName": group.get("team_name", ""),
        "teamShortName": group.get("team_short_name", ""),
        "name": group["name"],
        "description": group.get("description", ""),
        "color": group.get("color", "#5865f2"),
        "icon": group.get("icon", "layers"),
        "memberCount": member_count,
    }


def _recent_activity(conn, group_id: str, limit: int = 12) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for todo in rows(
        conn,
        "SELECT t.id, t.title, t.status, t.updated_at, t.completed_at, m.name AS assignee_name "
        "FROM todos t LEFT JOIN members m ON m.id=t.assignee_member_id "
        "WHERE t.group_id=? ORDER BY t.updated_at DESC LIMIT 6",
        (group_id,),
    ):
        entries.append(
            {
                "id": todo["id"],
                "type": "todo",
                "title": todo["title"],
                "description": "待办已完成" if todo["status"] == "done" else "待办更新",
                "memberName": todo.get("assignee_name") or "",
                "memberId": None,
                "at": todo.get("completed_at") or todo.get("updated_at") or "",
            }
        )
    for announcement in rows(
        conn,
        "SELECT id, title, author_name, created_at FROM announcements "
        "WHERE group_id=? ORDER BY created_at DESC LIMIT 4",
        (group_id,),
    ):
        entries.append(
            {
                "id": announcement["id"],
                "type": "announcement",
                "title": announcement["title"],
                "description": "发布公告",
                "memberName": announcement.get("author_name", ""),
                "memberId": None,
                "at": announcement.get("created_at", ""),
            }
        )
    for work in rows(
        conn,
        "SELECT w.id, w.title, w.status, w.updated_at, m.id AS member_id, m.name AS member_name "
        "FROM works w JOIN members m ON m.id=w.member_id "
        "WHERE w.group_id=? ORDER BY w.updated_at DESC LIMIT 4",
        (group_id,),
    ):
        entries.append(
            {
                "id": work["id"],
                "type": "work",
                "title": work["title"],
                "description": f"工作进展 · {work['status']}",
                "memberName": work.get("member_name", ""),
                "memberId": work.get("member_id"),
                "at": work.get("updated_at", ""),
            }
        )
    for entry in rows(
        conn,
        "SELECT e.id, e.side, e.title, e.reason, e.member_id, e.member_name, e.created_at "
        "FROM redblack_entries e JOIN redblack_boards b ON b.id=e.board_id "
        "WHERE b.group_id=? ORDER BY e.created_at DESC LIMIT 4",
        (group_id,),
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


# --------------------------------------------------------------------------- overview


@router.get("/overview")
def group_overview(
    team_id: str,
    group_id: str,
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        group = get_group(conn, team_id, group_id)
        member_rows = rows(
            conn,
            "SELECT * FROM members WHERE group_id=? ORDER BY sort_order, created_at",
            (group_id,),
        )
        work_rows = rows(
            conn,
            "SELECT * FROM works WHERE group_id=? ORDER BY member_id, sort_order, created_at",
            (group_id,),
        )
        todo_rows = rows(
            conn,
            "SELECT id, assignee_member_id, status FROM todos WHERE group_id=?",
            (group_id,),
        )
        pinned = int(
            scalar(
                conn,
                "SELECT COUNT(*) FROM announcements WHERE group_id=? AND pinned=1",
                (group_id,),
                default=0,
            )
            or 0
        )
        activity = _recent_activity(conn, group_id)
        workload_section = build_workload_section(conn, group_id)

    works_by_member: dict[str, list[dict[str, Any]]] = {}
    for work in work_rows:
        works_by_member.setdefault(work["member_id"], []).append(work)
    open_todos_by_member: dict[str, int] = {}
    for todo in todo_rows:
        assignee = todo.get("assignee_member_id")
        if assignee and todo.get("status") != "done":
            open_todos_by_member[assignee] = open_todos_by_member.get(assignee, 0) + 1

    members = [
        _member_payload(member, works_by_member.get(member["id"], []), open_todos_by_member.get(member["id"], 0))
        for member in member_rows
    ]
    works = [_work_payload(work) for work in work_rows]
    done_todos = sum(1 for todo in todo_rows if todo.get("status") == "done")
    stats = {
        "members": len(member_rows),
        "works": len(work_rows),
        "currentWorks": sum(1 for work in works if work["status"] == "current"),
        "doneWorks": sum(1 for work in works if work["status"] == "done"),
        "plannedWorks": sum(1 for work in works if work["status"] == "planned"),
        "todos": len(todo_rows),
        "openTodos": len(todo_rows) - done_todos,
        "doneTodos": done_todos,
        "pinned": pinned,
    }
    group_payload = _group_detail(group, len(member_rows))
    return ok(
        {
            "group": group_payload,
            "members": members,
            "works": works,
            "recentActivity": activity,
            "stats": stats,
            "workloads": workload_section["workloads"],
            "workloadSummary": workload_section["summary"],
        }
    )


# --------------------------------------------------------------------------- members


@router.patch("/members/{member_id}")
def update_member(
    team_id: str,
    group_id: str,
    member_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        get_member(conn, member_id, group_id)
        require_member_writer(user, team_id, group_id, member_id)

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
        if "status" in payload:
            updates["status"] = text(payload.get("status"), "状态", 20, required=True)
        if "avatarColor" in payload:
            updates["avatar_color"] = _hex_color(payload.get("avatarColor"), "头像颜色")
        if "tags" in payload:
            updates["tags"] = json_dumps(_string_list(payload.get("tags"), "标签"))
        if "skills" in payload:
            updates["skills"] = json_dumps(_string_list(payload.get("skills"), "技能"))
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE members SET {assignments} WHERE id=? AND group_id=?",
                (*updates.values(), member_id, group_id),
            )
            audit(conn, user, "member.update", "member", member_id, {"fields": sorted(payload)})
        member = _member_detail(conn, get_member(conn, member_id, group_id))
    return ok({"member": member})


@router.post("/members")
def create_member(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        group = get_group(conn, team_id, group_id)
        require_admin(user, team_id, group_id)

        raw_id = text(payload.get("id"), "成员 ID", 80)
        member_id = raw_id or new_id("member")
        if not MEMBER_ID_PATTERN.fullmatch(member_id):
            raise fail(422, "成员 ID 只能包含字母、数字、下划线和连字符", "validation_error")
        if row(conn, "SELECT 1 FROM members WHERE id=?", (member_id,)):
            raise fail(409, "成员 ID 已存在", "member_exists")

        name = text(payload.get("name"), "姓名", 60, required=True)
        email = _email(payload.get("email"))
        title = text(payload.get("title"), "职位", 60)
        role = text(payload.get("role"), "角色", 40)
        avatar_color = _hex_color(payload.get("avatarColor"), "头像颜色")
        bio = text(payload.get("bio"), "个人简介", 2000)
        tags = json_dumps(_string_list(payload.get("tags"), "标签"))
        skills = json_dumps(_string_list(payload.get("skills"), "技能"))
        status = text(payload.get("status"), "状态", 20) or "available"
        sort_order = (
            int_value(payload.get("sortOrder"), "排序", 0, 100_000)
            if payload.get("sortOrder") is not None
            else int(
                scalar(
                    conn,
                    "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM members WHERE group_id=?",
                    (group_id,),
                    default=1,
                )
                or 1
            )
        )
        now = now_iso()
        conn.execute(
            "INSERT INTO members (id,team_id,group_id,external_id,name,email,title,role,"
            "avatar_color,bio,tags,skills,status,joined_at,sort_order,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                member_id,
                group["team_id"],
                group_id,
                "",
                name,
                email,
                title,
                role,
                avatar_color,
                bio,
                tags,
                skills,
                status,
                now,
                sort_order,
                now,
                now,
            ),
        )
        audit(conn, user, "member.create", "member", member_id, {"name": name})
        member = _member_detail(conn, get_member(conn, member_id, group_id))
    return ok({"member": member})


@router.delete("/members/{member_id}")
def delete_member(
    team_id: str,
    group_id: str,
    member_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        member = get_member(conn, member_id, group_id)
        require_admin(user, team_id, group_id)
        if user.linked_member_id == member_id:
            raise fail(409, "不能删除与当前登录身份关联的成员", "cannot_delete_self")
        # Responsibility matrix columns have no FK; detach them before the cascade delete.
        conn.execute(
            "UPDATE matrix_areas SET owner_member_id=NULL WHERE owner_member_id=?", (member_id,)
        )
        conn.execute(
            "UPDATE matrix_areas SET backup_member_id=NULL WHERE backup_member_id=?", (member_id,)
        )
        conn.execute("UPDATE todos SET assignee_member_id=NULL WHERE assignee_member_id=?", (member_id,))
        conn.execute("DELETE FROM members WHERE id=? AND group_id=?", (member_id, group_id))
        audit(conn, user, "member.delete", "member", member_id, {"name": member["name"]})
    return ok({"deleted": True, "id": member_id})


@router.get("/members/{member_id}/works")
def list_member_works(
    team_id: str,
    group_id: str,
    member_id: str,
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        get_member(conn, member_id, group_id)
        works = rows(
            conn,
            "SELECT * FROM works WHERE member_id=? AND group_id=? ORDER BY sort_order, created_at",
            (member_id, group_id),
        )
    return ok({"memberId": member_id, "works": [_work_payload(work) for work in works]})


def _get_work(conn, work_id: str, member_id: str, group_id: str) -> dict[str, Any]:
    found = row(
        conn,
        "SELECT * FROM works WHERE id=? AND member_id=? AND group_id=?",
        (work_id, member_id, group_id),
    )
    if not found:
        raise fail(404, "工作项不存在", "work_not_found")
    return found


@router.post("/members/{member_id}/works")
def create_work(
    team_id: str,
    group_id: str,
    member_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        get_member(conn, member_id, group_id)
        require_member_writer(user, team_id, group_id, member_id)

        status = _work_status(payload.get("status"))
        title = text(payload.get("title"), "工作标题", 120, required=True)
        description = text(payload.get("description"), "工作描述", 2000)
        period = text(payload.get("period"), "周期", 60)
        category = text(payload.get("category"), "分类", 60)
        default_progress = 100 if status == "done" else 0
        progress = int_value(payload.get("progress", default_progress), "进度", 0, 100)
        sort_order = int(
            scalar(
                conn,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM works WHERE member_id=?",
                (member_id,),
                default=0,
            )
            or 0
        )
        work_id = new_id("work")
        now = now_iso()
        conn.execute(
            "INSERT INTO works (id,member_id,group_id,title,description,status,period,category,"
            "progress,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                work_id,
                member_id,
                group_id,
                title,
                description,
                status,
                period,
                category,
                progress,
                sort_order,
                now,
                now,
            ),
        )
        audit(conn, user, "work.create", "work", work_id, {"memberId": member_id, "title": title})
        work = _work_payload(_get_work(conn, work_id, member_id, group_id))
    return ok({"work": work})


@router.patch("/members/{member_id}/works/{work_id}")
def update_work(
    team_id: str,
    group_id: str,
    member_id: str,
    work_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        get_member(conn, member_id, group_id)
        work = _get_work(conn, work_id, member_id, group_id)
        require_member_writer(user, team_id, group_id, member_id)

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
        if "period" in payload:
            updates["period"] = text(payload.get("period"), "周期", 60)
        if "category" in payload:
            updates["category"] = text(payload.get("category"), "分类", 60)
        if "progress" in payload:
            updates["progress"] = int_value(payload.get("progress"), "进度", 0, 100)
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE works SET {assignments} WHERE id=? AND member_id=? AND group_id=?",
                (*updates.values(), work_id, member_id, group_id),
            )
            audit(conn, user, "work.update", "work", work_id, {"fields": sorted(payload)})
        work = _work_payload(_get_work(conn, work_id, member_id, group_id))
    return ok({"work": work})


@router.delete("/members/{member_id}/works/{work_id}")
def delete_work(
    team_id: str,
    group_id: str,
    member_id: str,
    work_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        get_member(conn, member_id, group_id)
        _get_work(conn, work_id, member_id, group_id)
        require_member_writer(user, team_id, group_id, member_id)
        conn.execute(
            "DELETE FROM works WHERE id=? AND member_id=? AND group_id=?",
            (work_id, member_id, group_id),
        )
        audit(conn, user, "work.delete", "work", work_id, {"memberId": member_id})
    return ok({"deleted": True, "id": work_id})
