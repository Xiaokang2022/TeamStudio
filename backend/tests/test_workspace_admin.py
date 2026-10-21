"""Workspace administration (round 8: teams are the only organisational unit).

``/api/workspace/manage`` returns teams only — no nested groups, no ``groupCount`` and no
``canCreateGroup``. Creating/deleting teams stays super-admin only; deleting requires the
exact team name and cascades through every team-scoped table.
"""

from __future__ import annotations

from typing import Any

from backend.app.db import db, rows, scalar
from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    assert_error,
    data,
    email_login,
    error,
    ip_admin,
    member_by_email,
    remote_client,
)

CONFIRM_MESSAGE = "请输入完整的团队名称以确认删除"
TEAM_CHILD_TABLES = (
    "works",
    "todos",
    "member_tasks",
    "redblack_boards",
    "links",
    "matrix_areas",
    "announcements",
    "task_tags",
)


def _delete_team(client, team_id: str, confirm_name: str | None):
    if confirm_name is None:
        return client.request("DELETE", f"/api/workspace/teams/{team_id}")
    return client.request(
        "DELETE", f"/api/workspace/teams/{team_id}", json={"confirmName": confirm_name}
    )


def _scalar(sql: str, params: tuple[Any, ...] = ()):
    with db() as conn:
        return scalar(conn, sql, params)


def _child_counts(team_id: str) -> dict[str, int]:
    counts = {}
    for table in TEAM_CHILD_TABLES:
        counts[table] = int(
            _scalar(f"SELECT COUNT(*) FROM {table} WHERE team_id=?", (team_id,)) or 0
        )
    return counts


def _audit_rows() -> list[dict[str, Any]]:
    with db() as conn:
        return rows(
            conn,
            "SELECT actor, action, entity, entity_id FROM audit_logs ORDER BY created_at, rowid",
        )


# --------------------------------------------------------------------------- GET /manage


def test_manage_payload_for_device_admin(client):
    payload = data(client.get("/api/workspace/manage"))
    assert set(payload) == {"teams", "permissions"}
    assert payload["permissions"] == {"canCreateTeam": True, "canManageAnyTeam": True}

    teams = payload["teams"]
    assert [team["id"] for team in teams] == [TEAM_AURORA, TEAM_VOYAGE]
    for team in teams:
        assert set(team) == {
            "id",
            "name",
            "shortName",
            "description",
            "color",
            "memberCount",
            "canDelete",
        }
        assert "groups" not in team
        assert "groupCount" not in team
        assert "canCreateGroup" not in team

    aurora, voyage = teams
    assert aurora["name"] == "极光产品团队"
    assert aurora["shortName"] == "极光"
    assert aurora["memberCount"] == 12
    assert aurora["canDelete"] is True
    assert voyage["memberCount"] == 6


def test_manage_scopes_team_admin_to_own_team():
    with ip_admin(TEAM_AURORA, ip="10.92.1.10", port=51701) as admin:
        payload = data(admin.get("/api/workspace/manage"))
        assert [team["id"] for team in payload["teams"]] == [TEAM_AURORA]
        assert payload["teams"][0]["canDelete"] is False
        assert payload["permissions"]["canCreateTeam"] is False


