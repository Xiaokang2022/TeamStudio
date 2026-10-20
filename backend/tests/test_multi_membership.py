"""Round-7 multi-development-group membership tests (``docs/ROUND7_CONTRACT.md``).

One registered account may own a ``members`` archive row in several development groups
(and across teams). Aggregate reads (``scope=team|all``) must merge those rows into one
person, while single-group views and their numbers stay untouched. The workspace
bootstrap resolves ``me.linkedMemberId`` against the *active* development group and the
write permissions must accept every archive row of the account.

Fixtures come from ``conftest.py``: ``client`` is the loopback device Admin and
``guest_client`` is a remote guest (10.20.30.40), which lets a signed session cookie pick
up the seeded e-mail account. Temporary admin identities use
``app.dependency_overrides[get_current_user]`` like ``test_workspace_admin.py``.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, timedelta
from typing import Any, Iterator

from backend.app.auth import (
    CurrentUser,
    SessionIdentity,
    create_session_token,
    get_current_user,
)
from backend.app.db import db, new_id, now_iso
from backend.app.main import app
from backend.app.services import accounts

TEAM_ID = "team-aurora"
OTHER_TEAM_ID = "team-voyage"
GROUP_ID = "grp-frontend"
PLATFORM_GROUP_ID = "grp-platform"
DESIGN_GROUP_ID = "grp-design"
DATA_GROUP_ID = "grp-data"

BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}"
PLATFORM_BASE = f"/api/teams/{TEAM_ID}/groups/{PLATFORM_GROUP_ID}"
DESIGN_BASE = f"/api/teams/{TEAM_ID}/groups/{DESIGN_GROUP_ID}"
DATA_BASE = f"/api/teams/{OTHER_TEAM_ID}/groups/{DATA_GROUP_ID}"

SEEDED_ACCOUNT_ID = "lin.zhixia"
SEEDED_ACCOUNT_EMAIL = "lin.zhixia@corp.example"
SEEDED_MEMBER_ID = "m-lin"

NEW_ACCOUNT_EMAIL = "multi.member@corp.example"
NEW_ACCOUNT_NAME = "跨组同事"

MEMBERSHIP_KEYS = {
    "memberId",
    "groupId",
    "groupName",
    "teamId",
    "teamName",
    "title",
    "role",
    "status",
    "joinedAt",
}


# --------------------------------------------------------------------------- helpers


def _data(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["data"]


def _error(response) -> dict[str, Any]:
    body = response.json()
    assert body["ok"] is False, body
    return body["error"]


def _device_admin() -> CurrentUser:
    return CurrentUser(
        id="device-admin",
        name="Admin",
        authenticated=True,
        source="local",
        is_device_admin=True,
        admin_role="super",
    )


@contextmanager
def _as_user(user: CurrentUser) -> Iterator[None]:
    """Temporarily authenticate the shared test client as ``user``."""
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _create_account(email: str, name: str) -> dict[str, Any]:
    with db() as conn:
        return accounts.create_user(
            conn, email=email, name=name, email_verified=True, created_by="test"
        )


def _add_membership(
    client, base: str, user_id: str, *, title: str = "跨组成员"
) -> str:
    """Add ``user_id`` to the group behind ``base`` as an admin, returning the archive id."""
    with _as_user(_device_admin()):
        created = _data(
            client.post(f"{base}/members", json={"userId": user_id, "title": title})
        )
    return created["member"]["id"]


def _sign_in(client, account_id: str, email: str, name: str) -> None:
    identity = SessionIdentity(id=account_id, name=name, email=email)
    client.cookies.set("teamstudio_session", create_session_token(identity, 7))


def _tomorrow() -> str:
    return (date.today() + timedelta(days=1)).isoformat()


def _card(cards: list[dict[str, Any]], member_id: str) -> dict[str, Any]:
    """The single merged member card that contains ``member_id``."""
    matches = [card for card in cards if member_id in card.get("memberIds", [])]
    assert len(matches) == 1, (member_id, [card.get("id") for card in matches])
    return matches[0]


def _workload(workloads: list[dict[str, Any]], member_id: str) -> dict[str, Any]:
    matches = [item for item in workloads if member_id in item.get("memberIds", [])]
    assert len(matches) == 1, member_id
    return matches[0]


def _open_points(tasks: list[dict[str, Any]], member_ids: list[str]) -> int:
    return sum(
        task["loadPoints"]
        for task in tasks
        if task["memberId"] in member_ids and task["progressStatus"] != "completed"
    )


# --------------------------------------------------------------------------- tests


def test_team_scope_merges_new_account_into_one_person(guest_client):
    """A new account in two groups of the same team shows one card / one workload."""
    before_team = _data(guest_client.get(f"{BASE}/overview?scope=team"))
    assert len(before_team["members"]) == 12
    assert before_team["stats"]["members"] == 12
    assert before_team["workloadSummary"]["members"] == 12

    account = _create_account(NEW_ACCOUNT_EMAIL, NEW_ACCOUNT_NAME)

    with _as_user(_device_admin()):
        front = _data(
            guest_client.post(
                f"{BASE}/members", json={"userId": account["id"], "title": "前端"}
            )
        )["member"]
        platform = _data(
            guest_client.post(
                f"{PLATFORM_BASE}/members", json={"userId": account["id"], "title": "平台"}
            )
        )["member"]
        # Mergeable works: one current work per archive row.
        _data(
            guest_client.post(
                f"{BASE}/members/{front['id']}/works",
                json={"title": "跨组工作 · 前端", "status": "current", "progress": 30},
            )
        )
        _data(
            guest_client.post(
                f"{PLATFORM_BASE}/members/{platform['id']}/works",
                json={"title": "跨组工作 · 平台", "status": "current", "progress": 10},
            )
        )
        # Load points: 1 + priority + difficulty -> normal/medium = 3, high/hard = 5.
        _data(
            guest_client.post(
                f"{BASE}/tasks",
                json={
                    "memberId": front["id"],
                    "title": "前端跨组任务",
                    "priority": "normal",
                    "difficulty": "medium",
                },
            )
        )
        _data(
            guest_client.post(
                f"{PLATFORM_BASE}/tasks",
                json={
                    "memberId": platform["id"],
                    "title": "平台跨组任务",
                    "priority": "high",
                    "difficulty": "hard",
                },
            )
        )

    team = _data(guest_client.get(f"{BASE}/overview?scope=team"))
    assert len(team["members"]) == 13  # 12 seeded people + the new person
    assert len(team["workloads"]) == 13
    assert team["stats"]["members"] == 13
    assert team["workloadSummary"]["members"] == 13

    card = _card(team["members"], front["id"])
    assert card["id"] == front["id"]  # primary archive = first development group
    assert card["memberIds"] == [front["id"], platform["id"]]
    assert card["groupIds"] == [GROUP_ID, PLATFORM_GROUP_ID]
    assert card["groupNames"] == ["前端体验组", "服务端平台组"]
    assert card["teamIds"] == [TEAM_ID]
    assert card["teamNames"] == ["星港产品团队"]
    assert len(card["memberships"]) == 2
    for membership in card["memberships"]:
        assert set(membership) == MEMBERSHIP_KEYS
    assert [item["memberId"] for item in card["memberships"]] == card["memberIds"]
    # Works are merged across every archive of the person.
    assert card["stats"]["current"] == 2
    assert card["stats"]["done"] == 0
    assert {work["memberId"] for work in card["currentWorks"]} == {
        front["id"],
        platform["id"],
    }
    assert card["groupName"] == "前端体验组"  # legacy field stays on the primary archive

    workload = _workload(team["workloads"], front["id"])
    assert workload["memberId"] == front["id"]
    assert workload["memberIds"] == [front["id"], platform["id"]]
    assert workload["groupIds"] == [GROUP_ID, PLATFORM_GROUP_ID]
    assert workload["currentPoints"] == 8  # 3 + 5 summed over both archives
    assert workload["openTasks"] == 2
    assert workload["completedTasks"] == 0
    assert workload["currentLoadPercent"] == 53
    # Average load is recomputed from the merged task set over the same 4 windows.
    assert workload["averagePoints"] == 2.0
    assert workload["averageLoadPercent"] == 13

    team_tasks = _data(guest_client.get(f"{BASE}/tasks?scope=team"))["tasks"]
    assert workload["currentPoints"] == _open_points(team_tasks, workload["memberIds"])
    # 13 people over 14 archive rows: the summary counts people, the payload keeps ids.
    assert team["workloadSummary"]["members"] == 13
    assert sum(len(item["memberIds"]) for item in team["workloads"]) == 14
    # A person is never split into two workloads, and every workload id is unique.
    assert len({item["memberId"] for item in team["workloads"]}) == 13


def test_all_scope_merges_same_account_across_teams(guest_client):
    """Adding a third archive in another team still yields a single merged card."""
    account = _create_account("multi.all@corp.example", "跨团队同事")
    with _as_user(_device_admin()):
        front = _data(
            guest_client.post(f"{BASE}/members", json={"userId": account["id"], "title": "前端"})
        )["member"]
        platform = _data(
            guest_client.post(
                f"{PLATFORM_BASE}/members", json={"userId": account["id"], "title": "平台"}
            )
        )["member"]
        data_member = _data(
            guest_client.post(f"{DATA_BASE}/members", json={"userId": account["id"], "title": "数据"})
        )["member"]
        for base, archive_id in (
            (BASE, front["id"]),
            (PLATFORM_BASE, platform["id"]),
            (DATA_BASE, data_member["id"]),
        ):
            _data(
                guest_client.post(
                    f"{base}/members/{archive_id}/works",
                    json={"title": f"{base} 工作", "status": "current"},
                )
            )
            _data(
                guest_client.post(
                    f"{base}/tasks",
                    json={"memberId": archive_id, "title": f"{base} 任务"},
                )
            )

    overview = _data(guest_client.get(f"{BASE}/overview?scope=all"))
    assert len(overview["members"]) == 19  # 18 seeded people + the new person
    assert len(overview["workloads"]) == 19
    assert overview["stats"]["members"] == 19
    assert overview["workloadSummary"]["members"] == 19

    card = _card(overview["members"], front["id"])
    assert card["id"] == front["id"]
    # Ordered by g.sort_order, g.name: frontend(1), data(1, 数据智能组), platform(2).
    assert card["memberIds"] == [front["id"], data_member["id"], platform["id"]]
    assert card["groupIds"] == [GROUP_ID, DATA_GROUP_ID, PLATFORM_GROUP_ID]
    assert card["groupNames"] == ["前端体验组", "数据智能组", "服务端平台组"]
    assert card["teamIds"] == [TEAM_ID, OTHER_TEAM_ID]
    assert card["teamNames"] == ["星港产品团队", "远航数据团队"]
    assert len(card["memberships"]) == 3
    assert card["stats"]["current"] == 3
    assert len(card["currentWorks"]) == 3

    insights = _data(guest_client.get(f"{BASE}/insights?scope=all&range=all"))
    assert insights["summary"]["members"] == 19
    assert len(insights["members"]) == 19
    person_rows = [
        item for item in insights["members"] if item["memberId"] == front["id"]
    ]
    assert len(person_rows) == 1  # de-duplicated, primary archive id
    assert len({item["memberId"] for item in insights["members"]}) == len(
        insights["members"]
    )
    assert person_rows[0]["tasks"] == 3  # statistics summed over all archive rows
    # groups[] keeps the archive-row member count (4 seeded + the new row).
    group_rows = {item["groupId"]: item for item in insights["groups"]}
    assert group_rows[PLATFORM_GROUP_ID]["members"] == 5
    assert group_rows[DATA_GROUP_ID]["members"] == 5
    # teams[] still aggregates its groups' row-based member counts.
    team_rows = {item["teamId"]: item for item in insights["teams"]}
    assert team_rows[TEAM_ID]["members"] == 14  # 12 seeded + 2 new archive rows
    assert team_rows[OTHER_TEAM_ID]["members"] == 7  # 6 seeded + 1 new archive row


def test_group_scope_payload_is_unchanged_by_cross_group_membership(guest_client):
    """scope=group numbers/order stay exactly the legacy payload after a cross join."""
    before_overview = _data(guest_client.get(f"{BASE}/overview"))
    before_tasks = _data(guest_client.get(f"{BASE}/tasks"))
    assert len(before_overview["members"]) == 5
    assert before_overview["stats"]["members"] == 5
    assert before_overview["workloadSummary"]["members"] == 5

    # The seeded account joins a second development group.
    platform_member_id = _add_membership(
        guest_client, PLATFORM_BASE, SEEDED_ACCOUNT_ID, title="平台兼职"
    )

    after_overview = _data(guest_client.get(f"{BASE}/overview"))
    after_tasks = _data(guest_client.get(f"{BASE}/tasks"))
    assert after_overview == before_overview
    assert after_tasks == before_tasks
    assert len(after_overview["members"]) == 5
    assert after_overview["stats"]["members"] == 5
    assert after_overview["workloadSummary"]["members"] == 5

    # Team scope now merges the seeded frontend row with the new platform row.
    team = _data(guest_client.get(f"{BASE}/overview?scope=team"))
    assert len(team["members"]) == 12  # 12 people, 13 archive rows
    assert len(team["workloads"]) == 12
    assert team["stats"]["members"] == 12
    card = _card(team["members"], SEEDED_MEMBER_ID)
    assert card["id"] == SEEDED_MEMBER_ID
    assert card["memberIds"] == [SEEDED_MEMBER_ID, platform_member_id]
    assert len(card["memberships"]) == 2
    # Legacy fields keep coming from the primary (frontend) archive.
    assert card["groupId"] == GROUP_ID
    assert card["groupName"] == "前端体验组"
    workload = _workload(team["workloads"], SEEDED_MEMBER_ID)
    assert workload["memberId"] == SEEDED_MEMBER_ID
    assert workload["currentPoints"] == sum(
        item["currentPoints"]
        for item in before_overview["workloads"]
        if item["memberId"] == SEEDED_MEMBER_ID
    )


def test_bootstrap_linked_member_follows_active_group(guest_client):
    """``me.linkedMemberId`` points at the active group's archive (or null)."""
    platform_member_id = _add_membership(
        guest_client, PLATFORM_BASE, SEEDED_ACCOUNT_ID, title="平台兼职"
    )
    _sign_in(guest_client, SEEDED_ACCOUNT_ID, SEEDED_ACCOUNT_EMAIL, "林知夏")

    front = _data(
        guest_client.get(f"/api/bootstrap?teamId={TEAM_ID}&groupId={GROUP_ID}")
    )["me"]
    assert front["linkedMemberId"] == SEEDED_MEMBER_ID
    assert front["linkedMemberName"] == "林知夏"
    assert front["linkedMemberIds"] == [SEEDED_MEMBER_ID, platform_member_id]

    platform = _data(
        guest_client.get(f"/api/bootstrap?teamId={TEAM_ID}&groupId={PLATFORM_GROUP_ID}")
    )["me"]
    assert platform["linkedMemberId"] == platform_member_id
    assert platform["linkedMemberIds"] == [SEEDED_MEMBER_ID, platform_member_id]

    # A group without an archive row resolves to null (the UI hides the entry).
    design = _data(
        guest_client.get(f"/api/bootstrap?teamId={TEAM_ID}&groupId={DESIGN_GROUP_ID}")
    )["me"]
    assert design["linkedMemberId"] is None
    assert design["linkedMemberName"] is None
    assert design["linkedMemberIds"] == [SEEDED_MEMBER_ID, platform_member_id]

    # The default bootstrap picks the first team/group (frontend) as the active group.
    default = _data(guest_client.get("/api/bootstrap"))["me"]
    assert default["linkedMemberId"] == SEEDED_MEMBER_ID

    # /api/auth/me has no active-group context: it keeps the global first archive.
    global_me = _data(guest_client.get("/api/auth/me"))
    assert global_me["linkedMemberId"] == SEEDED_MEMBER_ID
    assert global_me["linkedMemberIds"] == [SEEDED_MEMBER_ID, platform_member_id]

    # Write permissions accept every archive row.
    assert global_me["permissions"]["canEditSelf"] is True


