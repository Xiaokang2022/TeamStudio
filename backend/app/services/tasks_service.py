"""Member task ledger payload builders and weighted workload quantification (v2).

Workload is expressed in load *points* rather than hours. Every task is worth::

    loadPoints = 1 (base) + priority bonus + difficulty bonus

with priority bonus low/normal/high/urgent = 0/1/2/3 and difficulty bonus
easy/medium/hard = 0/1/2, so a single task is worth 1-6 points. Capacity is a fixed
``CAPACITY_POINTS = 15`` per member per week and the average window is the last 4 completed
7-day periods (window 0 is the most recent one, ending at "now").

Timestamps are stored as ISO-8601 strings in the server-local timezone (see ``db.now_iso``).
Parsing here is deliberately tolerant so hand-edited rows never break the overview:
unparsable values are ignored for the average calculation while still counting towards the
current open-task load. The legacy ``effort_hours`` column is intentionally never exposed.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from typing import Any

from ..db import rows

CAPACITY_POINTS = 15
WINDOW_WEEKS = 4
WINDOW_LABEL = "近 4 周"
BASE_LOAD_POINTS = 1

PRIORITY_WEIGHTS = {"low": 0, "normal": 1, "high": 2, "urgent": 3}
DIFFICULTY_WEIGHTS = {"easy": 0, "medium": 1, "hard": 2}
PRIORITIES = tuple(PRIORITY_WEIGHTS)
DIFFICULTIES = tuple(DIFFICULTY_WEIGHTS)

SCORING_LABEL = "任务基础 1 分 + 难度加成 + 优先级加成；每人每周容量 15 分"

PROGRESS_STATUSES = ("pending", "in_progress", "completed")
HEALTH_STATUSES = ("normal", "delayed", "blocked")
OPEN_PROGRESS_STATUSES = {"pending", "in_progress"}

HEALTH_SORT_ORDER = {"blocked": 0, "delayed": 1, "normal": 2}

TASK_SELECT = (
    "SELECT t.*, m.name AS member_name, m.title AS member_title, "
    "m.avatar_color AS member_avatar_color, m.sort_order AS member_sort_order, "
    "m.created_at AS member_created_at "
    "FROM member_tasks t JOIN members m ON m.id=t.member_id "
)

# Sorting contract: member sort order first, then blocked/delayed tasks, then expected date
# (tasks without an expected date last), then creation time.
TASK_ORDER = (
    "ORDER BY m.sort_order, m.created_at, "
    "CASE t.health_status WHEN 'blocked' THEN 0 WHEN 'delayed' THEN 1 ELSE 2 END, "
    "CASE WHEN t.expected_date IS NULL OR t.expected_date='' THEN 1 ELSE 0 END, "
    "t.expected_date, t.created_at, t.id"
)


def local_now() -> datetime:
    """Current time in the server-local timezone, timezone-aware."""
    return datetime.now().astimezone()


def parse_timestamp(value: Any) -> datetime | None:
    """Parse a stored ISO timestamp; naive values are assumed to be local time."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=local_now().tzinfo)
    return parsed


def load_points(task: dict[str, Any]) -> int:
    """Weighted load score in the 1-6 range for one task row."""
    priority = task.get("priority")
    difficulty = task.get("difficulty")
    priority_bonus = PRIORITY_WEIGHTS.get(priority, PRIORITY_WEIGHTS["normal"])
    difficulty_bonus = DIFFICULTY_WEIGHTS.get(difficulty, DIFFICULTY_WEIGHTS["medium"])
    return BASE_LOAD_POINTS + priority_bonus + difficulty_bonus


def _round_points(value: float) -> float:
    return round(float(value or 0), 1)


def _round_percent(value: float) -> int:
    return int(round(value))


