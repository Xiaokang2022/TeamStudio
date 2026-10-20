"""Layered settings: site-level is super-only, domain-level follows admin scope."""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.auth import SessionIdentity, create_session_token
from backend.app.db import db
from backend.app.main import app
from backend.app.services import accounts


def _create_account(
    email: str,
    *,
    role: str = "member",
    team_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
) -> dict:
    with db() as conn:
        return accounts.create_user(
            conn,
            email=email,
            name=email.split("@")[0],
            role=role,
            team_ids=team_ids,
            group_ids=group_ids,
            email_verified=True,
            created_by="test",
        )


def _sign_in(client: TestClient, user_id: str, email: str) -> None:
    token = create_session_token(
        SessionIdentity(id=user_id, name=user_id, email=email, provider="email"), 7
    )
    client.cookies.set("teamstudio_session", token)


def test_domain_settings_follow_admin_scope(client):
    _create_account(
        "team.admin@corp.example", role="team_admin", team_ids=["team-aurora"]
    )
    _create_account(
        "group.admin@corp.example", role="group_admin", group_ids=["grp-frontend"]
    )
    _create_account("plain.member@corp.example")

    with TestClient(app, client=("10.20.31.11", 51031), raise_server_exceptions=False) as remote:
        # Team administrator: its team + every group inside it.
        _sign_in(remote, "team.admin", "team.admin@corp.example")
        domain = remote.get("/api/settings/domain")
        assert domain.status_code == 200
        data = domain.json()["data"]
        assert [team["id"] for team in data["teams"]] == ["team-aurora"]
        team = data["teams"][0]
        assert team["canEdit"] is True
        assert {group["id"] for group in team["groups"]} == {
            "grp-frontend",
            "grp-platform",
            "grp-design",
        }
        assert data["permissions"]["canEditSite"] is False
        assert data["permissions"]["canEditTeam"] is True

        # Team / group admins cannot read or write site-level settings.
        assert remote.get("/api/settings").status_code == 403
        assert remote.get("/api/settings/schema").status_code == 403
        assert remote.put("/api/settings", json={}).status_code == 403

        renamed = remote.patch(
            "/api/settings/teams/team-aurora",
            json={"name": "极光产品团队 (改)", "description": "团队级设置"},
        )
        assert renamed.status_code == 200
        assert renamed.json()["data"]["team"]["name"] == "极光产品团队 (改)"
        boot = remote.get("/api/bootstrap").json()["data"]
        assert any(team["name"] == "极光产品团队 (改)" for team in boot["teams"])

        group_renamed = remote.patch(
            "/api/settings/teams/team-aurora/groups/grp-frontend",
            json={"description": "前端体验组 · 团队管理员更新"},
        )
        assert group_renamed.status_code == 200

        assert (
            remote.patch(
                "/api/settings/teams/team-voyage", json={"name": "越权团队"}
            ).status_code
            == 403
        )
        assert (
            remote.patch(
                "/api/settings/teams/team-voyage/groups/grp-data",
                json={"description": "越权开发组"},
            ).status_code
            == 403
        )

        # Development-group administrator: only its group, team info is read-only.
        remote.cookies.clear()
        _sign_in(remote, "group.admin", "group.admin@corp.example")
        group_domain = remote.get("/api/settings/domain").json()["data"]
        assert len(group_domain["teams"]) == 1
        assert group_domain["teams"][0]["canEdit"] is False
        assert [group["id"] for group in group_domain["teams"][0]["groups"]] == [
            "grp-frontend"
        ]
        assert group_domain["teams"][0]["groups"][0]["canEdit"] is True
        assert (
            remote.patch(
                "/api/settings/teams/team-aurora", json={"name": "开发组管理员不能改团队"}
            ).status_code
            == 403
        )
        assert (
            remote.patch(
                "/api/settings/teams/team-aurora/groups/grp-frontend",
                json={"name": "前端体验组"},
            ).status_code
            == 200
        )
        assert (
            remote.patch(
                "/api/settings/teams/team-aurora/groups/grp-platform",
                json={"name": "越权"},
            ).status_code
            == 403
        )

        # A plain member has no domain settings access at all.
        remote.cookies.clear()
        _sign_in(remote, "plain.member", "plain.member@corp.example")
        assert remote.get("/api/settings/domain").status_code == 403
        assert (
            remote.patch(
                "/api/settings/teams/team-aurora", json={"name": "成员越权"}
            ).status_code
            == 403
        )


def test_super_admin_sees_every_domain_and_site_settings(client):
    _create_account("root.two@corp.example", role="super")
    with TestClient(app, client=("10.20.31.12", 51032), raise_server_exceptions=False) as remote:
        _sign_in(remote, "root.two", "root.two@corp.example")
        domain = remote.get("/api/settings/domain").json()["data"]
        assert {team["id"] for team in domain["teams"]} == {"team-aurora", "team-voyage"}
        assert all(team["canEdit"] for team in domain["teams"])
        assert domain["permissions"]["canEditSite"] is True
        assert remote.get("/api/settings").status_code == 200
        # Super admins may edit both team and group metadata.
        assert (
            remote.patch(
                "/api/settings/teams/team-voyage", json={"description": "站点级管理员"}
            ).status_code
            == 200
        )
        assert (
            remote.patch(
                "/api/settings/teams/team-voyage/groups/grp-data",
                json={"description": "数据组"},
            ).status_code
            == 200
        )
