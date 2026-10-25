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


# ---------------------------------------------------- team module settings (round 9)

TEAM_MODULE_KEYS = (
    "overview",
    "tasks",
    "insights",
    "calendar",
    "redblack",
    "announcements",
    "matrix",
    "links",
    "settings",
)


def _team_settings_url(team_id: str = TEAM_AURORA) -> str:
    return f"/api/teams/{team_id}/settings"


def test_team_settings_payload_shape_and_defaults(client):
    payload = data(client.get(_team_settings_url()))
    assert set(payload) == {"settings", "effective", "canEdit", "updatedAt"}
    assert set(payload["settings"]) == {"modules", "guestModules"}
    assert set(payload["settings"]["modules"]) == set(TEAM_MODULE_KEYS)
    assert set(payload["settings"]["guestModules"]) == set(TEAM_MODULE_KEYS)
    assert all(payload["settings"]["modules"].values())
    assert all(
        value
        for key, value in payload["settings"]["guestModules"].items()
        if key != "settings"
    )
    # The settings module is a site-level concept: members may read, guests never do.
    assert payload["settings"]["modules"]["settings"] is True
    assert payload["settings"]["guestModules"]["settings"] is False
    assert payload["effective"]["modules"] == payload["settings"]["modules"]
    assert payload["effective"]["guestModules"]["settings"] is False
    assert payload["canEdit"] is True
    assert payload["updatedAt"] == ""

    unknown = assert_error(
        client.get(_team_settings_url("team-missing")), 404, "team_not_found"
    )
    assert unknown["message"] == "团队不存在"


def test_team_settings_partial_merge_and_effective_flags(client):
    saved = data(client.put(_team_settings_url(), json={"modules": {"tasks": False}}))
    assert saved["settings"]["modules"]["tasks"] is False
    assert saved["settings"]["modules"]["overview"] is True
    assert saved["effective"]["modules"]["tasks"] is False
    # A module switched off for members is off for guests too (AND semantics).
    assert saved["effective"]["guestModules"]["tasks"] is False
    assert saved["updatedAt"]

    stored = data(client.get(_team_settings_url()))
    assert stored["settings"] == saved["settings"]
    assert stored["effective"] == saved["effective"]

    # Guest-only switches never restrict authenticated members.
    guest_only = data(
        client.put(_team_settings_url(), json={"guestModules": {"tasks": False}})
    )
    assert guest_only["settings"]["guestModules"]["tasks"] is False
    assert guest_only["effective"]["guestModules"]["tasks"] is False
    assert guest_only["effective"]["modules"]["tasks"] is False  # still off from above
    data(client.put(_team_settings_url(), json={"modules": {"tasks": True}}))
    restored = data(client.put(_team_settings_url(), json={"guestModules": {"tasks": True}}))
    assert restored["effective"]["modules"]["tasks"] is True
    assert restored["effective"]["guestModules"]["tasks"] is True


def test_team_settings_forced_values_and_validation(client):
    forced = data(
        client.put(
            _team_settings_url(),
            json={"modules": {"settings": False}, "guestModules": {"settings": True}},
        )
    )
    assert forced["settings"]["modules"]["settings"] is True
    assert forced["settings"]["guestModules"]["settings"] is False

    for body in (
        {"modules": {"unknown": True}},
        {"guestModules": {"unknown": True}},
        {"unknownTop": True},
        {"modules": {"tasks": "false"}},
        {"modules": {"tasks": 1}},
        {"modules": []},
    ):
        assert_error(
            client.put(_team_settings_url(), json=body), 400, "invalid_settings"
        )
    # Failed writes must not have changed anything.
    unchanged = data(client.get(_team_settings_url()))
    assert unchanged["settings"]["modules"]["tasks"] is True


def test_team_admin_can_edit_own_team_settings_only():
    with ip_admin(TEAM_AURORA, ip="10.93.2.10", port=51811) as admin:
        assert admin.get(_team_settings_url()).status_code == 200
        saved = data(
            admin.put(_team_settings_url(), json={"modules": {"links": False}})
        )
        assert saved["settings"]["modules"]["links"] is False
        assert saved["canEdit"] is True
        data(admin.put(_team_settings_url(), json={"modules": {"links": True}}))

        assert_error(
            admin.put(
                _team_settings_url(TEAM_VOYAGE), json={"modules": {"links": False}}
            ),
            403,
            "not_admin",
        )


def test_plain_member_reads_but_cannot_edit_team_settings(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.118", 51812) as browser:
        email_login(browser, chen["email"], monkeypatch)
        payload = data(browser.get(_team_settings_url()))
        assert payload["canEdit"] is False
        assert payload["settings"]["modules"]["overview"] is True
        assert_error(
            browser.put(_team_settings_url(), json={"modules": {"tasks": False}}),
            403,
            "not_admin",
        )


def test_guest_cannot_read_team_settings(guest_client):
    denied = guest_client.get(_team_settings_url())
    assert denied.status_code == 403
    assert error(denied)["code"] == "guest_module_disabled"


def test_team_settings_drive_bootstrap_active_flags(client):
    active = data(client.get("/api/bootstrap", params={"teamId": TEAM_AURORA}))["active"]
    assert active["team"]["id"] == TEAM_AURORA
    assert set(active["moduleFlags"]) == set(TEAM_MODULE_KEYS)
    assert all(active["moduleFlags"].values())
    assert active["canEditTeamSettings"] is True
    assert active["teamSettings"]["modules"]["settings"] is True
    assert active["teamSettings"]["guestModules"]["settings"] is False

    data(client.put(_team_settings_url(), json={"modules": {"links": False}}))
    refreshed = data(client.get("/api/bootstrap", params={"teamId": TEAM_AURORA}))["active"]
    assert refreshed["moduleFlags"]["links"] is False
    assert refreshed["teamSettings"]["modules"]["links"] is False
    data(client.put(_team_settings_url(), json={"modules": {"links": True}}))

