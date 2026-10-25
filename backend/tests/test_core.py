"""Core round-8 contract: bootstrap/team model, settings v3, guest access, device Admin.

The suite is team-only: there is no ``groups`` resource, no ``scope`` query parameter and
no ``group_admin`` role anywhere. ``client`` from ``conftest.py`` talks to the app through
loopback and therefore is the built-in deployment-device Admin.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    assert_error,
    bootstrap,
    data,
    error,
    ip_admin,
    me,
    member_by_email,
    members_of,
    overview,
    remote_client,
    save_admin_whitelist,
    session_token,
    sign_in,
    team_ids,
)


# --------------------------------------------------------------------------- settings helpers


def _settings(client: TestClient) -> dict:
    return data(client.get("/api/settings"))["settings"]


def _save_settings(client: TestClient, payload: dict) -> dict:
    return data(client.put("/api/settings", json=payload))["settings"]


def _default_settings() -> dict:
    from backend.app.config import DEFAULT_SETTINGS

    return DEFAULT_SETTINGS.model_dump(mode="json")


# --------------------------------------------------------------------------- built-in device Admin


def test_local_device_is_builtin_admin_and_not_in_config(client):
    payload = bootstrap(client)
    assert payload["me"]["isDeviceAdmin"] is True
    assert payload["me"]["name"] == "Admin"
    assert payload["me"]["admin"]["role"] == "super"
    assert payload["me"]["deployDevice"] is True
    assert payload["me"]["deviceAdminActive"] is True
    assert payload["deviceAdminName"] == "Admin"

    # The hidden built-in admin is never part of the persisted whitelist.
    settings = data(client.get("/api/settings"))
    whitelist = settings["settings"]["auth"]["adminWhitelist"]
    assert whitelist["ips"] == []
    assert whitelist["ids"] == []
    raw = json.dumps(settings, ensure_ascii=False)
    assert "device-admin" not in raw


def test_bootstrap_team_only_shape(client):
    payload = bootstrap(client)
    assert set(payload) >= {
        "me",
        "config",
        "teams",
        "active",
        "stats",
        "serverTime",
        "deviceAdminName",
    }
    # No group concept survives in the bootstrap payload.
    assert "group" not in payload["active"]
    assert "groups" not in payload["teams"][0]
    assert "groups" not in payload["stats"]
    assert payload["active"]["team"] is not None
    assert payload["active"]["team"]["id"] == TEAM_AURORA
    assert [team["id"] for team in payload["teams"]] == [TEAM_AURORA, TEAM_VOYAGE]
    for team in payload["teams"]:
        assert set(team) >= {
            "id",
            "name",
            "shortName",
            "description",
            "color",
            "memberCount",
        }
    assert payload["stats"]["teams"] == 2
    assert payload["stats"]["members"] == 18

    # Public config exposes the new guest module switches.
    guest_modules = payload["config"]["guestModules"]
    assert guest_modules["settings"] is False
    for module in ("overview", "tasks", "calendar", "redblack", "links", "matrix", "announcements", "insights"):
        assert guest_modules[module] is True, module

    # Round 9: the settings entry is permission-based, never hidden by a module flag.
    assert payload["config"]["modules"]["settings"] is True


def test_bootstrap_resolves_requested_team_and_falls_back(client):
    voyage = bootstrap(client, TEAM_VOYAGE)
    assert voyage["active"]["team"]["id"] == TEAM_VOYAGE
    assert voyage["active"]["team"]["name"] == "远航数据团队"

    missing = bootstrap(client, "team-does-not-exist")
    assert missing["active"]["team"]["id"] == TEAM_AURORA


def test_auth_me_has_no_group_fields(client):
    payload = me(client)
    assert payload["authenticated"] is True
    assert payload["isSuperAdmin"] is True
    assert payload["admin"]["role"] == "super"
    assert "groupIds" not in payload["admin"]
    assert "group_ids" not in payload["admin"]
    assert "canViewAllScope" not in payload["permissions"]
    serialized = json.dumps(payload, ensure_ascii=False)
    for legacy in ("groupIds", "group_ids", "scope", "groupName"):
        assert legacy not in serialized, legacy


# --------------------------------------------------------------------------- guest access


def test_guest_can_read_team_modules(guest_client):
    payload = bootstrap(guest_client)
    assert payload["me"]["source"] == "guest"
    assert payload["me"]["authenticated"] is False
    assert payload["me"]["permissions"]["canEditSettings"] is False

    for module in (
        "overview",
        "tasks",
        "todos",
        "insights",
        "redblack",
        "links",
        "matrix",
        "announcements",
    ):
        response = guest_client.get(f"/api/teams/{TEAM_AURORA}/{module}")
        assert response.status_code == 200, (module, response.text)

    # Site settings are super-admin only.
    assert guest_client.get("/api/settings").status_code == 403
    assert guest_client.get("/api/users").status_code == 403

    # Guests can never write.
    denied = guest_client.post(
        f"/api/teams/{TEAM_AURORA}/todos",
        json={"title": "访客不应创建", "dueDate": "2026-10-30"},
    )
    assert denied.status_code in (401, 403)


def test_scope_query_parameter_is_gone(client):
    payload = data(client.get(f"/api/teams/{TEAM_AURORA}/overview?scope=all"))
    assert "scope" not in payload
    assert payload["team"]["id"] == TEAM_AURORA
    tasks = data(client.get(f"/api/teams/{TEAM_AURORA}/tasks?scope=team"))
    assert "scope" not in tasks
    for task in tasks["tasks"]:
        assert "groupId" in task
        assert "groupName" in task
        assert "scope" not in task


def test_overview_is_team_only(client):
    payload = overview(client)
    assert payload["team"]["id"] == TEAM_AURORA
    assert "group" not in payload
    assert "groups" not in payload
    assert len(payload["members"]) == 12
    for member in payload["members"]:
        assert "status" not in member
        assert "avatar" in member
        assert "groupId" in member
        assert "groupName" in member


def test_team_not_found_returns_404(client):
    payload = assert_error(
        client.get("/api/teams/team-missing/overview"), 404, "team_not_found"
    )
    assert payload["message"] == "团队不存在"


# --------------------------------------------------------------------------- settings v3


def test_settings_validation_errors_are_path_specific(client):
    payload = _default_settings()
    payload["announcements"]["maxPinned"] = 4
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 422
    details = error(response)["details"]
    assert any("maxPinned" in detail["path"] for detail in details)

    payload = _default_settings()
    payload["site"]["unknownOption"] = True
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 422
    assert any("unknownOption" in detail["path"] for detail in error(response)["details"])

    # ``group_admin`` and ``groupIds`` are no longer valid whitelist fields.
    payload = _default_settings()
    payload["auth"]["adminWhitelist"]["ids"] = [
        {"id": "x@corp.example", "role": "group_admin", "teamId": TEAM_AURORA}
    ]
    assert client.put("/api/settings", json=payload).status_code == 422

    payload = _default_settings()
    payload["auth"]["adminWhitelist"]["ids"] = [
        {
            "id": "y@corp.example",
            "role": "team_admin",
            "teamId": TEAM_AURORA,
            "groupIds": ["grp-frontend"],
        }
    ]
    assert client.put("/api/settings", json=payload).status_code == 422

    # An empty teamId is storable (legacy compatibility) but grants nothing.
    payload = _default_settings()
    payload["auth"]["adminWhitelist"]["ids"] = [
        {"id": "z@corp.example", "role": "team_admin", "teamId": ""}
    ]
    saved = _save_settings(client, payload)
    assert saved["auth"]["adminWhitelist"]["ids"][0]["teamId"] == ""


def test_settings_save_and_public_projection(client):
    payload = _settings(client)
    payload["site"]["name"] = "测试工作室"
    payload["modules"]["redblack"] = False
    payload["guestModules"]["tasks"] = False
    saved = _save_settings(client, payload)
    assert saved["site"]["name"] == "测试工作室"
    assert saved["version"] == 3
    assert "guestModules" in saved
    assert saved["modules"]["redblack"] is False
    assert saved["guestModules"]["tasks"] is False

    boot = bootstrap(client)
    assert boot["config"]["site"]["name"] == "测试工作室"
    assert boot["config"]["modules"]["redblack"] is False
    assert boot["config"]["guestModules"]["tasks"] is False
    # Secrets are not exposed via the public projection.
    assert "password" not in json.dumps(boot["config"].get("email", {}))

    schema = data(client.get("/api/settings/schema"))["schema"]
    assert "guestModules" in schema["properties"]
    assert "properties" in schema

    invalid = client.post("/api/settings/validate", json={"announcements": {"maxPinned": 9}})
    assert invalid.status_code == 422


def test_settings_module_cannot_be_hidden(client):
    """Round 9: the settings entry is permission-based and cannot be switched off."""
    payload = _settings(client)
    payload["modules"]["settings"] = False
    payload["guestModules"]["settings"] = True
    saved = _save_settings(client, payload)
    assert saved["modules"]["settings"] is True
    assert saved["guestModules"]["settings"] is False

    boot = bootstrap(client)
    assert boot["config"]["modules"]["settings"] is True
    assert boot["config"]["guestModules"]["settings"] is False

    # The schema keeps the compatibility field but never lets the settings module be hidden.
    schema = data(client.get("/api/settings/schema"))["schema"]
    assert "settings" in schema["$defs"]["ModuleFlags"]["properties"]


def test_site_theme_mode_is_kept_but_limited(client):
    from backend.app.config import DEFAULT_SETTINGS

    # The site-level switch no longer decides light/dark, but the compatibility field
    # must stay loadable and still validated.
    assert DEFAULT_SETTINGS.site.theme.mode in {"auto", "light", "dark"}
    boot = bootstrap(client)
    assert boot["config"]["site"]["theme"]["mode"] in {"auto", "light", "dark"}

    payload = _default_settings()
    payload["site"]["theme"]["mode"] = "system"
    assert client.put("/api/settings", json=payload).status_code == 422


def test_default_guest_modules(client):
    from backend.app.config import DEFAULT_SETTINGS

    flags = DEFAULT_SETTINGS.guestModules.model_dump()
    assert flags["settings"] is False
    assert all(value is True for key, value in flags.items() if key != "settings")


# --------------------------------------------------------------------------- admin whitelist


def test_ip_whitelist_grants_team_admin_only():
    with ip_admin(TEAM_AURORA, ip="10.90.1.23", port=51102) as remote:
        payload = me(remote)
        assert payload["source"] == "ip"
        assert payload["admin"]["role"] == "team_admin"
        assert payload["admin"]["teamIds"] == [TEAM_AURORA]
        assert payload["isSuperAdmin"] is False
        assert payload["permissions"]["canEditSettings"] is False
        assert payload["permissions"]["canManageUsers"] is False

        # Site settings remain super-only.
        assert remote.get("/api/settings").status_code == 403

        created = remote.post(
            f"/api/teams/{TEAM_AURORA}/links",
            json={"title": "IP 管理员链接", "url": "https://example.com/ip"},
        )
        assert created.status_code == 200, created.text
        denied = remote.post(
            f"/api/teams/{TEAM_VOYAGE}/links",
            json={"title": "越权链接", "url": "https://example.com/no"},
        )
        assert_error(denied, 403, "not_admin")


def test_id_whitelist_team_admin_from_signed_session(client):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    save_admin_whitelist(
        ids=[
            {
                "id": "lin.zhixia@corp.example",
                "name": "林知夏",
                "role": "team_admin",
                "teamId": TEAM_AURORA,
            }
        ]
    )
    with remote_client("10.90.4.5", 51103) as remote:
        sign_in(remote, "lin.zhixia", email="lin.zhixia@corp.example", name="林知夏")
        payload = me(remote)
        assert payload["source"] == "email"
        assert payload["admin"]["role"] == "team_admin"
        assert payload["admin"]["teamIds"] == [TEAM_AURORA]
        assert payload["linkedMemberId"] == lin["id"]

        # Personal information: the linked owner may edit their own profile.
        updated = remote.patch(
            f"/api/teams/{TEAM_AURORA}/members/{lin['id']}",
            json={"bio": "由本人更新"},
        )
        assert updated.status_code == 200, updated.text
        # Another member's personal information stays reserved for super admins.
        chen = member_by_email(client, "chen.yu@corp.example")
        denied = remote.patch(
            f"/api/teams/{TEAM_AURORA}/members/{chen['id']}",
            json={"bio": "组管理员不能编辑他人个人信息"},
        )
        assert_error(denied, 403, "personal_info_forbidden")
        # Organizational fields remain editable inside the admin domain.
        organizational = remote.patch(
            f"/api/teams/{TEAM_AURORA}/members/{chen['id']}",
            json={"title": "前端体验组负责人"},
        )
        assert organizational.status_code == 200, organizational.text


# --------------------------------------------------------------------------- misc core


def test_email_status_is_smtp_only_and_safe(client):
    status = data(client.get("/api/email/status"))
    assert status["configured"] is False
    assert status["host"] == ""
    assert "password" not in json.dumps(status)
    assert client.post("/api/email/scan").status_code in (404, 405)
    assert client.get("/api/email/preview").status_code == 404
    assert client.get("/api/email/mailbox").status_code == 404
    assert client.post("/api/email/test", json={"to": "not-an-email"}).status_code == 422


def test_verification_template_rendering():
    from backend.app.services.email_service import render_template

    subject = render_template(
        "[{{siteName}}] 验证码", {"siteName": "团队工作室", "code": "123456"}
    )
    assert subject == "[团队工作室] 验证码"
    assert render_template("{{a}}/{{missing}}", {"a": "x"}) == "x/"


def test_announcement_pin_hard_limit(client):
    cap = data(client.get("/api/settings"))["settings"]["announcements"]["maxPinned"]
    url = f"/api/teams/{TEAM_AURORA}/announcements"
    announcements = data(client.get(url))["announcements"]
    pinned = [item for item in announcements if item["pinned"]]
    index = 0
    while len(pinned) < cap:
        created = data(
            client.post(
                url,
                json={
                    "title": f"置顶占位 {index}",
                    "content": "填充置顶位",
                    "pinned": True,
                    "level": "info",
                },
            )
        )["announcement"]
        assert created["pinned"] is True
        pinned.append(created)
        index += 1

    response = client.post(
        url,
        json={"title": "多出的置顶", "content": "应当被拒绝", "pinned": True, "level": "info"},
    )
    assert response.status_code in (409, 422), response.text
    assert "置顶" in error(response)["message"]


def test_health_and_api_404(client):
    health = data(client.get("/api/health"))
    assert health["status"] == "ok"
    missing = client.get("/api/does-not-exist")
    assert missing.status_code == 404
    assert missing.json()["ok"] is False


@pytest.mark.parametrize("legacy_path", ["/api/groups", "/api/scope"])
def test_removed_group_endpoints_are_gone(client, legacy_path):
    assert client.get(legacy_path).status_code == 404
