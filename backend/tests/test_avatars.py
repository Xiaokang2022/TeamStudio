"""Round-8 requirements #1/#2/#3: no member status, avatars everywhere, name sorting.

A dedicated probe account receives a real uploaded avatar; the tests then assert that the
avatar URL propagates to every member-bearing payload (overview, tasks, todos, red/black
board, responsibility matrix, announcements, insights, profile, candidates).
"""

from __future__ import annotations

import json

import pytest

from backend.tests.helpers import (
    TEAM_AURORA,
    create_account,
    create_member,
    data,
    email_login,
    member_by_email,
    members_of,
    overview,
    remote_client,
    tasks_payload,
    insights_payload,
    upload_avatar,
)

PROBE_EMAIL = "avatar.probe@corp.example"


def _url(path: str) -> str:
    return f"/api/teams/{TEAM_AURORA}{path}"


@pytest.fixture()
def probe(client, monkeypatch):
    """A team-admin member with a real uploaded avatar."""
    account = create_account(
        client, PROBE_EMAIL, name="头像探针", role="team_admin", team_ids=[TEAM_AURORA]
    )
    member = create_member(client, account["id"], title="体验负责人")
    with remote_client("10.20.30.120", 51501) as browser:
        email_login(browser, PROBE_EMAIL, monkeypatch)
        avatar = upload_avatar(browser)
        yield {
            "client": client,
            "browser": browser,
            "account": account,
            "member": member,
            "avatar": avatar,
        }


# --------------------------------------------------------------------------- members / sorting


def test_member_cards_follow_sort_order_and_expose_groups(client):
    """Round 9 requirement #3/#8: manual order plus group id/name on every card."""
    members = members_of(client)
    sort_orders = [member["sortOrder"] for member in members]
    assert sort_orders == sorted(sort_orders), sort_orders
    assert [member["id"] for member in members][:3] == ["m-lin", "m-chen", "m-su"]
    for member in members:
        assert "status" not in member, member["name"]
        assert "avatar" in member, member["name"]
        assert member["groupId"] == "", member["name"]
        assert member["groupName"] == "", member["name"]
        assert member["memberIds"] == [member["id"]]


def test_overview_workload_has_avatar(client):
    payload = overview(client)
    assert payload["workloads"]
    for workload in payload["workloads"]:
        assert "avatar" in workload
        assert "groupIds" not in workload


def test_probe_avatar_propagates_to_overview(probe):
    members = members_of(probe["client"])
    card = next(item for item in members if item["id"] == probe["member"]["id"])
    assert card["avatar"] == probe["avatar"]


# --------------------------------------------------------------------------- feature payloads


def test_task_payload_has_member_avatar(probe):
    created = data(
        probe["browser"].post(
            _url("/tasks"), json={"memberId": probe["member"]["id"], "title": "头像任务"}
        )
    )["task"]
    assert created["memberAvatar"] == probe["avatar"]
    assert created["memberAvatarColor"]
    # Round 9 requirement #8: tasks carry a (team) task group id, empty when ungrouped.
    assert created["groupId"] == ""
    listed = tasks_payload(probe["client"])
    listed_task = next(item for item in listed["tasks"] if item["id"] == created["id"])
    assert listed_task["memberAvatar"] == probe["avatar"]
    assert "avatar" in listed["workloads"][0]


def test_todo_payload_has_assignee_avatar(probe):
    from datetime import date, timedelta

    due = (date.today() + timedelta(days=3)).isoformat()
    todo = data(
        probe["browser"].post(
            _url("/todos"),
            json={
                "title": "头像待办",
                "dueDate": due,
                "assigneeMemberId": probe["member"]["id"],
            },
        )
    )["todo"]
    assert todo["assigneeAvatar"] == probe["avatar"]
    assert todo["assigneeColor"]
    assert "groupId" not in todo


def test_redblack_entries_have_member_avatar(probe):
    lin = member_by_email(probe["client"], "lin.zhixia@corp.example")
    body = {
        "month": "2033-01",
        "theme": "头像主题",
        "red": [
            {
                "memberId": probe["member"]["id"],
                "title": "高光",
                "reason": "头像",
                "score": 95,
            }
        ],
        "black": [],
    }
    board = data(probe["browser"].put(_url("/redblack"), json=body))["board"]
    entry = board["red"][0]
    assert entry["memberAvatar"] == probe["avatar"]
    assert "groupId" not in entry

    # Members without an uploaded image get an empty avatar string, never a missing key.
    data(
        probe["client"].put(
            _url("/redblack"),
            json={
                "month": "2033-02",
                "theme": "",
                "red": [
                    {
                        "memberId": lin["id"],
                        "title": "无图",
                        "reason": "-",
                        "score": 80,
                    }
                ],
                "black": [],
            },
        )
    )
    entry = data(probe["client"].get(_url("/redblack"), params={"month": "2033-02"}))[
        "board"
    ]["red"][0]
    assert entry["memberAvatar"] == ""


