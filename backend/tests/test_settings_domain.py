"""Layered settings in round 8: site level is super-only, domain level is team-only."""

from __future__ import annotations

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


def test_device_admin_sees_every_team_and_site_settings(client):
    payload = data(client.get("/api/settings/domain"))
    assert set(payload) == {"teams", "permissions"}
    assert [team["id"] for team in payload["teams"]] == [TEAM_AURORA, TEAM_VOYAGE]
    for team in payload["teams"]:
        assert set(team) == {
            "id",
            "name",
            "shortName",
            "description",
            "color",
            "canEdit",
        }
        assert team["canEdit"] is True
        assert "groups" not in team
        assert "groupCount" not in team
    assert payload["permissions"]["isSuperAdmin"] is True
    assert payload["permissions"]["isDeviceAdmin"] is True
    assert payload["permissions"]["canEditSite"] is True

    # Site settings remain super-admin only, and every team is editable.
    assert client.get("/api/settings").status_code == 200
    assert (
        client.patch(
            f"/api/settings/teams/{TEAM_VOYAGE}", json={"description": "站点级管理员"}
        ).status_code
        == 200
    )


def test_domain_settings_follow_team_admin_scope():
    with ip_admin(TEAM_AURORA, ip="10.93.1.10", port=51801) as admin:
        payload = data(admin.get("/api/settings/domain"))
        assert [team["id"] for team in payload["teams"]] == [TEAM_AURORA]
        assert payload["teams"][0]["canEdit"] is True
        assert payload["permissions"]["canEditSite"] is False
        assert payload["permissions"]["canEditTeam"] is True
        assert payload["permissions"]["isSuperAdmin"] is False
        assert payload["permissions"]["isDeviceAdmin"] is False

        # Team / group admins cannot read or write site-level settings.
        assert admin.get("/api/settings").status_code == 403
        assert admin.get("/api/settings/schema").status_code == 403
        assert admin.put("/api/settings", json={}).status_code == 403

        renamed = admin.patch(
            f"/api/settings/teams/{TEAM_AURORA}",
            json={"name": "极光产品团队 (改)", "description": "团队级设置"},
        )
        assert renamed.status_code == 200, renamed.text
        assert data(renamed)["team"]["name"] == "极光产品团队 (改)"
        boot = data(admin.get("/api/bootstrap"))
        assert any(team["name"] == "极光产品团队 (改)" for team in boot["teams"])

        assert_error(
            admin.patch(f"/api/settings/teams/{TEAM_VOYAGE}", json={"name": "越权团队"}),
            403,
            "not_admin",
        )
        # The development-group settings endpoint no longer exists.
        assert (
            admin.patch(
                f"/api/settings/teams/{TEAM_AURORA}/groups/grp-frontend",
                json={"description": "越权开发组"},
            ).status_code
            in (404, 405)
        )


def test_plain_member_has_no_domain_settings_access(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.114", 51802) as browser:
        email_login(browser, chen["email"], monkeypatch)
        response = browser.get("/api/settings/domain")
        assert response.status_code == 403
        assert error(response)["code"] == "not_admin"
        assert (
            browser.patch(
                f"/api/settings/teams/{TEAM_AURORA}", json={"name": "成员越权"}
            ).status_code
            == 403
        )


def test_settings_workspace_helper_is_team_only(client):
    payload = data(client.get("/api/settings/workspace"))
    assert set(payload) >= {"teams"}
    assert "groups" not in payload
    assert [team["id"] for team in payload["teams"]] == [TEAM_AURORA, TEAM_VOYAGE]
    for team in payload["teams"]:
        for key in ("id", "name", "short_name", "color"):
            assert key in team, key
        assert "groupCount" not in team


def test_domain_patch_unknown_team_returns_404(client):
    response = client.patch(
        "/api/settings/teams/team-missing", json={"description": "不存在"}
    )
    assert_error(response, 404, "team_not_found")
