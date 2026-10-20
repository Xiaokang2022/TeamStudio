"""Tests for the data insights dashboard API (``#12``).

The payload must match ``web/src/types.ts`` exactly (``InsightsData``), use 0-100 integer
rates, honour the scope/range query parameters and apply the documented active-window
semantics.
"""

from __future__ import annotations

from datetime import datetime, timedelta

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}"
INSIGHTS_URL = f"{BASE}/insights"

MEMBER_ROW_KEYS = {
    "memberId",
    "memberName",
    "memberTitle",
    "avatarColor",
    "teamId",
    "teamName",
    "groupId",
    "groupName",
    "tasks",
    "openTasks",
    "completedTasks",
    "overdueTasks",
    "blockedTasks",
    "completionRate",
    "loadPoints",
    "todos",
    "completedTodos",
}
GROUP_ROW_KEYS = {
    "groupId",
    "groupName",
    "teamId",
    "teamName",
    "color",
    "members",
    "tasks",
    "openTasks",
    "completedTasks",
    "overdueTasks",
    "blockedTasks",
    "completionRate",
    "loadPoints",
    "averageLoadPercent",
    "todos",
    "completedTodos",
}
TEAM_ROW_KEYS = {
    "teamId",
    "teamName",
    "color",
    "groups",
    "members",
    "tasks",
    "openTasks",
    "completedTasks",
    "overdueTasks",
    "completionRate",
    "loadPoints",
}
SUMMARY_KEYS = {
    "teams",
    "groups",
    "members",
    "tasks",
    "openTasks",
    "completedTasks",
    "overdueTasks",
    "blockedTasks",
    "completionRate",
    "todos",
    "completedTodos",
    "todoCompletionRate",
    "loadPoints",
    "capacityPoints",
    "averageLoadPercent",
}


def _data(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["data"]


def _iso_days_ago(days: float) -> str:
    moment = datetime.now().astimezone() - timedelta(days=days)
    return moment.isoformat(timespec="seconds")


def _insert_task(
    task_id: str,
    *,
    progress_status: str,
    created_days_ago: float,
    completed_days_ago: float | None = None,
    health_status: str = "normal",
) -> None:
    from backend.app.db import db

    created = _iso_days_ago(created_days_ago)
    completed = _iso_days_ago(completed_days_ago) if completed_days_ago is not None else None
    with db() as conn:
        conn.execute(
            "INSERT INTO member_tasks (id,group_id,member_id,title,description,"
            "progress_status,health_status,priority,difficulty,expected_date,created_by,"
            "created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id,
                GROUP_ID,
                "m-lin",
                f"洞察窗口 {task_id}",
                "",
                progress_status,
                health_status,
                "normal",
                "medium",
                "",
                "Admin",
                created,
                created,
                completed,
            ),
        )


def test_insights_structure_matches_frontend_contract(client):
    data = _data(client.get(INSIGHTS_URL))
    assert set(data) == {"scope", "range", "summary", "members", "groups", "teams", "trend"}
    assert data["scope"]["kind"] == "group"
    assert data["range"]["key"] == "1m"
    assert set(data["range"]) == {"key", "label", "days", "start"}
    assert data["range"]["label"] == "近 1 个月"
    assert data["range"]["days"] == 30
    assert data["range"]["start"]

    assert set(data["summary"]) == SUMMARY_KEYS
    for key in ("completionRate", "todoCompletionRate", "averageLoadPercent"):
        assert isinstance(data["summary"][key], int)
        assert 0 <= data["summary"][key] <= 100

    assert data["members"] and data["groups"] and data["teams"]
    assert set(data["members"][0]) == MEMBER_ROW_KEYS
    assert set(data["groups"][0]) == GROUP_ROW_KEYS
    assert set(data["teams"][0]) == TEAM_ROW_KEYS

    assert data["groups"][0]["groupId"] == GROUP_ID
    assert data["groups"][0]["teamName"] == "极光产品团队"
    assert data["teams"][0]["teamId"] == TEAM_ID
    assert data["trend"]["granularity"] == "week"
    point = data["trend"]["buckets"][0]
    assert set(point) == {"label", "start", "created", "completed", "todos"}
    for row in data["members"]:
        if row["tasks"]:
            assert row["completionRate"] == round(
                row["completedTasks"] / row["tasks"] * 100
            )
        assert 0 <= row["completionRate"] <= 100
        for key in ("tasks", "openTasks", "completedTasks", "overdueTasks", "blockedTasks", "todos"):
            assert isinstance(row[key], int)


def test_range_windows_and_trend_granularity(client):
    expectations = {
        "1w": ("day", 7, 7),
        "2w": ("day", 14, 14),
        "1m": ("week", 30, 5),
        "2m": ("week", 60, 9),
        "3m": ("week", 90, 13),
        "all": ("week", None, 26),
    }
    for range_key, (granularity, days, buckets) in expectations.items():
        data = _data(client.get(f"{INSIGHTS_URL}?range={range_key}"))
        assert data["range"]["key"] == range_key
        assert data["range"]["days"] == days
        assert data["range"]["start"] is None if days is None else bool(data["range"]["start"])
        assert data["trend"]["granularity"] == granularity, range_key
        assert len(data["trend"]["buckets"]) == buckets, range_key
        starts = [point["start"] for point in data["trend"]["buckets"]]
        assert starts == sorted(starts), range_key


