"""Deployment-device Admin can sign out and use an ordinary account session."""

from __future__ import annotations

from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.db import db
from backend.app.routers import auth as auth_router
from backend.app.services import accounts


def _configure_email() -> None:
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["enabled"] = True
    payload["email"]["smtp"].update(
        {
            "host": "127.0.0.1",
            "port": 2525,
            "fromEmail": "noreply@corp.example",
        }
    )
    settings_service.save(payload)


def _capture_codes(monkeypatch) -> dict:
    captured: dict = {}

    def fake_send(*, recipient: str, code: str, purpose: str = "login", expires_minutes: int = 10):
        captured.update({"recipient": recipient, "code": code, "purpose": purpose})

    monkeypatch.setattr(auth_router, "send_verification_code", fake_send)
    return captured


def _email_login(client, email: str, monkeypatch) -> dict:
    captured = _capture_codes(monkeypatch)
    requested = client.post("/api/auth/email/request", json={"email": email})
    assert requested.status_code == 200, requested.text
    verified = client.post(
        "/api/auth/email/verify", json={"email": email, "code": captured["code"]}
    )
    assert verified.status_code == 200, verified.text
    return verified.json()["data"]


def test_device_admin_logout_and_restore(client):
    me = client.get("/api/auth/me").json()["data"]
    assert me["isDeviceAdmin"] is True
    assert me["deployDevice"] is True
    assert me["deviceAdminActive"] is True

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert logout.json()["data"]["endSessionUrl"] is None

    guest = client.get("/api/auth/me").json()["data"]
    assert guest["authenticated"] is False
    assert guest["source"] == "guest"
    assert guest["isDeviceAdmin"] is False
    assert guest["deployDevice"] is True
    assert guest["deviceAdminActive"] is False
    assert client.get("/api/settings").status_code == 403
    assert client.get("/api/users").status_code == 403

    restored = client.post("/api/auth/device/login")
    assert restored.status_code == 200
    assert restored.json()["data"]["deviceAdmin"] is True
    admin = client.get("/api/auth/me").json()["data"]
    assert admin["isDeviceAdmin"] is True
    assert admin["deviceAdminActive"] is True
    assert client.get("/api/settings").status_code == 200


def test_device_logout_then_email_account_has_no_device_privileges(client, monkeypatch):
    _configure_email()
    client.post("/api/auth/logout")
    _email_login(client, "lin.zhixia@corp.example", monkeypatch)

    me = client.get("/api/auth/me").json()["data"]
    assert me["source"] == "email"
    assert me["authenticated"] is True
    assert me["id"] == "lin.zhixia"
    assert me["isDeviceAdmin"] is False
    assert me["isSuperAdmin"] is False
    assert me["deviceAdminActive"] is False
    assert me["deployDevice"] is True
    assert me["admin"]["role"] is None
    assert me["linkedMemberId"] == "m-lin"

    # Exactly like any other browser session: no settings/account administration,
    # but normal in-scope content stays readable.
    assert client.get("/api/settings").status_code == 403
    assert client.get("/api/users").status_code == 403
    assert (
        client.get("/api/teams/team-aurora/groups/grp-frontend/overview").status_code
        == 200
    )

    # Signing the e-mail session out leaves the device-Admin sign-out flag in place.
    client.post("/api/auth/logout")
    guest = client.get("/api/auth/me").json()["data"]
    assert guest["source"] == "guest"
    assert guest["authenticated"] is False
    assert guest["deployDevice"] is True
    # The device owner can always restore the built-in Admin from the login page.
    client.post("/api/auth/device/login")
    assert client.get("/api/auth/me").json()["data"]["isDeviceAdmin"] is True


def test_device_logout_then_stored_super_account_keeps_only_its_role(client, monkeypatch):
    _configure_email()
    client.post("/api/auth/logout")
    with db() as conn:
        accounts.create_user(
            conn,
            email="device.super@corp.example",
            name="设备上的超管账号",
            role="super",
            email_verified=True,
            created_by="test",
        )
    _email_login(client, "device.super@corp.example", monkeypatch)
    me = client.get("/api/auth/me").json()["data"]
    assert me["isDeviceAdmin"] is False
    assert me["deviceAdminActive"] is False
    # Its own stored super role still applies, exactly as on any other machine.
    assert me["isSuperAdmin"] is True
    assert me["userRole"] == "super"
    assert client.get("/api/settings").status_code == 200
    assert client.get("/api/users").status_code == 200


def test_device_admin_login_is_rejected_off_device(guest_client):
    response = guest_client.post("/api/auth/device/login")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "device_admin_unavailable"
    # A remote logout must never write the device-Admin sign-out cookie.
    guest_client.post("/api/auth/logout")
    me = guest_client.get("/api/auth/me").json()["data"]
    assert me["deployDevice"] is False
    assert me["deviceAdminActive"] is False