def test_linked_member_writes_work_in_every_archive_group(guest_client):
    """Self edit / task / todo permissions accept the account's other-group archive."""
    platform_member_id = _add_membership(
        guest_client, PLATFORM_BASE, SEEDED_ACCOUNT_ID, title="平台兼职"
    )
    _sign_in(guest_client, SEEDED_ACCOUNT_ID, SEEDED_ACCOUNT_EMAIL, "林知夏")

    # Personal fields of the archive in the other development group.
    patched = _data(
        guest_client.patch(
            f"{PLATFORM_BASE}/members/{platform_member_id}",
            json={"bio": "前端兼平台，跨组编辑成功", "tags": ["跨组"]},
        )
    )["member"]
    assert patched["bio"] == "前端兼平台，跨组编辑成功"
    assert patched["id"] == platform_member_id

    # Personal fields of other people still require a super administrator (or the
    # account owner); the plain linked member is rejected before scope is checked.
    denied = guest_client.patch(
        f"{PLATFORM_BASE}/members/m-zhou", json={"bio": "越权修改"}
    )
    assert denied.status_code == 403

    # Creating "my" task in each group resolves that group's archive by default.
    front_task = _data(
        guest_client.post(f"{BASE}/tasks", json={"title": "前端组自己的任务"})
    )["task"]
    assert front_task["memberId"] == SEEDED_MEMBER_ID
    platform_task = _data(
        guest_client.post(f"{PLATFORM_BASE}/tasks", json={"title": "平台组自己的任务"})
    )["task"]
    assert platform_task["memberId"] == platform_member_id
    updated = _data(
        guest_client.patch(
            f"{PLATFORM_BASE}/tasks/{platform_task['id']}",
            json={"progressStatus": "in_progress"},
        )
    )["task"]
    assert updated["progressStatus"] == "in_progress"

    # A group without an archive row of the account cannot host a default task.
    forbidden = guest_client.post(
        f"{DESIGN_BASE}/tasks", json={"title": "设计组越权任务"}
    )
    assert forbidden.status_code == 403
    assert _error(forbidden)["code"] == "forbidden"

    # Todo defaults to the caller's archive of the request's group and stays editable.
    todo = _data(
        guest_client.post(
            f"{PLATFORM_BASE}/todos",
            json={"title": "平台组自己的待办", "dueDate": _tomorrow()},
        )
    )["todo"]
    assert todo["assigneeMemberId"] == platform_member_id
    edited_todo = _data(
        guest_client.patch(
            f"{PLATFORM_BASE}/todos/{todo['id']}", json={"title": "平台组待办（已编辑）"}
        )
    )["todo"]
    assert edited_todo["title"] == "平台组待办（已编辑）"
    # Assigning someone else is still forbidden for a plain member.
    denied_todo = guest_client.post(
        f"{PLATFORM_BASE}/todos",
        json={"title": "指派他人", "assigneeMemberId": "m-zhou", "dueDate": _tomorrow()},
    )
    assert denied_todo.status_code == 403

    # An in-scope admin who is also the linked account cannot delete its own archive.
    linked_admin = CurrentUser(
        id=SEEDED_ACCOUNT_ID,
        name="林知夏",
        email=SEEDED_ACCOUNT_EMAIL,
        authenticated=True,
        source="email",
        admin_role="group_admin",
        group_ids={GROUP_ID, PLATFORM_GROUP_ID},
        linked_member_id=SEEDED_MEMBER_ID,
        linked_member_ids=[SEEDED_MEMBER_ID, platform_member_id],
    )
    with _as_user(linked_admin):
        own_delete = guest_client.delete(
            f"{PLATFORM_BASE}/members/{platform_member_id}"
        )
    assert own_delete.status_code == 409
    assert _error(own_delete)["code"] == "cannot_delete_self"


