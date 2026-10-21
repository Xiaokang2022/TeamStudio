"""Member task ledger, permissions and point-based workload (team scoped).

The workload model is unchanged by round 8: ``loadPoints = 1 + priority bonus +
difficulty bonus`` with a capacity of ``15`` points per member over a rolling 4-week
window. Only the URL scope changed (no ``group_id``/``scope``) and every task payload now
carries ``memberAvatar`` and ``teamId`` instead of group fields.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from backend.app.db import db, scalar
from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    assert_error,
    create_account,
    create_member,
    data,
    email_login,
    error,
    me,
    member_by_email,
    members_of,
    overview,
    remote_client,
    tasks_payload,
)

PRIORITY_BONUS = {"low": 0, "normal": 1, "high": 2, "urgent": 3}
DIFFICULTY_BONUS = {"easy": 0, "medium": 1, "hard": 2}
CAPACITY_POINTS = 15
WINDOW_WEEKS = 4
SEEDED_MEMBER_TASKS = 49


def _url(path: str, team_id: str = TEAM_AURORA) -> str:
    return f"/api/teams/{team_id}{path}"


def _tasks_url(team_id: str = TEAM_AURORA) -> str:
    return _url("/tasks", team_id)


def _days_from_today(offset: int) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


def _iso_days_ago(days: float) -> str:
    moment = datetime.now().astimezone() - timedelta(days=days)
    return moment.isoformat(timespec="seconds")


def _load_points(priority: str, difficulty: str) -> int:
    return 1 + PRIORITY_BONUS[priority] + DIFFICULTY_BONUS[difficulty]


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
    team_id: str = TEAM_AURORA,
) -> None:
    """Direct ledger insert with explicit timestamps, used for window math tests."""
    with db() as conn:
        created_at = _iso_days_ago(created_days_ago)
        completed_at = (
            _iso_days_ago(completed_days_ago) if completed_days_ago is not None else None
        )
        conn.execute(
            "INSERT INTO member_tasks (id,team_id,member_id,title,description,"
            "progress_status,health_status,priority,difficulty,expected_date,created_by,"
            "created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id,
                team_id,
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


def _workload_for(client, member_id: str) -> dict:
    payload = tasks_payload(client)
    for item in payload["workloads"]:
        if item["memberId"] == member_id:
            return item
    raise AssertionError(f"missing workload for {member_id}")


def _new_member(client, name: str, email: str) -> str:
    account = create_account(client, email, name=name)
    member = create_member(client, account["id"], title="测试工程师")
    return member["id"]


# --------------------------------------------------------------------------- read / seed


def test_guest_can_read_tasks(guest_client):
    payload = tasks_payload(guest_client)
    assert set(payload) >= {"tasks", "workloads", "summary", "meta"}
    assert payload["tasks"]

    assert payload["meta"]["capacityPoints"] == CAPACITY_POINTS
    assert payload["meta"]["windowWeeks"] == WINDOW_WEEKS
    assert payload["meta"]["windowLabel"] == "近 4 周"
    assert isinstance(payload["meta"]["scoring"], str) and payload["meta"]["scoring"]

    task = payload["tasks"][0]
    for key in (
        "id",
        "teamId",
        "teamName",
        "memberId",
        "memberName",
        "memberTitle",
        "memberAvatar",
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
        "tags",
    ):
        assert key in task, key
    for legacy in ("groupId", "groupName", "effortHours"):
        assert legacy not in task, legacy
    assert task["loadPoints"] == _load_points(task["priority"], task["difficulty"])

    workload = payload["workloads"][0]
    for key in (
        "memberId",
        "memberName",
        "memberTitle",
        "avatar",
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
        assert key in workload, key
    assert workload["capacityPoints"] == CAPACITY_POINTS
    assert workload["windowWeeks"] == WINDOW_WEEKS
    for legacy in ("currentHours", "averageHours", "capacityHours", "groupIds"):
        assert legacy not in workload


def test_seeded_ledger_and_backfill_helper(client):
    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM member_tasks") == SEEDED_MEMBER_TASKS

    from backend.app import seed as seed_module

    backfill = getattr(seed_module, "seed_member_tasks_if_empty", None)
    if backfill is not None:
        assert backfill() == 0


def test_seeded_tasks_cover_all_scoring_combinations(client):
    combinations: set[tuple[str, str]] = set()
    for team_id in (TEAM_AURORA, TEAM_VOYAGE):
        for task in tasks_payload(client, team_id)["tasks"]:
            assert task["priority"] in PRIORITY_BONUS
            assert task["difficulty"] in DIFFICULTY_BONUS
            assert task["loadPoints"] == _load_points(task["priority"], task["difficulty"])
            combinations.add((task["priority"], task["difficulty"]))
    assert combinations == {
        (priority, difficulty)
        for priority in PRIORITY_BONUS
        for difficulty in DIFFICULTY_BONUS
    }


def test_zero_task_members_are_included(client):
    payload = tasks_payload(client)
    member_ids = {item["memberId"] for item in payload["workloads"]}
    overview_ids = {item["id"] for item in members_of(client)}
    assert member_ids == overview_ids
    assert payload["summary"]["members"] == len(overview_ids)


# --------------------------------------------------------------------------- permissions


def test_guest_writes_are_denied(guest_client):
    created = guest_client.post(_tasks_url(), json={"title": "访客任务"})
    assert created.status_code == 401
    assert error(created)["code"] == "authentication_required"
    assert guest_client.patch(_url("/tasks/task-missing"), json={"title": "x"}).status_code == 401
    assert guest_client.delete(_url("/tasks/task-missing")).status_code == 401


def test_member_can_only_manage_own_tasks(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    lin = member_by_email(client, "lin.zhixia@corp.example")
    seeded_lin_task = next(
        task
        for task in tasks_payload(client)["tasks"]
        if task["memberId"] == lin["id"]
    )
    with remote_client("10.20.30.101", 51601) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert me(browser)["linkedMemberId"] == chen["id"]

        # Creating without memberId defaults to the linked member.
        created = data(
            browser.post(
                _tasks_url(),
                json={
                    "title": "我的任务",
                    "priority": "high",
                    "difficulty": "hard",
                    "expectedDate": _days_from_today(3),
                },
            )
        )["task"]
        assert created["memberId"] == chen["id"]
        assert created["loadPoints"] == _load_points("high", "hard")
        assert created["memberAvatar"] is not None

        # Cannot create for someone else.
        denied = browser.post(
            _tasks_url(), json={"memberId": lin["id"], "title": "越权任务"}
        )
        assert denied.status_code == 403

        # Can update and delete the own task.
        updated = data(
            browser.patch(
                _url(f"/tasks/{created['id']}"), json={"progressStatus": "completed"}
            )
        )["task"]
        assert updated["completedAt"]

        # Cannot update or delete another member's task.
        assert_error(
            browser.patch(_url(f"/tasks/{seeded_lin_task['id']}"), json={"title": "越权"}),
            403,
            "forbidden",
        )
        assert_error(browser.delete(_url(f"/tasks/{seeded_lin_task['id']}")), 403, "forbidden")

        deleted = data(browser.delete(_url(f"/tasks/{created['id']}")))
        assert deleted["deleted"] is True


def test_admin_manages_any_member_task(client):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    created = data(
        client.post(
            _tasks_url(),
            json={
                "memberId": lin["id"],
                "title": "管理员创建的任务",
                "description": "覆盖完整字段",
                "progressStatus": "in_progress",
                "healthStatus": "delayed",
                "priority": "high",
                "difficulty": "hard",
                "expectedDate": _days_from_today(3),
            },
        )
    )["task"]
    task_id = created["id"]
    assert created["memberId"] == lin["id"]
    assert created["progressStatus"] == "in_progress"
    assert created["healthStatus"] == "delayed"
    assert created["loadPoints"] == _load_points("high", "hard")
    assert created["teamId"] == TEAM_AURORA
    assert created["completedAt"] is None

    completed = data(
        client.patch(_url(f"/tasks/{task_id}"), json={"progressStatus": "completed"})
    )["task"]
    assert completed["completedAt"]
    reopened = data(
        client.patch(_url(f"/tasks/{task_id}"), json={"progressStatus": "pending"})
    )["task"]
    assert reopened["completedAt"] is None

    rescored = data(
        client.patch(_url(f"/tasks/{task_id}"), json={"priority": "urgent", "difficulty": "easy"})
    )["task"]
    assert rescored["loadPoints"] == 4

    overdue = data(
        client.patch(
            _url(f"/tasks/{task_id}"),
            json={"healthStatus": "blocked", "expectedDate": _days_from_today(-4)},
        )
    )["task"]
    assert overdue["overdue"] is True

    assert data(client.delete(_url(f"/tasks/{task_id}")))["deleted"] is True
    assert_error(client.delete(_url(f"/tasks/{task_id}")), 404, "task_not_found")
    assert_error(client.patch(_url(f"/tasks/{task_id}"), json={"title": "x"}), 404, "task_not_found")


def test_task_validation_and_scoring_formula(client):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    for priority in PRIORITY_BONUS:
        for difficulty in DIFFICULTY_BONUS:
            created = data(
                client.post(
                    _tasks_url(),
                    json={
                        "memberId": lin["id"],
                        "title": f"{priority}/{difficulty}",
                        "priority": priority,
                        "difficulty": difficulty,
                    },
                )
            )["task"]
            assert created["loadPoints"] == _load_points(priority, difficulty)

    defaulted = data(
        client.post(_tasks_url(), json={"memberId": lin["id"], "title": "默认分值"})
    )["task"]
    assert defaulted["priority"] == "normal"
    assert defaulted["difficulty"] == "medium"
    assert defaulted["loadPoints"] == 3

    invalid_bodies = [
        {"title": "x", "expectedDate": "2026/10/01"},
        {"title": "x", "expectedDate": "2026-02-31"},
        {"title": "x", "progressStatus": "done"},
        {"title": "x", "healthStatus": "sick"},
        {"title": "x", "priority": "critical"},
        {"title": "x", "difficulty": "extreme"},
        {"title": ""},
        {"title": "x" * 121},
        {"title": "ok", "description": "d" * 2001},
    ]
    for body in invalid_bodies:
        response = client.post(_tasks_url(), json={"memberId": lin["id"], **body})
        assert response.status_code == 422, (body, response.text)

    # Unknown member and a member of another team are both 404 for this team.
    assert client.post(_tasks_url(), json={"memberId": "m-missing", "title": "x"}).status_code == 404
    voyage_member = members_of(client, TEAM_VOYAGE)[0]
    assert (
        client.post(_tasks_url(), json={"memberId": voyage_member["id"], "title": "x"}).status_code
        == 404
    )
    # A super admin must name the owner explicitly.
    assert client.post(_tasks_url(), json={"title": "x"}).status_code == 422


# --------------------------------------------------------------------------- workload math


def test_workload_points_current_average_and_percent(client):
    member_id = _new_member(client, "负载测试", "loadtest@corp.example")

    zero = _workload_for(client, member_id)
    assert zero["currentPoints"] == 0
    assert zero["averagePoints"] == 0.0
    assert zero["currentLoadPercent"] == 0
    assert zero["averageLoadPercent"] == 0
    assert zero["level"] == "low"
    assert zero["capacityPoints"] == CAPACITY_POINTS
    assert zero["windowWeeks"] == WINDOW_WEEKS

    first = data(
        client.post(
            _tasks_url(),
            json={
                "memberId": member_id,
                "title": "任务 A",
                "priority": "urgent",
                "difficulty": "hard",  # 6 points
            },
        )
    )["task"]
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 6
    assert workload["currentLoadPercent"] == 40
    assert workload["averagePoints"] == 1.5
    assert workload["averageLoadPercent"] == 10
    assert workload["openTasks"] == 1
    assert workload["level"] == "low"

    data(
        client.post(
            _tasks_url(),
            json={
                "memberId": member_id,
                "title": "任务 B",
                "priority": "normal",
                "difficulty": "easy",  # 2 points
                "progressStatus": "completed",
            },
        )
    )
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 6
    assert workload["completedTasks"] == 1
    assert workload["averagePoints"] == 2.0
    assert workload["averageLoadPercent"] == 13

    data(client.patch(_url(f"/tasks/{first['id']}"), json={"progressStatus": "completed"}))
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 0
    assert workload["openTasks"] == 0
    assert workload["completedTasks"] == 2
    assert workload["averagePoints"] == 2.0

    data(client.patch(_url(f"/tasks/{first['id']}"), json={"progressStatus": "in_progress"}))
    assert _workload_for(client, member_id)["currentPoints"] == 6


def test_workload_average_uses_rolling_windows(client):
    member_id = _new_member(client, "负载乙", "loadtest2@corp.example")

    _insert_task(member_id, "task-window-a", priority="normal", difficulty="medium", created_days_ago=20)
    _insert_task(
        member_id,
        "task-window-b",
        priority="high",
        difficulty="medium",
        created_days_ago=10,
        completed_days_ago=5,
        progress_status="completed",
    )
    _insert_task(member_id, "task-window-c", priority="urgent", difficulty="hard", created_days_ago=2)
    _insert_task(
        member_id,
        "task-window-d",
        priority="low",
        difficulty="easy",
        created_days_ago=40,
        completed_days_ago=30,
        progress_status="completed",
    )

    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 9  # A (3) + C (6) are open
    assert workload["currentLoadPercent"] == 60
    assert workload["averagePoints"] == 5.8  # (3*3 + 4*2 + 6) / 4 = 5.75 -> 5.8
    assert workload["averageLoadPercent"] == 38
    assert workload["openTasks"] == 2
    assert workload["completedTasks"] == 2

    _insert_task(
        member_id,
        "task-window-e",
        priority="urgent",
        difficulty="hard",
        created_days_ago=1,
        completed_days_ago=0,
        progress_status="completed",
        health_status="blocked",
        expected_offset=-10,
    )
    workload = _workload_for(client, member_id)
    assert workload["currentPoints"] == 9
    assert workload["blockedTasks"] == 0
    assert workload["overdueTasks"] == 0


# --------------------------------------------------------------------------- overview integration


def test_overview_includes_workloads_without_breaking_other_fields(client):
    payload = overview(client)
    assert payload["team"]["id"] == TEAM_AURORA
    assert payload["members"]
    assert payload["works"]
    assert payload["stats"]["members"] == len(payload["members"])

    workloads = payload["workloads"]
    summary = payload["workloadSummary"]
    assert len(workloads) == len(payload["members"])
    for item in workloads:
        assert item["level"] in {"low", "balanced", "high", "overload"}
        assert "avatar" in item
    assert summary["members"] == len(workloads)
    assert summary["tasks"] == len(tasks_payload(client)["tasks"])
    assert summary["capacityPoints"] == CAPACITY_POINTS
    assert summary["windowWeeks"] == WINDOW_WEEKS
