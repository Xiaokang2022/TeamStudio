"""Data insights aggregation (``#12`` dashboard) shared by the insights router.

Round 8 (team-only) payload — the endpoint returns exactly::

    {range, summary, members, trend}

The ``groups`` and ``teams`` comparison tables were removed with the development-group
concept: the dashboard is always scoped to one team, so cross-group / cross-team ranking is
meaningless. Member rows carry the same team metadata and real avatar as the overview
read model.

Time-window semantics (see docs/OPTIMIZATION_ROUND2_CONTRACT.md §3):

- a task is *active* in the window when it was created in it, completed in it, or is still
  open (``progress_status != "completed"``); ``range=all`` keeps everything;
- todos count when they were created in the window (``all`` keeps everything);
- a member row is only emitted when that person holds at least one active task or in-window
  todo, so empty teams stay compact;
- every ``*Rate`` / ``averageLoadPercent`` is a 0-100 integer.

Trend buckets: ``1w``/``2w`` use calendar days, the longer ranges use weeks, and ``all``
returns the most recent 26 weekly buckets.
"""

from __future__ import annotations

import math
import sqlite3
from datetime import date, datetime, time, timedelta
from typing import Any

from ..db import rows
from ..http import fail
from .member_identity import member_ids, team_members
from .tasks_service import (
    CAPACITY_POINTS,
    is_overdue,
    load_points,
    local_now,
    parse_timestamp,
    team_member_rows,
)

OPEN_PROGRESS_STATUSES = {"pending", "in_progress"}

RANGES: dict[str, dict[str, Any]] = {
    "1w": {"label": "近 1 周", "days": 7},
    "2w": {"label": "近 2 周", "days": 14},
    "1m": {"label": "近 1 个月", "days": 30},
    "2m": {"label": "近 2 个月", "days": 60},
    "3m": {"label": "近 3 个月", "days": 90},
    "all": {"label": "全部时间", "days": None},
}
DEFAULT_RANGE = "1m"
DAY_GRANULARITY_RANGES = {"1w", "2w"}
ALL_TREND_BUCKETS = 26


def normalize_range(value: str | None) -> str:
    cleaned = (value or DEFAULT_RANGE).strip().lower()
    if cleaned not in RANGES:
        raise fail(422, "range 必须是 1w/2w/1m/2m/3m/all", "invalid_range")
    return cleaned


def _percent(part: int | float, whole: int | float) -> int:
    """Clamped 0-100 integer percentage."""
    if not whole:
        return 0
    return max(0, min(100, int(round(float(part) / float(whole) * 100))))


def _local_midnight(day: date, tz: Any) -> datetime:
    return datetime.combine(day, time.min).replace(tzinfo=tz)


def _task_stats(tasks: list[dict[str, Any]], today: date) -> dict[str, int]:
    open_tasks = [
        task for task in tasks if task.get("progress_status") in OPEN_PROGRESS_STATUSES
    ]
    completed = [task for task in tasks if task.get("progress_status") == "completed"]
    return {
        "tasks": len(tasks),
        "openTasks": len(open_tasks),
        "completedTasks": len(completed),
        "overdueTasks": sum(1 for task in open_tasks if is_overdue(task, today)),
        "blockedTasks": sum(
            1 for task in open_tasks if task.get("health_status") == "blocked"
        ),
        "completionRate": _percent(len(completed), len(tasks)),
        "loadPoints": sum(load_points(task) for task in open_tasks),
    }


def _todo_stats(todos: list[dict[str, Any]]) -> dict[str, int]:
    completed = sum(1 for todo in todos if todo.get("status") == "done")
    return {
        "todos": len(todos),
        "completedTodos": completed,
        "todoCompletionRate": _percent(completed, len(todos)),
    }


def _is_active_task(task: dict[str, Any], start: datetime | None) -> bool:
    if start is None:
        return True
    if task.get("progress_status") != "completed":
        return True
    created = parse_timestamp(task.get("created_at"))
    completed = parse_timestamp(task.get("completed_at"))
    return bool((created and created >= start) or (completed and completed >= start))


def _in_window_todo(todo: dict[str, Any], start: datetime | None) -> bool:
    if start is None:
        return True
    created = parse_timestamp(todo.get("created_at"))
    return bool(created and created >= start)


def _trend_buckets(
    range_key: str, today: date, tz: Any
) -> tuple[str, list[tuple[str, str, datetime, datetime]]]:
    """Build ``(label, start date, start datetime, end datetime)`` buckets ascending."""
    granularity = "day" if range_key in DAY_GRANULARITY_RANGES else "week"
    days = RANGES[range_key]["days"]
    buckets: list[tuple[str, str, datetime, datetime]] = []
    if granularity == "day":
        count = int(days or 0)
        for index in range(count - 1, -1, -1):
            day = today - timedelta(days=index)
            buckets.append(
                (
                    day.strftime("%m-%d"),
                    day.isoformat(),
                    _local_midnight(day, tz),
                    _local_midnight(day + timedelta(days=1), tz),
                )
            )
        return granularity, buckets
    count = ALL_TREND_BUCKETS if days is None else max(1, math.ceil(days / 7))
    window_start = None if days is None else today - timedelta(days=days)
    for index in range(count - 1, -1, -1):
        end_day = today - timedelta(days=7 * index)
        start_day = end_day - timedelta(days=6)
        if window_start is not None and start_day < window_start:
            start_day = window_start
        buckets.append(
            (
                start_day.strftime("%m-%d"),
                start_day.isoformat(),
                _local_midnight(start_day, tz),
                _local_midnight(end_day + timedelta(days=1), tz),
            )
        )
    return granularity, buckets