def _parse_expected_date(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def is_overdue(task: dict[str, Any], today: date) -> bool:
    """Open task with a non-empty expected date strictly before today."""
    if task.get("progress_status") == "completed":
        return False
    expected = _parse_expected_date(task.get("expected_date"))
    return bool(expected and expected < today)


def workload_level(percent: int) -> str:
    if percent < 40:
        return "low"
    if percent < 85:
        return "balanced"
    if percent < 110:
        return "high"
    return "overload"


def _windows(now: datetime) -> list[tuple[datetime, datetime]]:
    """Last 4 completed 7-day windows; index 0 is the most recent window ending now."""
    return [
        (now - timedelta(days=7 * (index + 1)), now - timedelta(days=7 * index))
        for index in range(WINDOW_WEEKS)
    ]


def _average_points(
    tasks: list[dict[str, Any]], windows: list[tuple[datetime, datetime]]
) -> float:
    """Average active task points per window over exactly ``WINDOW_WEEKS`` windows.

    A task counts towards a window when it already existed at the window end and was not
    completed before the window start, i.e. it was active at some point inside it.
    """
    total = 0.0
    for window_start, window_end in windows:
        for task in tasks:
            created = parse_timestamp(task.get("created_at"))
            if created is None or created > window_end:
                continue
            completed = parse_timestamp(task.get("completed_at"))
            if completed is not None and completed < window_start:
                continue
            total += load_points(task)
    return total / WINDOW_WEEKS


def _member_workload(
    member: dict[str, Any],
    tasks: list[dict[str, Any]],
    windows: list[tuple[datetime, datetime]],
    today: date,
) -> dict[str, Any]:
    open_tasks = [task for task in tasks if task.get("progress_status") in OPEN_PROGRESS_STATUSES]
    completed_tasks = [task for task in tasks if task.get("progress_status") == "completed"]
    current_points = sum(load_points(task) for task in open_tasks)
    raw_average = _average_points(tasks, windows)
    average_percent = _round_percent(raw_average / CAPACITY_POINTS * 100)
    return {
        "memberId": member["id"],
        "memberName": member.get("name", ""),
        "memberTitle": member.get("title", ""),
        "avatarColor": member.get("avatar_color", "#5865f2"),
        "currentPoints": int(current_points),
        "currentLoadPercent": _round_percent(current_points / CAPACITY_POINTS * 100),
        "averagePoints": _round_points(raw_average),
        "averageLoadPercent": average_percent,
        "capacityPoints": CAPACITY_POINTS,
        "windowWeeks": WINDOW_WEEKS,
        "openTasks": len(open_tasks),
        "completedTasks": len(completed_tasks),
        "blockedTasks": sum(1 for task in open_tasks if task.get("health_status") == "blocked"),
        "overdueTasks": sum(1 for task in open_tasks if is_overdue(task, today)),
        "level": workload_level(average_percent),
    }


def task_payload(task: dict[str, Any], today: date | None = None) -> dict[str, Any]:
    """CamelCase projection of one member task row (expects the member join)."""
    current_day = today or local_now().date()
    return {
        "id": task["id"],
        "groupId": task.get("group_id", ""),
        "memberId": task.get("member_id", ""),
        "memberName": task.get("member_name", ""),
        "memberTitle": task.get("member_title", ""),
        "memberAvatarColor": task.get("member_avatar_color", "#5865f2"),
        "title": task.get("title", ""),
        "description": task.get("description", ""),
        "progressStatus": task.get("progress_status", "pending"),
        "healthStatus": task.get("health_status", "normal"),
        "priority": task.get("priority") or "normal",
        "difficulty": task.get("difficulty") or "medium",
        "loadPoints": load_points(task),
        "expectedDate": task.get("expected_date", "") or "",
        "createdBy": task.get("created_by", ""),
        "createdAt": task.get("created_at", ""),
        "updatedAt": task.get("updated_at", ""),
        "completedAt": task.get("completed_at") or None,
        "overdue": is_overdue(task, current_day),
    }


def list_group_tasks(conn: sqlite3.Connection, group_id: str) -> list[dict[str, Any]]:
    return rows(conn, f"{TASK_SELECT}WHERE t.group_id=? {TASK_ORDER}", (group_id,))


def get_task_row(
    conn: sqlite3.Connection, task_id: str, group_id: str
) -> dict[str, Any] | None:
    found = rows(conn, f"{TASK_SELECT}WHERE t.id=? AND t.group_id=?", (task_id, group_id))
    return found[0] if found else None


def build_workload_section(
    conn: sqlite3.Connection, group_id: str
) -> dict[str, Any]:
    """Return the workload array and aggregate summary for one group.

    Every group member is included, even with zero tasks, ordered by member sort order.
    """
    members = rows(
        conn,
        "SELECT * FROM members WHERE group_id=? ORDER BY sort_order, created_at, id",
        (group_id,),
    )
    task_rows = rows(conn, "SELECT * FROM member_tasks WHERE group_id=?", (group_id,))
    tasks_by_member: dict[str, list[dict[str, Any]]] = {}
    for task in task_rows:
        tasks_by_member.setdefault(task.get("member_id", ""), []).append(task)

    now = local_now()
    today = now.date()
    windows = _windows(now)
    workloads = [
        _member_workload(member, tasks_by_member.get(member["id"], []), windows, today)
        for member in members
    ]
    member_count = len(workloads)
    total_current = int(sum(item["currentPoints"] for item in workloads))
    total_average = _round_points(sum(item["averagePoints"] for item in workloads))
    average_per_member = total_average / member_count if member_count else 0.0
    summary = {
        "members": member_count,
        "tasks": len(task_rows),
        "openTasks": sum(item["openTasks"] for item in workloads),
        "completedTasks": sum(item["completedTasks"] for item in workloads),
        "blockedTasks": sum(item["blockedTasks"] for item in workloads),
        "overdueTasks": sum(item["overdueTasks"] for item in workloads),
        "currentPoints": total_current,
        "averagePoints": total_average,
        "averageLoadPercent": _round_percent(average_per_member / CAPACITY_POINTS * 100),
        "capacityPoints": CAPACITY_POINTS,
        "windowWeeks": WINDOW_WEEKS,
    }
    return {
        "workloads": workloads,
        "summary": summary,
        "meta": {
            "capacityPoints": CAPACITY_POINTS,
            "windowWeeks": WINDOW_WEEKS,
            "windowLabel": WINDOW_LABEL,
            "scoring": SCORING_LABEL,
        },
    }


def build_tasks_payload(conn: sqlite3.Connection, group_id: str) -> dict[str, Any]:
    """Full GET /tasks payload: tasks plus workload section plus meta."""
    today = local_now().date()
    tasks = [task_payload(task, today) for task in list_group_tasks(conn, group_id)]
    section = build_workload_section(conn, group_id)
    return {
        "tasks": tasks,
        "workloads": section["workloads"],
        "summary": section["summary"],
        "meta": section["meta"],
    }
