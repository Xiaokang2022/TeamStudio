"""Tests for the global browsing scope (``#11``): single group / team / all teams.

The default (no ``scope`` parameter) payload must stay byte-compatible with the v1 group
payload apart from the additive ``scope`` metadata and per-item ``groupId``/``groupName``
(plus task ``teamId``/``teamName``) fields. Aggregate scopes widen reads only.
"""

from __future__ import annotations

from datetime import date

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}"

TEAM_GROUPS = {"grp-frontend", "grp-platform", "grp-design"}
ALL_GROUPS = TEAM_GROUPS | {"grp-data", "grp-infra"}


def _data(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["data"]


def test_default_scope_keeps_legacy_group_payload(client):
    data = _data(client.get(f"{BASE}/overview"))

    # The legacy top-level keys are all still present.
    for key in ("group", "members", "works", "recentActivity", "stats", "workloads"):
        assert key in data
    assert data["group"]["id"] == GROUP_ID
    assert data["stats"]["members"] == len(data["members"]) == 5

    scope = data["scope"]
    assert scope["kind"] == "group"
    assert scope["label"] == "前端体验组"
    assert scope["groupIds"] == [GROUP_ID]
    assert scope["teamIds"] == [TEAM_ID]
    assert scope["groups"][0]["id"] == GROUP_ID
    assert scope["groups"][0]["teamId"] == TEAM_ID
    assert scope["groups"][0]["teamName"] == "星港产品团队"
    assert scope["team"]["id"] == TEAM_ID
    assert scope["group"]["id"] == GROUP_ID

    member = data["members"][0]
    assert member["groupId"] == GROUP_ID
    assert member["groupName"] == "前端体验组"
    assert member["teamId"] == TEAM_ID
    assert member["teamName"] == "星港产品团队"

    # Overview workloads still cover every member of the group.
    assert [item["memberId"] for item in data["workloads"]] == [
        item["id"] for item in data["members"]
    ]

    # Omitting the query parameter behaves exactly like scope=group.
    explicit = _data(client.get(f"{BASE}/overview?scope=group"))
    assert explicit == data


def test_team_scope_aggregates_aurora_groups(client):
    data = _data(client.get(f"{BASE}/overview?scope=team"))
    scope = data["scope"]
    assert scope["kind"] == "team"
    assert scope["label"] == "星港产品团队"
    assert set(scope["groupIds"]) == TEAM_GROUPS
    assert scope["teamIds"] == [TEAM_ID]
    assert {group["id"] for group in scope["groups"]} == TEAM_GROUPS

    assert len(data["members"]) == 12
    assert {member["groupId"] for member in data["members"]} == TEAM_GROUPS
    assert data["stats"]["members"] == 12
    assert data["workloadSummary"]["members"] == 12
    assert len(data["workloads"]) == 12
    for member in data["members"]:
        assert member["groupName"]
        assert member["teamName"] == "星港产品团队"
    for work in data["works"]:
        assert work["groupId"] in TEAM_GROUPS
        assert work["groupName"]


def test_all_scope_aggregates_every_team(client):
    data = _data(client.get(f"{BASE}/overview?scope=all"))
    scope = data["scope"]
    assert scope["kind"] == "all"
    assert scope["label"] == "所有团队"
    assert set(scope["groupIds"]) == ALL_GROUPS
    assert set(scope["teamIds"]) == {"team-aurora", "team-voyage"}
    assert len(data["members"]) == 18
    assert {member["teamId"] for member in data["members"]} == {
        "team-aurora",
        "team-voyage",
    }
    assert data["stats"]["members"] == 18


def test_invalid_scope_is_rejected(client):
    for path in (
        "overview",
        "tasks",
        "todos",
        "links",
        "matrix",
        "announcements",
        "redblack",
    ):
        response = client.get(f"{BASE}/{path}?scope=bogus")
        assert response.status_code == 422, path
        assert response.json()["error"]["code"] == "invalid_scope"


def test_scope_metadata_shape_matches_frontend_scope_meta(client):
    scope = _data(client.get(f"{BASE}/tasks?scope=team"))["scope"]
    assert set(scope) == {
        "kind",
        "label",
        "teamIds",
        "groupIds",
        "groups",
        "team",
        "group",
    }
    assert set(scope["groups"][0]) >= {
        "id",
        "teamId",
        "teamName",
        "name",
        "color",
    }
    assert set(scope["team"] or {}) == {"id", "name", "shortName", "color"}
    # The path group is still the active group while browsing a wider team scope.
    assert scope["group"]["id"] == GROUP_ID


def test_tasks_scope_returns_group_annotated_tasks(client):
    group_data = _data(client.get(f"{BASE}/tasks"))
    assert group_data["scope"]["kind"] == "group"
    assert len(group_data["tasks"]) == 14
    assert all(task["groupId"] == GROUP_ID for task in group_data["tasks"])

    team_data = _data(client.get(f"{BASE}/tasks?scope=team"))
    assert team_data["scope"]["kind"] == "team"
    assert len(team_data["tasks"]) > len(group_data["tasks"])
    assert {task["groupId"] for task in team_data["tasks"]} == TEAM_GROUPS
    for task in team_data["tasks"]:
        assert task["groupName"]
        assert task["teamId"] == TEAM_ID
        assert task["teamName"] == "星港产品团队"

    all_data = _data(client.get(f"{BASE}/tasks?scope=all"))
    assert len(all_data["tasks"]) == 49
    assert len(all_data["workloads"]) == 18


def test_todos_scope_aggregates_month(client):
    month = date.today().strftime("%Y-%m")
    group_data = _data(client.get(f"{BASE}/todos?month={month}"))
    assert group_data["month"] == month
    assert group_data["scope"]["kind"] == "group"
    assert all(todo["groupId"] == GROUP_ID for todo in group_data["todos"])

    team_data = _data(client.get(f"{BASE}/todos?month={month}&scope=team"))
    assert team_data["scope"]["kind"] == "team"
    assert {todo["groupId"] for todo in team_data["todos"]} == TEAM_GROUPS
    for todo in team_data["todos"]:
        assert todo["groupName"]
        assert todo["teamName"] == "星港产品团队"

    all_data = _data(client.get(f"{BASE}/todos?month={month}&scope=all"))
    assert len(all_data["todos"]) >= len(team_data["todos"]) >= len(group_data["todos"])


def test_links_matrix_announcements_scope(client):
    links = _data(client.get(f"{BASE}/links?scope=team"))
    assert len(links["links"]) == 21
    assert links["scope"]["kind"] == "team"
    assert {link["groupId"] for link in links["links"]} == TEAM_GROUPS
    assert all(link["groupName"] for link in links["links"])

    matrix = _data(client.get(f"{BASE}/matrix?scope=all"))
    assert len(matrix["areas"]) == 18
    assert matrix["scope"]["kind"] == "all"
    assert {area["groupId"] for area in matrix["areas"]} == ALL_GROUPS
    assert matrix["areas"][0]["groupName"]

    announcements = _data(client.get(f"{BASE}/announcements?scope=all"))
    assert len(announcements["announcements"]) == 13
    assert announcements["scope"]["kind"] == "all"
    assert announcements["maxPinned"] == 3
    assert all(item["groupName"] for item in announcements["announcements"])


def test_member_works_scope(client):
    data = _data(client.get(f"{BASE}/members/m-lin/works"))
    assert data["memberId"] == "m-lin"
    assert data["scope"]["kind"] == "group"
    assert data["works"]
    assert all(work["groupId"] == GROUP_ID for work in data["works"])
    assert all(work["groupName"] == "前端体验组" for work in data["works"])

    expanded = _data(client.get(f"{BASE}/members/m-lin/works?scope=all"))
    assert expanded["works"] == data["works"]
    assert expanded["scope"]["kind"] == "all"

    # A member outside the path group is only reachable through a wider scope.
    assert client.get(f"{BASE}/members/m-zhou/works").status_code == 404
    assert client.get(f"{BASE}/members/m-zhou/works?scope=team").status_code == 200


def test_redblack_scope_follows_view(client):
    month = date.today().strftime("%Y-%m")

    group_data = _data(client.get(f"{BASE}/redblack?month={month}"))
    assert group_data["month"] == month
    assert group_data["scope"]["kind"] == "group"
    assert group_data["board"]["groupId"] == GROUP_ID
    assert group_data["board"]["theme"]
    assert [board["groupId"] for board in group_data["boards"]] == [GROUP_ID]
    for entry in group_data["board"]["red"] + group_data["board"]["black"]:
        assert entry["groupId"] == GROUP_ID
        assert entry["groupName"] == "前端体验组"
        assert entry["teamId"] == TEAM_ID
        assert entry["teamName"] == "星港产品团队"

    team_data = _data(client.get(f"{BASE}/redblack?month={month}&scope=team"))
    assert team_data["scope"]["kind"] == "team"
    assert {board["groupId"] for board in team_data["boards"]} == TEAM_GROUPS
    merged = team_data["board"]
    assert merged["id"] is None
    assert merged["exists"] is True
    assert {entry["groupId"] for entry in merged["red"]} == TEAM_GROUPS
    assert all(entry["groupName"] and entry["teamName"] for entry in merged["black"])

    all_data = _data(client.get(f"{BASE}/redblack?month={month}&scope=all"))
    assert all_data["scope"]["kind"] == "all"
    assert {board["groupId"] for board in all_data["boards"]} == ALL_GROUPS
    assert len(all_data["board"]["red"]) > len(team_data["board"]["red"])
    assert len(all_data["board"]["black"]) >= len(team_data["board"]["black"])

    # A month without any scoped board merges to an empty (non-null) aggregate board.
    empty = _data(client.get(f"{BASE}/redblack?month=2030-01&scope=team"))
    assert empty["board"]["id"] is None
    assert empty["board"]["exists"] is False
    assert empty["board"]["red"] == [] and empty["board"]["black"] == []
    assert empty["boards"] == []
    # Group scope keeps the legacy null board for a missing month.
    assert _data(client.get(f"{BASE}/redblack?month=2030-01"))["board"] is None


def test_every_identity_can_use_all_scope(guest_client):
    """Round 6: browsing scope is a view preference, not a permission boundary."""
    for path in (
        "overview",
        "tasks",
        "todos",
        "links",
        "matrix",
        "announcements",
        "insights",
        "redblack",
    ):
        for kind in ("group", "team", "all"):
            response = guest_client.get(f"{BASE}/{path}?scope={kind}")
            assert response.status_code == 200, (path, kind, response.text)
            assert response.json()["data"]["scope"]["kind"] == kind, path
            assert response.json()["data"]["scope"]["kind"] == kind, (path, kind)