def _bucket_index(
    buckets: list[tuple[str, str, datetime, datetime]], moment: datetime | None
) -> int | None:
    if moment is None:
        return None
    for index, (_label, _start_date, start, end) in enumerate(buckets):
        if start <= moment < end:
            return index
    return None


def _build_trend(
    range_key: str,
    today: date,
    tz: Any,
    tasks: list[dict[str, Any]],
    todos: list[dict[str, Any]],
) -> dict[str, Any]:
    granularity, buckets = _trend_buckets(range_key, today, tz)
    points = [
        {"label": label, "start": start_date, "created": 0, "completed": 0, "todos": 0}
        for label, start_date, _start, _end in buckets
    ]
    for task in tasks:
        index = _bucket_index(buckets, parse_timestamp(task.get("created_at")))
        if index is not None:
            points[index]["created"] += 1
        index = _bucket_index(buckets, parse_timestamp(task.get("completed_at")))
        if index is not None:
            points[index]["completed"] += 1
    for todo in todos:
        index = _bucket_index(buckets, parse_timestamp(todo.get("created_at")))
        if index is not None:
            points[index]["todos"] += 1
    return {"granularity": granularity, "buckets": points}


def build_insights(
    conn: sqlite3.Connection, team_id: str, range_key: str
) -> dict[str, Any]:
    """Aggregate the insights dashboard payload for one team."""
    selected_range = normalize_range(range_key)
    range_info = RANGES[selected_range]
    days = range_info["days"]
    now = local_now()
    today = now.date()
    tz = now.tzinfo
    start = _local_midnight(today - timedelta(days=int(days)), tz) if days else None

    member_rows = team_member_rows(conn, team_id)
    task_rows = rows(
        conn,
        "SELECT * FROM member_tasks WHERE team_id=?",
        (team_id,),
    )
    todo_rows = rows(
        conn,
        "SELECT id, team_id, status, assignee_member_id, created_at, completed_at "
        "FROM todos WHERE team_id=?",
        (team_id,),
    )

    active_tasks = [task for task in task_rows if _is_active_task(task, start)]
    window_todos = [todo for todo in todo_rows if _in_window_todo(todo, start)]

    tasks_by_member: dict[str, list[dict[str, Any]]] = {}
    for task in active_tasks:
        tasks_by_member.setdefault(task.get("member_id", ""), []).append(task)
    todos_by_member: dict[str, list[dict[str, Any]]] = {}
    for todo in window_todos:
        assignee = todo.get("assignee_member_id")
        if assignee:
            todos_by_member.setdefault(assignee, []).append(todo)

    members: list[dict[str, Any]] = []
    # Historical data may hold several archive rows of one account inside the team; merge
    # them into one people row (statistics summed) exactly like the overview read model.
    for person in team_members(member_rows):
        primary = person["primary"]
        archive_ids = member_ids(person)
        member_tasks: list[dict[str, Any]] = []
        member_todos: list[dict[str, Any]] = []
        for archive_id in archive_ids:
            member_tasks.extend(tasks_by_member.get(archive_id, []))
            member_todos.extend(todos_by_member.get(archive_id, []))
        if not member_tasks and not member_todos:
            continue
        task_stats = _task_stats(member_tasks, today)
        todo_stats = _todo_stats(member_todos)
        members.append(
            {
                "memberId": primary["id"],
                "memberName": primary.get("name", ""),
                "memberTitle": primary.get("title", ""),
                "avatar": primary.get("avatar") or "",
                "avatarColor": primary.get("avatar_color", "#5865f2"),
                "teamId": primary.get("team_id", ""),
                "teamName": primary.get("team_name", ""),
                "tasks": task_stats["tasks"],
                "openTasks": task_stats["openTasks"],
                "completedTasks": task_stats["completedTasks"],
                "overdueTasks": task_stats["overdueTasks"],
                "blockedTasks": task_stats["blockedTasks"],
                "completionRate": task_stats["completionRate"],
                "loadPoints": task_stats["loadPoints"],
                "todos": todo_stats["todos"],
                "completedTodos": todo_stats["completedTodos"],
            }
        )

    summary_stats = _task_stats(active_tasks, today)
    summary_todos = _todo_stats(window_todos)
    capacity_points = len(members) * CAPACITY_POINTS
    summary = {
        "teams": 1,
        "members": len(members),
        "tasks": summary_stats["tasks"],
        "openTasks": summary_stats["openTasks"],
        "completedTasks": summary_stats["completedTasks"],
        "overdueTasks": summary_stats["overdueTasks"],
        "blockedTasks": summary_stats["blockedTasks"],
        "completionRate": summary_stats["completionRate"],
        "todos": summary_todos["todos"],
        "completedTodos": summary_todos["completedTodos"],
        "todoCompletionRate": summary_todos["todoCompletionRate"],
        "loadPoints": summary_stats["loadPoints"],
        "capacityPoints": capacity_points,
        "averageLoadPercent": _percent(summary_stats["loadPoints"], capacity_points),
    }

    return {
        "range": {
            "key": selected_range,
            "label": range_info["label"],
            "days": days,
            "start": start.date().isoformat() if start else None,
        },
        "summary": summary,
        "members": members,
        "trend": _build_trend(
            selected_range, today, tz, active_tasks, window_todos
        ),
    }