def test_profile_lists_every_archive_row(guest_client):
    """The personal home page aggregates all archive rows, duties and tasks."""
    platform_member_id = _add_membership(
        guest_client, PLATFORM_BASE, SEEDED_ACCOUNT_ID, title="平台兼职"
    )
    with _as_user(_device_admin()):
        platform_task = _data(
            guest_client.post(
                f"{PLATFORM_BASE}/tasks",
                json={"memberId": platform_member_id, "title": "平台组任务"},
            )
        )["task"]
        # A responsibility area owned by the platform archive exercises cross-group duties.
        with db() as conn:
            now = now_iso()
            conn.execute(
                "INSERT INTO matrix_areas (id,group_id,area,description,owner_member_id,"
                "backup_member_id,backup_member_ids,channel,contact,sort_order,created_at,"
                "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    new_id("matrix"),
                    PLATFORM_GROUP_ID,
                    "跨组责任田",
                    "平台侧责任田",
                    platform_member_id,
                    None,
                    "[]",
                    "企业微信",
                    "#multi",
                    99,
                    now,
                    now,
                ),
            )

    _sign_in(guest_client, SEEDED_ACCOUNT_ID, SEEDED_ACCOUNT_EMAIL, "林知夏")
    profile = _data(guest_client.get("/api/profile"))
    assert profile["isSelf"] is True
    members = profile["members"]
    assert len(members) == 2  # one row per development group, no duplicates
    assert {member["id"] for member in members} == {
        SEEDED_MEMBER_ID,
        platform_member_id,
    }
    assert {member["groupId"] for member in members} == {
        GROUP_ID,
        PLATFORM_GROUP_ID,
    }
    assert {member["groupName"] for member in members} == {
        "前端体验组",
        "服务端平台组",
    }
    # Duties / tasks are aggregated across the account's archive rows.
    assert {duty["groupId"] for duty in profile["duties"]} == {
        GROUP_ID,
        PLATFORM_GROUP_ID,
    }
    current_ids = {task["id"] for task in profile["currentTasks"]}
    assert platform_task["id"] in current_ids
    assert any(task["memberId"] == SEEDED_MEMBER_ID for task in profile["currentTasks"])
    assert profile["stats"]["currentTasks"] == len(profile["currentTasks"])
    assert profile["stats"]["currentTasks"] >= 3  # 2 seeded frontend + 1 platform
