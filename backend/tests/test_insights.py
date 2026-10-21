"""Team insights dashboard (round 8 removes the group/team comparison tables)."""

from __future__ import annotations

from datetime import datetime, timedelta

from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    data,
    error,
    insights_payload,
    member_by_email,
)

INSIGHTS_URL = f"/api/teams/{TEAM_AURORA}/insights"

MEMBER_ROW_KEYS = {
    "memberId",
    "memberName",
    "memberTitle",
    "avatar",
    "avatarColor",
    "teamId",
    "teamName",
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
SUMMARY_KEYS = {
    "teams",
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
TREND_KEYS = {"granularity", "buckets"}
BUCKET_KEYS = {"label", "start", "created", "completed", "todos"}
SEEDED_MEMBER_TASKS = 49


def _iso_days_ago(days: float) -> str:
    moment = datetime.now().astimezone() - timedelta(days=days)
    return moment.isoformat(timespec="seconds")


def _insert_task(
    task_id: str,
    *,
    member_id: str,
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
            "INSERT INTO member_tasks (id,team_id,member_id,title,description,"
            "progress_status,health_status,priority,difficulty,expected_date,created_by,"
            "created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id,
                TEAM_AURORA,
                member_id,
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


def _seed_member_id(client) -> str:
    return member_by_email(client, "lin.zhixia@corp.example")["id"]


# --------------------------------------------------------------------------- structure


def test_insights_structure_matches_frontend_contract(client):
    payload = insights_payload(client)
    assert set(payload) == {"range", "summary", "members", "trend"}
    # Group/team comparison tables are gone in the team-only view.
    assert "groups" not in payload
    assert "teams" not in payload

    assert payload["range"]["key"] == "1m"
    assert set(payload["range"]) >= {"key", "label", "days", "start"}
    assert payload["range"]["days"] == 30

    assert set(payload["summary"]) == SUMMARY_KEYS
    assert "groups" not in payload["summary"]
    assert payload["summary"]["teams"] == 1
    for key in ("completionRate", "todoCompletionRate", "averageLoadPercent"):
        assert isinstance(payload["summary"][key], int)
        assert 0 <= payload["summary"][key] <= 100

    assert payload["members"]
    assert set(payload["members"][0]) == MEMBER_ROW_KEYS
    for row in payload["members"]:
        assert row["teamId"] == TEAM_AURORA
        assert "avatar" in row
        assert isinstance(row["tasks"], int)
        if row["tasks"]:
            assert row["completionRate"] == round(
                row["completedTasks"] / row["tasks"] * 100
            )

    assert set(payload["trend"]) == TREND_KEYS
    assert payload["trend"]["granularity"] in {"day", "week"}
    assert payload["trend"]["buckets"]
    assert set(payload["trend"]["buckets"][0]) == BUCKET_KEYS


def test_range_windows_and_trend_granularity(client):
    expectations = {
        "1w": ("day", 7),
        "2w": ("day", 14),
        "1m": ("week", 30),
        "2m": ("week", 60),
        "3m": ("week", 90),
        "all": ("week", None),
    }
    for range_key, (granularity, days) in expectations.items():
        payload = insights_payload(client, range_key=range_key)
        assert payload["range"]["key"] == range_key
        assert payload["range"]["days"] == days
        assert payload["trend"]["granularity"] == granularity, range_key
        starts = [point["start"] for point in payload["trend"]["buckets"]]
        assert starts == sorted(starts), range_key


def test_invalid_range_is_rejected(client):
    response = client.get(f"{INSIGHTS_URL}?range=12m")
    assert response.status_code == 422
    assert error(response)["code"] == "invalid_range"


# --------------------------------------------------------------------------- totals


def test_team_totals_split_the_seeded_ledger(client):
    aurora = insights_payload(client, range_key="all")
    voyage = insights_payload(client, TEAM_VOYAGE, range_key="all")

    assert aurora["summary"]["tasks"] + voyage["summary"]["tasks"] == SEEDED_MEMBER_TASKS
    assert 0 < aurora["summary"]["tasks"] < SEEDED_MEMBER_TASKS
    assert aurora["summary"]["members"] >= 1
    assert voyage["summary"]["members"] >= 1
    assert aurora["summary"]["capacityPoints"] == aurora["summary"]["members"] * 15

    # The scoped member rows only contain members of the requested team.
    aurora_member_ids = {
        member["id"]
        for member in data(client.get(f"/api/teams/{TEAM_AURORA}/overview"))["members"]
    }
    assert {row["memberId"] for row in aurora["members"]} <= aurora_member_ids


def test_trend_sums_match_totals_for_all_range(client):
    payload = insights_payload(client, range_key="all")
    buckets = payload["trend"]["buckets"]
    summary = payload["summary"]
    assert sum(point["created"] for point in buckets) == summary["tasks"]
    assert sum(point["completed"] for point in buckets) == summary["completedTasks"]


def test_active_window_filters_completed_and_keeps_open_tasks(client):
    member_id = _seed_member_id(client)
    baseline = {
        key: insights_payload(client, range_key=key)["summary"]["tasks"]
        for key in ("1w", "1m", "3m", "all")
    }

    # Created and completed long ago -> only active in the 3-month/all windows.
    _insert_task(
        "task-insight-old-completed",
        progress_status="completed",
        created_days_ago=40,
        completed_days_ago=35,
        member_id=member_id,
    )
    after_completed = {
        key: insights_payload(client, range_key=key)["summary"]["tasks"]
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
        member_id=member_id,
    )
    after_open = {
        key: insights_payload(client, range_key=key)["summary"]["tasks"]
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
            "INSERT INTO members (id,team_id,external_id,name,email,title,role,"
            "avatar_color,bio,tags,skills,joined_at,sort_order,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                member_id,
                TEAM_AURORA,
                "",
                "空成员",
                "empty@corp.example",
                "观察员",
                "成员",
                "#5865f2",
                "",
                "[]",
                "[]",
                "",
                99,
                _iso_days_ago(0),
                _iso_days_ago(0),
            ),
        )
    payload = insights_payload(client, range_key="all")
    assert all(row["memberId"] != member_id for row in payload["members"])


def test_guest_can_read_insights(guest_client):
    payload = insights_payload(guest_client, range_key="2w")
    assert payload["range"]["key"] == "2w"
    assert isinstance(payload["summary"]["tasks"], int)
    assert "groups" not in payload