def test_scope_and_range_aggregate_totals(client):
    group_all = _data(client.get(f"{INSIGHTS_URL}?range=all"))
    assert group_all["scope"]["kind"] == "group"
    assert group_all["summary"]["tasks"] == 14
    assert group_all["summary"]["members"] == 5
    assert group_all["summary"]["groups"] == 1
    assert group_all["summary"]["teams"] == 1
    assert group_all["summary"]["capacityPoints"] == 5 * 15
    assert len(group_all["members"]) == 5

    all_scope = _data(client.get(f"{INSIGHTS_URL}?scope=all&range=all"))
    assert all_scope["scope"]["kind"] == "all"
    assert all_scope["summary"]["tasks"] == 49
    assert all_scope["summary"]["members"] == 18
    assert all_scope["summary"]["groups"] == 5
    assert all_scope["summary"]["teams"] == 2
    assert {row["teamId"] for row in all_scope["teams"]} == {
        "team-aurora",
        "team-voyage",
    }

    team_scope = _data(client.get(f"{INSIGHTS_URL}?scope=team&range=all"))
    assert team_scope["scope"]["kind"] == "team"
    assert team_scope["summary"]["teams"] == 1
    assert team_scope["summary"]["groups"] == 3
    assert 0 < team_scope["summary"]["tasks"] < all_scope["summary"]["tasks"]


def test_active_window_filters_completed_and_keeps_open_tasks(client):
    baseline = {
        key: _data(client.get(f"{INSIGHTS_URL}?range={key}"))["summary"]["tasks"]
        for key in ("1w", "1m", "3m", "all")
    }

    # Created and completed long ago -> only active in the 3-month/all windows.
    _insert_task(
        "task-insight-old-completed",
        progress_status="completed",
        created_days_ago=40,
        completed_days_ago=35,
    )
    after_completed = {
        key: _data(client.get(f"{INSIGHTS_URL}?range={key}"))["summary"]["tasks"]
        for key in ("1w", "1m", "3m", "all")
    }
    assert after_completed["1w"] == baseline["1w"]
    assert after_completed["1m"] == baseline["1m"]
    assert after_completed["3m"] == baseline["3m"] + 1
    assert after_completed["all"] == baseline["all"] + 1

    # An old but still open task is active in every window.
    _insert_task(
        "task-insight-old-open",
        progress_status="pending",
        created_days_ago=40,
    )
    after_open = {
        key: _data(client.get(f"{INSIGHTS_URL}?range={key}"))["summary"]["tasks"]
        for key in ("1w", "1m", "3m", "all")
    }
    assert after_open["1w"] == baseline["1w"] + 1
    assert after_open["1m"] == baseline["1m"] + 1
    assert after_open["3m"] == baseline["3m"] + 2
    assert after_open["all"] == baseline["all"] + 2


def test_members_without_window_activity_are_omitted(client):
    from backend.app.db import db, new_id

    member_id = new_id("member")
    with db() as conn:
        conn.execute(
            "INSERT INTO members (id,team_id,group_id,external_id,name,email,title,role,"
            "avatar_color,bio,tags,skills,status,joined_at,sort_order,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                member_id,
                TEAM_ID,
                GROUP_ID,
                "",
                "空成员",
                "empty@corp.example",
                "观察员",
                "成员",
                "#5865f2",
                "",
                "[]",
                "[]",
                "available",
                "",
                99,
                _iso_days_ago(0),
                _iso_days_ago(0),
            ),
        )
    data = _data(client.get(f"{INSIGHTS_URL}?range=all"))
    assert all(row["memberId"] != member_id for row in data["members"])
    assert data["summary"]["members"] == 5


def test_trend_sums_match_totals_for_all_range(client):
    data = _data(client.get(f"{INSIGHTS_URL}?scope=all&range=all"))
    buckets = data["trend"]["buckets"]
    summary = data["summary"]
    assert sum(point["created"] for point in buckets) == summary["tasks"]
    assert sum(point["completed"] for point in buckets) == summary["completedTasks"]
    assert sum(point["todos"] for point in buckets) == summary["todos"]
    assert len(buckets) == 26


def test_invalid_range_is_rejected(client):
    response = client.get(f"{INSIGHTS_URL}?range=12m")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_range"


def test_guest_can_read_insights(guest_client):
    data = _data(guest_client.get(f"{INSIGHTS_URL}?scope=team&range=2w"))
    assert data["scope"]["kind"] == "team"
    assert data["range"]["key"] == "2w"
    assert isinstance(data["summary"]["tasks"], int)
