"""Tests for the member task ledger, permissions and weighted workload (v2).

Fixtures come from ``conftest.py``: ``client`` is the loopback device admin, ``guest_client``
is a remote guest (10.20.30.40). Member-self behaviour is exercised by attaching a signed
session cookie for the seeded SSO-linked member ``m-chen`` to the remote client.

The v2 workload model is point based: ``loadPoints = 1 + priority bonus + difficulty bonus``
with capacity ``15`` points per member per week.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from backend.app.auth import SessionIdentity, create_session_token
from backend.app.db import db, init_db, rows, scalar
from backend.app.seed import seed_if_empty, seed_member_tasks_if_empty
from backend.app.services.tasks_service import (
    DIFFICULTY_WEIGHTS,
    PRIORITY_WEIGHTS,
    SCORING_LABEL,
)

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
TASKS_URL = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/tasks"
OVERVIEW_URL = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/overview"
MEMBERS_URL = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/members"

CHEN_EMAIL = "chen.yu@corp.example"

GROUPS = [
    ("team-aurora", "grp-frontend"),
    ("team-aurora", "grp-platform"),
    ("team-aurora", "grp-design"),
    ("team-voyage", "grp-data"),
    ("team-voyage", "grp-infra"),
]

ALL_COMBINATIONS = {
    (priority, difficulty)
    for priority in PRIORITY_WEIGHTS
    for difficulty in DIFFICULTY_WEIGHTS
}


# --------------------------------------------------------------------------- helpers


def _login_as_member(client, email: str = CHEN_EMAIL, name: str = "陈屿") -> None:
    identity = SessionIdentity(id=email, name=name, email=email)
    client.cookies.set("teamstudio_session", create_session_token(identity, 7))


def _days_from_today(offset: int) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


def _iso_days_ago(days: float) -> str:
    moment = datetime.now().astimezone() - timedelta(days=days)
    return moment.isoformat(timespec="seconds")


def _tasks_url(team_id: str = TEAM_ID, group_id: str = GROUP_ID) -> str:
    return f"/api/teams/{team_id}/groups/{group_id}/tasks"


def _create_member(client, name: str = "测试负载", email: str = "loadtest@corp.example") -> str:
    response = client.post(
        MEMBERS_URL,
        json={"name": name, "email": email, "title": "测试工程师"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["member"]["id"]


def _insert_task(
    member_id: str,
    task_id: str,
    *,
    priority: str,
    difficulty: str,
    created_days_ago: float,
    completed_days_ago: float | None = None,
    progress_status: str = "pending",
    health_status: str = "normal",
    expected_offset: int | None = 5,
) -> None:
    """Direct ledger insert with explicit timestamps, used for window math tests."""
    with db() as conn:
        created_at = _iso_days_ago(created_days_ago)
        completed_at = (
            _iso_days_ago(completed_days_ago) if completed_days_ago is not None else None
        )
        conn.execute(
            "INSERT INTO member_tasks (id,group_id,member_id,title,description,"
            "progress_status,health_status,priority,difficulty,expected_date,created_by,"
            "created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id,
                GROUP_ID,
                member_id,
                f"窗口测试 {task_id}",
                "",
                progress_status,
                health_status,
                priority,
                difficulty,
                _days_from_today(expected_offset) if expected_offset is not None else "",
                "Admin",
                created_at,
                created_at,
                completed_at,
            ),
        )


def _load_points(priority: str, difficulty: str) -> int:
    return 1 + PRIORITY_WEIGHTS[priority] + DIFFICULTY_WEIGHTS[difficulty]


def _workload_for(client, member_id: str) -> dict:
    response = client.get(TASKS_URL)
    assert response.status_code == 200, response.text
    for item in response.json()["data"]["workloads"]:
        if item["memberId"] == member_id:
            return item
    raise AssertionError(f"missing workload for {member_id}")


# --------------------------------------------------------------------------- read / seed


def test_guest_can_read_tasks(guest_client):
    response = guest_client.get(TASKS_URL)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    data = body["data"]
    assert set(data) >= {"tasks", "workloads", "summary", "meta"}
    assert isinstance(data["tasks"], list) and data["tasks"]
    assert data["meta"] == {
        "capacityPoints": 15,
        "windowWeeks": 4,
        "windowLabel": "近 4 周",
        "scoring": SCORING_LABEL,
    }

    task = data["tasks"][0]
    for key in (
        "id",
        "groupId",
        "memberId",
        "memberName",
        "memberTitle",
        "memberAvatarColor",
        "title",
        "description",
        "progressStatus",
        "healthStatus",
        "priority",
        "difficulty",
        "loadPoints",
        "expectedDate",
        "createdBy",
        "createdAt",
        "updatedAt",
        "completedAt",
        "overdue",
    ):
        assert key in task
    assert "effortHours" not in task
    assert isinstance(task["loadPoints"], int)
    assert 1 <= task["loadPoints"] <= 6
    assert task["loadPoints"] == _load_points(task["priority"], task["difficulty"])

    workload = data["workloads"][0]
    for key in (
        "memberId",
        "memberName",
        "memberTitle",
        "avatarColor",
        "currentPoints",
        "currentLoadPercent",
        "averagePoints",
        "averageLoadPercent",
        "capacityPoints",
        "windowWeeks",
        "openTasks",
        "completedTasks",
        "blockedTasks",
        "overdueTasks",
        "level",
    ):
        assert key in workload
    assert workload["capacityPoints"] == 15
    assert workload["windowWeeks"] == 4
    for legacy in ("currentHours", "averageHours", "capacityHours", "effortHours"):
        assert legacy not in workload


def test_seed_backfills_once_and_is_idempotent(client):
    with db() as conn:
        seeded = scalar(conn, "SELECT COUNT(*) FROM member_tasks")
    assert seeded == 49
    assert seed_member_tasks_if_empty() == 0

    # Simulate an existing deployment that has members but an empty ledger.
    with db() as conn:
        conn.execute("DELETE FROM member_tasks")
    assert seed_member_tasks_if_empty() == 49
    assert seed_member_tasks_if_empty() == 0
    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM member_tasks") == 49


def test_seed_covers_all_priority_difficulty_combinations(client):
    combinations: set[tuple[str, str]] = set()
    for team_id, group_id in GROUPS:
        response = client.get(_tasks_url(team_id, group_id))
        assert response.status_code == 200
        for task in response.json()["data"]["tasks"]:
            combinations.add((task["priority"], task["difficulty"]))
            assert task["loadPoints"] == _load_points(task["priority"], task["difficulty"])
    assert combinations == ALL_COMBINATIONS


# --------------------------------------------------------------------------- permissions


def test_guest_writes_are_denied(guest_client):
    created = guest_client.post(TASKS_URL, json={"title": "访客任务"})
    assert created.status_code == 401
    assert created.json()["error"]["code"] == "authentication_required"

    patched = guest_client.patch(
        f"{TASKS_URL}/task-seed-m-chen-01", json={"title": "访客修改"}
    )
    assert patched.status_code == 401

    deleted = guest_client.delete(f"{TASKS_URL}/task-seed-m-chen-01")
    assert deleted.status_code == 401


def test_member_can_only_manage_own_tasks(guest_client):
    _login_as_member(guest_client)

    # Create defaults to the caller's linked member when memberId is omitted.
    created = guest_client.post(
        TASKS_URL,
        json={
            "title": "我的任务",
            "priority": "high",
            "difficulty": "hard",
            "expectedDate": _days_from_today(3),
        },
    )
    assert created.status_code == 200, created.text
    task = created.json()["data"]["task"]
    assert task["memberId"] == "m-chen"
    assert task["createdBy"] == "陈屿"
    assert task["loadPoints"] == _load_points("high", "hard")  # 5
    assert "effortHours" not in task

    # Cannot create for someone else.
    denied = guest_client.post(TASKS_URL, json={"memberId": "m-lin", "title": "越权任务"})
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "forbidden"

    # Can update the own task.
    updated = guest_client.patch(
        f"{TASKS_URL}/{task['id']}", json={"progressStatus": "completed"}
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["task"]["completedAt"]

    # Cannot update another member's task.
    denied = guest_client.patch(
        f"{TASKS_URL}/task-seed-m-lin-01", json={"title": "越权修改"}
    )
    assert denied.status_code == 403

    # Cannot reassign the own task to another member.
    denied = guest_client.patch(
        f"{TASKS_URL}/{task['id']}", json={"memberId": "m-lin"}
    )
    assert denied.status_code == 403

    # Cannot delete another member's task; can delete the own one.
    denied = guest_client.delete(f"{TASKS_URL}/task-seed-m-lin-01")
    assert denied.status_code == 403
    deleted = guest_client.delete(f"{TASKS_URL}/{task['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["data"]["deleted"] is True


def test_admin_manages_any_member_task(client):
    created = client.post(
        TASKS_URL,
        json={
            "memberId": "m-lin",
            "title": "管理员创建的任务",
            "description": "覆盖完整字段",
            "progressStatus": "in_progress",
            "healthStatus": "delayed",
            "priority": "high",
            "difficulty": "hard",
            "expectedDate": _days_from_today(3),
        },
    )
    assert created.status_code == 200, created.text
    task = created.json()["data"]["task"]
    task_id = task["id"]
    assert task["memberId"] == "m-lin"
    assert task["progressStatus"] == "in_progress"
    assert task["healthStatus"] == "delayed"
    assert task["priority"] == "high"
    assert task["difficulty"] == "hard"
    assert task["loadPoints"] == 5
    assert task["completedAt"] is None
    assert task["createdBy"] == "Admin"
    assert "effortHours" not in task

    # The legacy column is still stored but never returned.
    with db() as conn:
        stored_effort = scalar(
            conn, "SELECT effort_hours FROM member_tasks WHERE id=?", (task_id,)
        )
    assert stored_effort == 8

    # Writes are audited when features.auditLog is on (default).
    with db() as conn:
        audited = scalar(
            conn,
            "SELECT COUNT(*) FROM audit_logs WHERE action='task.create' AND entity_id=?",
            (task_id,),
        )
    assert audited == 1

    # Completing sets completed_at, reopening clears it.
    completed = client.patch(f"{TASKS_URL}/{task_id}", json={"progressStatus": "completed"})
    assert completed.status_code == 200
    assert completed.json()["data"]["task"]["completedAt"]

    reopened = client.patch(f"{TASKS_URL}/{task_id}", json={"progressStatus": "pending"})
    assert reopened.status_code == 200
    assert reopened.json()["data"]["task"]["completedAt"] is None

    # Changing priority/difficulty is reflected in loadPoints.
    rescored = client.patch(
        f"{TASKS_URL}/{task_id}", json={"priority": "urgent", "difficulty": "easy"}
    )
    assert rescored.status_code == 200
    assert rescored.json()["data"]["task"]["loadPoints"] == 4

    # Overdue derives from an open task whose expected date is in the past.
    overdue = client.patch(
        f"{TASKS_URL}/{task_id}",
        json={"healthStatus": "blocked", "expectedDate": _days_from_today(-4)},
    )
    assert overdue.status_code == 200
    overdue_task = overdue.json()["data"]["task"]
    assert overdue_task["healthStatus"] == "blocked"
    assert overdue_task["overdue"] is True

    deleted = client.delete(f"{TASKS_URL}/{task_id}")
    assert deleted.status_code == 200
    assert deleted.json()["data"]["deleted"] is True
    listed = client.get(TASKS_URL).json()["data"]["tasks"]
    assert all(item["id"] != task_id for item in listed)

    # Deleting an unknown task is a 404.
    assert client.delete(f"{TASKS_URL}/{task_id}").status_code == 404
    assert client.patch(f"{TASKS_URL}/{task_id}", json={"title": "x"}).status_code == 404


# --------------------------------------------------------------------------- validation / scoring


def test_task_load_points_formula(client):
    for priority in PRIORITY_WEIGHTS:
        for difficulty in DIFFICULTY_WEIGHTS:
            response = client.post(
                TASKS_URL,
                json={
                    "memberId": "m-lin",
                    "title": f"{priority}/{difficulty}",
                    "priority": priority,
                    "difficulty": difficulty,
                },
            )
            assert response.status_code == 200, response.text
            task = response.json()["data"]["task"]
            expected = _load_points(priority, difficulty)
            assert task["loadPoints"] == expected, (priority, difficulty)
            assert task["priority"] == priority
            assert task["difficulty"] == difficulty
            assert "effortHours" not in task

    # Defaults: normal / medium -> 1 + 1 + 1 = 3 points.
    defaulted = client.post(TASKS_URL, json={"memberId": "m-lin", "title": "默认分值"})
    assert defaulted.status_code == 200
    default_task = defaulted.json()["data"]["task"]
    assert default_task["priority"] == "normal"
    assert default_task["difficulty"] == "medium"
    assert default_task["loadPoints"] == 3


def test_invalid_task_payloads_are_rejected(client):
    invalid_bodies = [
        {"title": "x", "expectedDate": "2026/10/01"},
        {"title": "x", "expectedDate": "2026-02-31"},
        {"title": "x", "progressStatus": "done"},
        {"title": "x", "healthStatus": "sick"},
        {"title": "x", "priority": "critical"},
        {"title": "x", "difficulty": "extreme"},
        {"title": "x", "priority": 3},
        {"title": "x", "difficulty": True},
        {"title": ""},
        {"title": "x" * 121},
        {"title": "ok", "description": "d" * 2001},
    ]
    for body in invalid_bodies:
        response = client.post(TASKS_URL, json={"memberId": "m-lin", **body})
        assert response.status_code == 422, (body, response.text)

    # Unknown member / member of another group.
    assert (
        client.post(TASKS_URL, json={"memberId": "m-missing", "title": "x"}).status_code
        == 404
    )
    assert (
        client.post(TASKS_URL, json={"memberId": "m-zhou", "title": "x"}).status_code
        == 404
    )
    # Admin must specify the owner.
    assert client.post(TASKS_URL, json={"title": "x"}).status_code == 422

    # Empty expected date is accepted and does not affect scoring.
    empty = client.post(
        TASKS_URL,
        json={
            "memberId": "m-lin",
            "title": "无预期日期",
            "priority": "urgent",
            "difficulty": "easy",
            "expectedDate": "",
        },
    )
    assert empty.status_code == 200
    empty_task = empty.json()["data"]["task"]
    assert empty_task["expectedDate"] == ""
    assert empty_task["loadPoints"] == 4


# --------------------------------------------------------------------------- workload math


def test_workload_points_current_average_and_percent(client):
    member_id = _create_member(client)

    # A brand-new member is present with a zero workload.
    zero = _workload_for(client, member_id)
    assert zero["currentPoints"] == 0
    assert zero["averagePoints"] == 0.0
    assert zero["currentLoadPercent"] == 0
    assert zero["averageLoadPercent"] == 0
    assert zero["level"] == "low"
    assert zero["capacityPoints"] == 15
    assert zero["windowWeeks"] == 4

    first = client.post(
        TASKS_URL,
        json={
            "memberId": member_id,
            "title": "任务 A",
            "priority": "urgent",
            "difficulty": "hard",  # 6 points
        },
    )
    assert first.status_code == 200
    a_id = first.json()["data"]["task"]["id"]
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 6
    assert workload["currentLoadPercent"] == 40
    # A task created now can only be active in the most recent of the 4 windows.
    assert workload["averagePoints"] == 1.5
    assert workload["averageLoadPercent"] == 10
    assert workload["openTasks"] == 1
    assert workload["completedTasks"] == 0
    assert workload["level"] == "low"

    second = client.post(
        TASKS_URL,
        json={
            "memberId": member_id,
            "title": "任务 B",
            "priority": "normal",
            "difficulty": "easy",  # 2 points
            "progressStatus": "completed",
        },
    )
    assert second.status_code == 200
    assert second.json()["data"]["task"]["completedAt"]
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 6
    assert workload["completedTasks"] == 1
    assert workload["averagePoints"] == 2.0  # (6 + 2) / 4 windows
    assert workload["averageLoadPercent"] == 13

    # Completing the open task removes it from current load but keeps its window history.
    completed = client.patch(f"{TASKS_URL}/{a_id}", json={"progressStatus": "completed"})
    assert completed.status_code == 200
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 0
    assert workload["currentLoadPercent"] == 0
    assert workload["openTasks"] == 0
    assert workload["completedTasks"] == 2
    assert workload["averagePoints"] == 2.0

    # Re-opening restores the current load.
    reopened = client.patch(f"{TASKS_URL}/{a_id}", json={"progressStatus": "in_progress"})
    assert reopened.status_code == 200
    assert _workload_for(client, member_id)["currentPoints"] == 6


def test_workload_average_uses_rolling_windows(client):
    member_id = _create_member(client, "负载乙", "loadtest2@corp.example")

    # Contribution per window: A 3pt x 3 windows, B 4pt x 2 windows, C 6pt x 1 window,
    # D completed before the 4-week window (0 windows).
    _insert_task(
        member_id, "task-window-a", priority="normal", difficulty="medium",
        created_days_ago=20,
    )
    _insert_task(
        member_id, "task-window-b", priority="high", difficulty="medium",
        created_days_ago=10, completed_days_ago=5, progress_status="completed",
    )
    _insert_task(
        member_id, "task-window-c", priority="urgent", difficulty="hard",
        created_days_ago=2,
    )
    _insert_task(
        member_id, "task-window-d", priority="low", difficulty="easy",
        created_days_ago=40, completed_days_ago=30, progress_status="completed",
    )

    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 9  # A (3) + C (6) are open
    assert workload["currentLoadPercent"] == 60
    assert workload["averagePoints"] == 5.8  # (3*3 + 4*2 + 6) / 4 = 5.75 -> 5.8
    assert workload["averageLoadPercent"] == 38
    assert workload["level"] == "low"
    assert workload["openTasks"] == 2
    assert workload["completedTasks"] == 2

    # Blocked/overdue counts only consider open tasks.
    _insert_task(
        member_id, "task-window-e", priority="urgent", difficulty="hard",
        created_days_ago=1, completed_days_ago=0, progress_status="completed",
        health_status="blocked", expected_offset=-10,
    )
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 9
    assert workload["blockedTasks"] == 0
    assert workload["overdueTasks"] == 0


def test_migration_adds_priority_difficulty_and_backfills(tmp_path, monkeypatch):
    """A v1 ``member_tasks`` table is upgraded in place with deterministic backfill."""
    import backend.app.db as db_module

    monkeypatch.setattr(db_module, "DB_PATH", tmp_path / "legacy-teamstudio.db")
    init_db()
    assert seed_if_empty() is True

    legacy_sql = (
        "CREATE TABLE member_tasks ("
        "id TEXT PRIMARY KEY,"
        "group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,"
        "member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,"
        "title TEXT NOT NULL,"
        "description TEXT NOT NULL DEFAULT '',"
        "progress_status TEXT NOT NULL DEFAULT 'pending',"
        "health_status TEXT NOT NULL DEFAULT 'normal',"
        "expected_date TEXT NOT NULL DEFAULT '',"
        "effort_hours REAL NOT NULL DEFAULT 8,"
        "created_by TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL,"
        "updated_at TEXT NOT NULL,"
        "completed_at TEXT"
        ")"
    )
    stamp = "2026-10-01T10:00:00+08:00"
    legacy_rows = [
        # id, effort, health, progress, expected_date, expected difficulty/priority
        ("legacy-easy", 4.0, "normal", "pending", "", "easy", "low"),
        ("legacy-delayed", 8.0, "delayed", "in_progress", "", "medium", "high"),
        ("legacy-blocked", 14.0, "blocked", "pending", "", "hard", "urgent"),
        ("legacy-hard-normal", 20.0, "normal", "completed", "", "hard", "normal"),
        ("legacy-late", 8.0, "normal", "pending", _days_from_today(-2), "medium", "high"),
    ]
    with db() as conn:
        conn.execute("DROP TABLE member_tasks")
        conn.execute(legacy_sql)
        for task_id, effort, health, progress, expected, _difficulty, _priority in legacy_rows:
            conn.execute(
                "INSERT INTO member_tasks (id,group_id,member_id,title,progress_status,"
                "health_status,expected_date,effort_hours,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    task_id,
                    GROUP_ID,
                    "m-lin",
                    task_id,
                    progress,
                    health,
                    expected,
                    effort,
                    stamp,
                    stamp,
                ),
            )

    init_db()  # runs the additive migration + backfill

    with db() as conn:
        columns = {
            str(info[1]) for info in conn.execute("PRAGMA table_info(member_tasks)")
        }
        assert {"priority", "difficulty", "effort_hours"} <= columns
        migrated = {row["id"]: row for row in rows(conn, "SELECT * FROM member_tasks")}

    for task_id, _effort, _health, _progress, _expected, difficulty, priority in legacy_rows:
        assert migrated[task_id]["difficulty"] == difficulty, task_id
        assert migrated[task_id]["priority"] == priority, task_id

    # Idempotent: another init_db leaves the backfilled values untouched.
    init_db()
    with db() as conn:
        again = {row["id"]: row for row in rows(conn, "SELECT * FROM member_tasks")}
    for task_id, *_ in legacy_rows:
        assert again[task_id]["priority"] == migrated[task_id]["priority"]
        assert again[task_id]["difficulty"] == migrated[task_id]["difficulty"]


# --------------------------------------------------------------------------- overview / ordering


def test_overview_includes_workloads_without_breaking_other_fields(client):
    response = client.get(OVERVIEW_URL)
    assert response.status_code == 200
    data = response.json()["data"]

    # Existing fields remain intact.
    assert data["group"]["id"] == GROUP_ID
    assert data["members"]
    assert data["works"]
    assert data["recentActivity"]
    assert data["stats"]["members"] == len(data["members"])
    assert "status" in data["members"][0]

    workloads = data["workloads"]
    summary = data["workloadSummary"]
    assert len(workloads) == len(data["members"])
    assert [item["memberId"] for item in workloads] == [
        member["id"] for member in data["members"]
    ]
    assert workloads[0]["level"] in {"low", "balanced", "high", "overload"}
    assert "currentHours" not in workloads[0]
    for legacy in ("currentHours", "averageHours", "capacityHours"):
        assert legacy not in summary

    tasks_payload = client.get(TASKS_URL).json()["data"]
    assert summary["members"] == len(workloads)
    assert summary["tasks"] == len(tasks_payload["tasks"])
    assert summary["capacityPoints"] == 15
    assert summary["windowWeeks"] == 4
    assert isinstance(summary["currentPoints"], int)
    assert isinstance(summary["averagePoints"], float)
    assert isinstance(summary["averageLoadPercent"], int)


def test_tasks_sorted_by_member_health_and_expected_date(client):
    tasks = client.get(TASKS_URL).json()["data"]["tasks"]

    member_order = [item["memberId"] for item in tasks]
    first_seen = list(dict.fromkeys(member_order))
    assert first_seen == ["m-lin", "m-chen", "m-su", "m-he", "m-tang"]

    chen_tasks = [item for item in tasks if item["memberId"] == "m-chen"]
    assert [item["id"] for item in chen_tasks][0] == "task-seed-m-chen-02"
    assert chen_tasks[0]["healthStatus"] == "blocked"


def test_zero_task_members_are_included(client):
    data = client.get(TASKS_URL).json()["data"]
    member_ids = {item["memberId"] for item in data["workloads"]}
    assert member_ids == {"m-lin", "m-chen", "m-su", "m-he", "m-tang"}
    assert data["summary"]["members"] == 5
