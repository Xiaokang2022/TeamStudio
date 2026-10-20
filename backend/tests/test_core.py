"""Core API, auth, configuration and email service tests."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app.auth import SessionIdentity, create_session_token
from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.main import app
from backend.app.services.email_service import render_template


def _base_settings() -> dict:
    return DEFAULT_SETTINGS.model_dump(mode="json")


def test_local_device_is_builtin_admin_and_not_in_config(client):
    boot = client.get("/api/bootstrap")
    assert boot.status_code == 200
    data = boot.json()["data"]
    assert data["me"]["isDeviceAdmin"] is True
    assert data["me"]["name"] == "Admin"
    assert data["me"]["admin"]["role"] == "super"
    assert data["config"]["modules"]["overview"] is True
    settings = client.get("/api/settings")
    assert settings.status_code == 200
    body = settings.json()["data"]
    assert body["meta"]["deviceAdminName"] == "Admin"
    raw = json.dumps(body["settings"], ensure_ascii=False)
    assert "device-admin" not in raw
    # The hidden built-in admin is never part of the persisted whitelist.
    assert body["settings"]["auth"]["adminWhitelist"]["ids"] == []
    assert body["settings"]["auth"]["adminWhitelist"]["ips"] == []


def test_forwarded_requests_do_not_inherit_device_admin(client):
    me = client.get(
        "/api/auth/me",
        headers={"X-Forwarded-For": "203.0.113.50"},
    ).json()["data"]
    assert me["source"] == "guest"
    assert me["isDeviceAdmin"] is False


def test_guest_mode_is_read_only_and_sso_fallback(guest_client):
    boot = guest_client.get("/api/bootstrap")
    assert boot.status_code == 200
    data = boot.json()["data"]
    assert data["me"]["source"] == "guest"
    assert data["me"]["authenticated"] is False
    assert data["me"]["permissions"]["canEditSettings"] is False
    assert data["config"]["auth"]["sso"]["configured"] is False

    overview = guest_client.get("/api/teams/team-aurora/groups/grp-frontend/overview")
    assert overview.status_code == 200
    assert overview.json()["data"]["group"]["name"] == "前端体验组"

    denied = guest_client.post(
        "/api/teams/team-aurora/groups/grp-frontend/todos",
        json={"title": "访客不应创建", "dueDate": "2026-10-30"},
    )
    assert denied.status_code in (401, 403)

    settings = guest_client.get("/api/settings")
    assert settings.status_code == 403

    login = guest_client.get("/api/auth/login?next=/overview", follow_redirects=False)
    assert login.status_code == 303
    assert login.headers["location"].startswith("/overview")
    assert "sso=unconfigured" in login.headers["location"]

    hash_login = guest_client.get(
        "/api/auth/login?next=/%23/calendar", follow_redirects=False
    )
    # Query flags must precede the fragment so the SPA can read them from location.search.
    assert hash_login.headers["location"] == "/?sso=unconfigured#/calendar"


def test_settings_validation_errors_are_path_specific(client):
    payload = _base_settings()
    payload["announcements"]["maxPinned"] = 4
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "settings_validation_failed"
    assert any("maxPinned" in detail["path"] for detail in error["details"])

    payload = _base_settings()
    payload["site"]["unknownOption"] = True
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 422
    assert any("unknownOption" in detail["path"] for detail in response.json()["error"]["details"])

    payload = _base_settings()
    payload["auth"]["adminWhitelist"]["ids"] = [
        {"id": "x@corp.example", "role": "team_admin", "teamId": "", "groupIds": []}
    ]
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 422


def test_default_theme_follows_system(client):
    """The site default theme mode must be "auto" (follow the OS colour scheme)."""
    assert DEFAULT_SETTINGS.site.theme.mode == "auto"
    boot = client.get("/api/bootstrap").json()["data"]
    assert boot["config"]["site"]["theme"]["mode"] == "auto"
    payload = _base_settings()
    payload["site"]["theme"]["mode"] = "system"
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 422


def test_settings_save_and_public_projection(client):
    payload = _base_settings()
    payload["site"]["name"] = "测试工作室"
    payload["modules"]["redblack"] = False
    response = client.put("/api/settings", json=payload)
    assert response.status_code == 200
    saved = response.json()["data"]["settings"]
    assert saved["site"]["name"] == "测试工作室"

    boot = client.get("/api/bootstrap").json()["data"]
    assert boot["config"]["site"]["name"] == "测试工作室"
    assert boot["config"]["modules"]["redblack"] is False
    # Secrets are not exposed via the public projection.
    assert "password" not in json.dumps(boot["config"].get("email", {}))
    schema = client.get("/api/settings/schema")
    assert schema.status_code == 200
    assert "properties" in schema.json()["data"]["schema"]

    invalid = client.post("/api/settings/validate", json={"announcements": {"maxPinned": 9}})
    assert invalid.status_code == 422


def test_ip_whitelist_grants_scoped_admin():
    payload = _base_settings()
    payload["auth"]["adminWhitelist"]["ips"] = [
        {
            "ip": "10.90.0.0/16",
            "name": "楼层管理员",
            "role": "team_admin",
            "teamId": "team-aurora",
            "groupIds": [],
        }
    ]
    settings_service.save(payload)
    assert settings_service.get().auth.adminWhitelist.ips[0].ip == "10.90.0.0/16"
    with TestClient(app, client=("10.90.1.23", 51002), raise_server_exceptions=False) as remote:
        me = remote.get("/api/auth/me").json()["data"]
        assert me["source"] == "ip"
        assert me["admin"]["role"] == "team_admin"
        assert me["admin"]["teamIds"] == ["team-aurora"]
        me_payload = _base_settings()
        me_payload["site"]["footerText"] = "IP 管理员不能改全局设置"
        assert remote.put("/api/settings", json=me_payload).status_code == 403
        # In-scope group content is editable.
        created = remote.post(
            "/api/teams/team-aurora/groups/grp-frontend/links",
            json={"title": "IP 管理员链接", "url": "https://example.com/ip"},
        )
        assert created.status_code == 200
        denied = remote.post(
            "/api/teams/team-voyage/groups/grp-data/links",
            json={"title": "越权链接", "url": "https://example.com/no"},
        )
        assert denied.status_code == 403


def test_id_whitelist_group_admin_from_signed_session():
    payload = _base_settings()
    payload["auth"]["adminWhitelist"]["ids"] = [
        {
            "id": "su.wan@corp.example",
            "name": "苏晚",
            "role": "group_admin",
            "teamId": "team-aurora",
            "groupIds": ["grp-frontend"],
        }
    ]
    settings_service.save(payload)
    identity = SessionIdentity(id="su.wan@corp.example", name="苏晚", email="su.wan@corp.example")
    token = create_session_token(identity, 7)
    with TestClient(app, client=("10.90.4.5", 51003), raise_server_exceptions=False) as remote:
        remote.cookies.set("teamstudio_session", token)
        me = remote.get("/api/auth/me").json()["data"]
        assert me["source"] == "sso"
        assert me["admin"]["role"] == "group_admin"
        assert me["admin"]["groupIds"] == ["grp-frontend"]
        assert me["linkedMemberId"] == "m-su"
        assert me["permissions"]["canEditSelf"] is True
        # Personal information: the linked owner may edit their own profile.
        updated = remote.patch(
            "/api/teams/team-aurora/groups/grp-frontend/members/m-su",
            json={"bio": "由本人更新"},
        )
        assert updated.status_code == 200
        # Personal information of another member is reserved for super admins.
        denied = remote.patch(
            "/api/teams/team-aurora/groups/grp-frontend/members/m-lin",
            json={"bio": "组管理员不能编辑他人个人信息"},
        )
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "personal_info_forbidden"
        # Organizational fields remain editable inside the admin domain.
        organizational = remote.patch(
            "/api/teams/team-aurora/groups/grp-frontend/members/m-lin",
            json={"title": "前端体验组负责人"},
        )
        assert organizational.status_code == 200
        out_of_scope = remote.patch(
            "/api/teams/team-aurora/groups/grp-platform/members/m-zhou",
            json={"title": "越权修改"},
        )
        assert out_of_scope.status_code == 403


def test_email_status_is_smtp_only_and_safe(client):
    status = client.get("/api/email/status")
    assert status.status_code == 200
    data = status.json()["data"]
    assert data["configured"] is False
    assert data["host"] == ""
    assert "password" not in json.dumps(data)
    # The bundled mailbox/scan/preview endpoints are gone in round 5.
    assert client.post("/api/email/scan").status_code in (404, 405)
    assert client.get("/api/email/preview").status_code == 404
    assert client.get("/api/email/mailbox").status_code == 404
    bad_test = client.post("/api/email/test", json={"to": "not-an-email"})
    assert bad_test.status_code == 422


def test_verification_template_rendering():
    subject = render_template(
        "[{{siteName}}] 验证码", {"siteName": "团队工作室", "code": "123456"}
    )
    assert subject == "[团队工作室] 验证码"
    body = render_template("{{a}}/{{missing}}", {"a": "x"})
    assert body == "x/"


def test_announcement_pin_hard_limit(client):
    base = "/api/teams/team-aurora/groups/grp-frontend/announcements"
    existing = client.get(base).json()["data"]["announcements"]
    pinned = [item for item in existing if item["pinned"]]
    assert len(pinned) == 3
    response = client.post(
        base,
        json={"title": "第四条置顶", "content": "应当被拒绝", "pinned": True, "level": "info"},
    )
    assert response.status_code in (409, 422)
    assert "置顶" in response.json()["error"]["message"]


def test_health_and_api_404(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["data"]["status"] == "ok"
    missing = client.get("/api/does-not-exist")
    assert missing.status_code == 404
    assert missing.json()["ok"] is False