def test_manage_forbidden_for_non_managers(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.110", 51702) as guest:
        response = guest.get("/api/workspace/manage")
        assert response.status_code in (401, 403)
        assert error(response)["code"] in {"not_admin", "authentication_required"}

    with remote_client("10.20.30.111", 51703) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert_error(browser.get("/api/workspace/manage"), 403, "not_admin")


# --------------------------------------------------------------------------- POST /teams


def test_create_team_as_device_admin(client):
    response = client.post(
        "/api/workspace/teams",
        json={
            "name": "  云图产品团队  ",
            "shortName": "云图",
            "description": "面向数据可视化的新团队",
            "color": "#ABCDEF",
        },
    )
    assert response.status_code == 200, response.text
    team = data(response)["team"]
    assert team["id"].startswith("team-")
    assert team["name"] == "云图产品团队"
    assert team["shortName"] == "云图"
    assert team["color"] == "#abcdef"
    assert team["memberCount"] == 0
    assert team["canDelete"] is True
    assert "groups" not in team

    defaulted = data(client.post("/api/workspace/teams", json={"name": "极光实验室"}))["team"]
    assert defaulted["shortName"] == "极光实验"
    assert defaulted["description"] == ""
    assert defaulted["color"] == "#5865f2"

    managed = data(client.get("/api/workspace/manage"))["teams"]
    assert [item["id"] for item in managed][-2:] == [team["id"], defaulted["id"]]


def test_create_team_validation_and_permissions(client, monkeypatch):
    for payload in (
        {},
        {"name": ""},
        {"name": "   "},
        {"name": "长" * 41},
        {"name": "校验团队", "shortName": "长" * 13},
        {"name": "校验团队", "description": "长" * 121},
        {"name": "校验团队", "color": "purple"},
        {"name": "校验团队", "color": "#12345"},
    ):
        response = client.post("/api/workspace/teams", json=payload)
        assert response.status_code == 422, (payload, response.text)
    assert _scalar("SELECT COUNT(*) FROM teams") == 2

    # Only a super administrator may create teams.
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.112", 51704) as guest:
        assert guest.post("/api/workspace/teams", json={"name": "越权团队"}).status_code == 403
    with remote_client("10.20.30.113", 51705) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert_error(
            browser.post("/api/workspace/teams", json={"name": "越权团队"}),
            403,
            "not_admin",
        )
    with ip_admin(TEAM_AURORA, ip="10.92.1.11", port=51706) as team_admin:
        assert_error(
            team_admin.post("/api/workspace/teams", json={"name": "越权团队"}),
            403,
            "not_admin",
        )


# --------------------------------------------------------------------------- DELETE /teams/{id}


def test_delete_team_requires_exact_name_and_cascades(client):
    before_children = _child_counts(TEAM_VOYAGE)
    assert before_children["works"] > 0
    assert before_children["todos"] > 0
    assert before_children["member_tasks"] > 0
    assert _scalar("SELECT COUNT(*) FROM members WHERE team_id=?", (TEAM_VOYAGE,)) == 6

    response = _delete_team(client, TEAM_VOYAGE, "远航")
    assert response.status_code == 422
    payload = error(response)
    assert payload["code"] == "confirm_mismatch"
    assert payload["message"] == CONFIRM_MESSAGE
    assert payload["details"] == {"expected": "远航数据团队"}
    assert _scalar("SELECT COUNT(*) FROM teams") == 2

    response = _delete_team(client, TEAM_VOYAGE, None)
    assert response.status_code == 422
    assert error(response)["code"] == "confirm_mismatch"

    response = _delete_team(client, TEAM_VOYAGE, "  远航数据团队\n")
    assert response.status_code == 200, response.text
    assert data(response) == {"deleted": True, "id": TEAM_VOYAGE}

    assert _scalar("SELECT COUNT(*) FROM teams WHERE id=?", (TEAM_VOYAGE,)) == 0
    assert _scalar("SELECT COUNT(*) FROM members WHERE team_id=?", (TEAM_VOYAGE,)) == 0
    assert all(count == 0 for count in _child_counts(TEAM_VOYAGE).values())
    # The untouched team keeps its whole dataset.
    assert _scalar("SELECT COUNT(*) FROM teams") == 1
    assert _scalar("SELECT COUNT(*) FROM members WHERE team_id=?", (TEAM_AURORA,)) == 12
    assert _child_counts(TEAM_AURORA)["works"] > 0


def test_delete_unknown_team_returns_404(client):
    response = _delete_team(client, "team-missing", "不存在")
    assert_error(response, 404, "team_not_found")


def test_team_admin_cannot_delete_or_restructure_teams():
    with ip_admin(TEAM_AURORA, ip="10.92.1.12", port=51707) as team_admin:
        response = _delete_team(team_admin, TEAM_AURORA, "极光产品团队")
        assert_error(response, 403, "not_admin")
        assert _scalar("SELECT COUNT(*) FROM teams") == 2

        # The development-group restructure endpoints are gone entirely.
        assert (
            team_admin.post(
                f"/api/workspace/teams/{TEAM_AURORA}/groups", json={"name": "越权开发组"}
            ).status_code
            in (403, 404, 405)
        )
        assert (
            team_admin.request(
                "DELETE",
                f"/api/workspace/teams/{TEAM_AURORA}/groups/grp-frontend",
                json={"confirmName": "前端体验组"},
            ).status_code
            in (403, 404, 405)
        )


# --------------------------------------------------------------------------- audit


def test_workspace_writes_are_audited(client):
    team = data(client.post("/api/workspace/teams", json={"name": "审计团队"}))["team"]
    assert _delete_team(client, team["id"], "审计团队").status_code == 200

    recorded = {(row["actor"], row["action"], row["entity"], row["entity_id"]) for row in _audit_rows()}
    assert ("Admin", "team.create", "team", team["id"]) in recorded
    assert ("Admin", "team.delete", "team", team["id"]) in recorded