def test_matrix_owner_and_backups_have_avatars(probe):
    lin = member_by_email(probe["client"], "lin.zhixia@corp.example")
    area = data(
        probe["client"].post(
            _url("/matrix"),
            json={
                "area": "头像责任田",
                "ownerMemberId": probe["member"]["id"],
                "backupMemberIds": [lin["id"]],
            },
        )
    )["area"]
    assert area["ownerAvatar"] == probe["avatar"]
    assert area["backups"] and set(area["backups"][0]) >= {"id", "name", "color", "avatar"}
    assert area["backups"][0]["avatar"] == ""
    assert "backupAvatar" in area
    assert "groupId" not in area

    # The backup dropdown consumes the same payload after re-listing.
    listed = next(
        item
        for item in data(probe["client"].get(_url("/matrix")))["areas"]
        if item["id"] == area["id"]
    )
    assert listed["ownerAvatar"] == probe["avatar"]
    assert listed["backups"][0]["avatar"] == ""


def test_announcement_author_avatar(probe):
    announcement = data(
        probe["browser"].post(
            _url("/announcements"), json={"title": "头像公告", "content": "内容"}
        )
    )["announcement"]
    assert announcement["authorAvatar"] == probe["avatar"]
    assert "groupId" not in announcement

    listed = next(
        item
        for item in data(probe["client"].get(_url("/announcements")))["announcements"]
        if item["id"] == announcement["id"]
    )
    assert listed["authorAvatar"] == probe["avatar"]


def test_insights_member_rows_have_avatar(probe):
    # Members without window activity are omitted from the insights table, so the probe
    # needs one open task before its row shows up.
    data(
        probe["browser"].post(
            _url("/tasks"), json={"memberId": probe["member"]["id"], "title": "洞察头像任务"}
        )
    )
    payload = insights_payload(probe["client"])
    row = next(
        item for item in payload["members"] if item["memberId"] == probe["member"]["id"]
    )
    assert row["avatar"] == probe["avatar"]
    assert "groupId" not in row
    assert "groupName" not in row
    # No group/team comparison tables survive the team-only refactor (the summary keeps
    # its scalar ``teams`` count, but the per-group comparison rows are gone).
    assert "groups" not in payload
    assert "teams" not in payload
    assert "groups" not in payload["summary"]


def test_profile_payload_has_avatar(probe):
    profile = data(probe["browser"].get("/api/profile"))
    assert profile["user"]["avatar"] == probe["avatar"]
    member = next(
        item for item in profile["members"] if item["id"] == probe["member"]["id"]
    )
    assert member["avatar"] == probe["avatar"]
    assert "status" not in member


def test_member_candidates_expose_avatar_key(client):
    candidates = data(client.get(_url("/member-candidates")))["candidates"]
    assert candidates
    for candidate in candidates:
        assert "avatar" in candidate


# --------------------------------------------------------------------------- legacy keys


def test_member_payloads_expose_round9_group_fields_without_legacy_ones(client):
    """Round 9 requirement #8 replaces the removed group *tags* with team groups.

    Overview member cards now legitimately carry ``groupId``/``groupName`` (empty until
    grouped); the legacy plural group tag fields must still never leak back.
    """
    payloads = {
        "overview": overview(client),
        "tasks": tasks_payload(client),
        "insights": insights_payload(client),
    }
    for name, payload in payloads.items():
        serialized = json.dumps(payload, ensure_ascii=False)
        for legacy in ("groupIds", "groupNames"):
            assert legacy not in serialized, (name, legacy)
    for member in payloads["overview"]["members"]:
        assert member["groupId"] == "", member.get("name")
        assert member["groupName"] == "", member.get("name")
        assert "status" not in member, member.get("name")
    for name in ("tasks", "insights"):
        for member in payloads[name].get("members", []):
            if "memberIds" in member:
                assert "status" not in member, (name, member.get("name"))
