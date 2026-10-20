"""Password-less e-mail code registration/login and session behaviour."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.app.auth import SessionIdentity, create_session_token
from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.db import db, row
from backend.app.routers import auth as auth_router
from backend.app.services import accounts


def _configure_email() -> None:
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["enabled"] = True
    payload["email"]["smtp"].update(
        {
            "host": "127.0.0.1",
            "port": 2525,
            "username": "noreply@corp.example",
            "password": "smtp-secret",
            "fromEmail": "noreply@corp.example",
        }
    )
    settings_service.save(payload)


def _capture_codes(monkeypatch) -> dict:
    captured: dict = {}

    def fake_send(*, recipient: str, code: str, purpose: str = "login", expires_minutes: int = 10):
        captured.update(
            {"recipient": recipient, "code": code, "purpose": purpose, "expires": expires_minutes}
        )

    monkeypatch.setattr(auth_router, "send_verification_code", fake_send)
    return captured


def _login_as_super(guest_client) -> None:
    with db() as conn:
        accounts.create_user(
            conn,
            email="root.super@corp.example",
            name="Root",
            role="super",
            email_verified=True,
            created_by="test",
        )
    token = create_session_token(
        SessionIdentity(
            id="root.super",
            name="Root",
            email="root.super@corp.example",
            provider="email",
        ),
        7,
    )
    guest_client.cookies.set("teamstudio_session", token)


def test_email_code_registers_and_logs_in(guest_client, monkeypatch):
    _configure_email()
    captured = _capture_codes(monkeypatch)

    requested = guest_client.post(
        "/api/auth/email/request", json={"email": "Alice.New@Corp.Example"}
    )
    assert requested.status_code == 200
    data = requested.json()["data"]
    assert data["sent"] is True
    assert data["purpose"] == "register"
    assert data["registered"] is False
    assert data["codeLength"] == 6
    code = captured["code"]
    assert len(code) == 6 and code.isdigit()

    # The code is stored as a keyed hash, never in plain text.
    with db() as conn:
        stored = row(
            conn,
            "SELECT code_hash FROM email_codes WHERE email=? ORDER BY created_at DESC LIMIT 1",
            ("alice.new@corp.example",),
        )
    assert stored is not None
    assert stored["code_hash"] != code
    assert len(stored["code_hash"]) == 64

    wrong = "000000" if code != "000000" else "111111"
    rejected = guest_client.post(
        "/api/auth/email/verify", json={"email": "alice.new@corp.example", "code": wrong}
    )
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "code_mismatch"
    assert rejected.json()["error"]["details"]["remainingAttempts"] == 4

    verified = guest_client.post(
        "/api/auth/email/verify", json={"email": "alice.new@corp.example", "code": code}
    )
    assert verified.status_code == 200
    result = verified.json()["data"]
    assert result["loggedIn"] is True
    assert result["isNewUser"] is True
    assert result["user"]["id"] == "alice.new"
    assert result["user"]["name"] == "alice.new"
    assert result["user"]["role"] == "member"
    assert "Max-Age=604800" in verified.headers.get("set-cookie", "")

    me = guest_client.get("/api/auth/me").json()["data"]
    assert me["authenticated"] is True
    assert me["source"] == "email"
    assert me["id"] == "alice.new"
    assert me["email"] == "alice.new@corp.example"
    assert me["isSuperAdmin"] is False
    assert me["admin"]["role"] is None
    assert me["permissions"]["canEditSettings"] is False

    # Session is sliding: every bootstrap/me request re-issues the cookie.
    boot = guest_client.get("/api/bootstrap")
    assert boot.status_code == 200
    assert "Max-Age" in boot.headers.get("set-cookie", "")


def test_seeded_account_login_links_member_profile(guest_client, monkeypatch):
    _configure_email()
    captured = _capture_codes(monkeypatch)

    requested = guest_client.post(
        "/api/auth/email/request", json={"email": "lin.zhixia@corp.example"}
    )
    assert requested.status_code == 200
    assert requested.json()["data"]["registered"] is True
    assert requested.json()["data"]["purpose"] == "login"

    verified = guest_client.post(
        "/api/auth/email/verify",
        json={"email": "lin.zhixia@corp.example", "code": captured["code"]},
    )
    assert verified.status_code == 200
    me = guest_client.get("/api/auth/me").json()["data"]
    assert me["id"] == "lin.zhixia"
    assert me["name"] == "林知夏"
    assert me["linkedMemberId"] == "m-lin"
    assert me["permissions"]["canEditSelf"] is True

    # A normal member cannot request the cross-team browsing scope.
    denied = guest_client.get(
        "/api/teams/team-aurora/groups/grp-frontend/overview?scope=all"
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "scope_forbidden"


def test_precreated_account_activation_and_super_admin(guest_client, monkeypatch):
    _configure_email()
    captured = _capture_codes(monkeypatch)
    _login_as_super(guest_client)

    created = guest_client.post(
        "/api/users",
        json={
            "email": "future.super@corp.example",
            "name": "未来超管",
            "role": "super",
        },
    )
    assert created.status_code == 200
    assert created.json()["data"]["user"]["emailVerified"] is False

    listed = guest_client.get("/api/users").json()["data"]
    assert listed["users"][0]["isDeviceAdmin"] is True
    assert listed["users"][0]["canManage"] is False
    emails = {item["email"] for item in listed["users"]}
    assert "future.super@corp.example" in emails

    with db() as conn:
        account = accounts.get_user_by_email(conn, "future.super@corp.example")
        assert account is not None
        assert account["id"] == "future.super"
        assert account["email_verified"] == 0

    # Clear the super session, then activate the pre-created account by code.
    guest_client.cookies.clear()
    requested = guest_client.post(
        "/api/auth/email/request", json={"email": "future.super@corp.example"}
    )
    assert requested.status_code == 200
    assert requested.json()["data"]["registered"] is False
    verified = guest_client.post(
        "/api/auth/email/verify",
        json={"email": "future.super@corp.example", "code": captured["code"]},
    )
    assert verified.status_code == 200
    assert verified.json()["data"]["isNewUser"] is False

    me = guest_client.get("/api/auth/me").json()["data"]
    assert me["isSuperAdmin"] is True
    assert me["id"] == "future.super"
    assert me["name"] == "未来超管"

    # A stored super administrator reaches site-level settings and all scopes.
    assert guest_client.get("/api/settings").status_code == 200
    assert (
        guest_client.get("/api/teams/team-aurora/groups/grp-frontend/overview?scope=all").status_code
        == 200
    )

    # The deployment device Admin can never be edited or deleted.
    assert guest_client.patch("/api/users/device-admin", json={"name": "x"}).status_code == 403
    assert guest_client.delete("/api/users/device-admin").status_code == 403
    # A super administrator cannot delete itself while signed in.
    assert guest_client.delete("/api/users/future.super").status_code == 409


def test_request_code_rate_limit_and_expiry(guest_client, monkeypatch):
    _configure_email()
    _capture_codes(monkeypatch)
    first = guest_client.post("/api/auth/email/request", json={"email": "rate.limit@corp.example"})
    assert first.status_code == 200

    limited = guest_client.post("/api/auth/email/request", json={"email": "rate.limit@corp.example"})
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "code_rate_limited"
    assert limited.json()["error"]["details"]["retryAfterSeconds"] >= 1

    # Force the latest code to look expired.
    expired_at = (datetime.now(timezone.utc).astimezone() - timedelta(minutes=1)).isoformat(
        timespec="seconds"
    )
    with db() as conn:
        conn.execute(
            "UPDATE email_codes SET expires_at=? WHERE email=?",
            (expired_at, "rate.limit@corp.example"),
        )
    expired = guest_client.post(
        "/api/auth/email/verify",
        json={"email": "rate.limit@corp.example", "code": "123456"},
    )
    assert expired.status_code == 422
    assert expired.json()["error"]["code"] == "code_expired"


def test_email_not_configured_is_reported(guest_client):
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["smtp"]["host"] = ""
    payload["email"]["smtp"]["fromEmail"] = ""
    settings_service.save(payload)
    response = guest_client.post("/api/auth/email/request", json={"email": "someone@corp.example"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "email_not_configured"


def test_id_conflict_is_rejected_before_sending(guest_client, monkeypatch):
    _configure_email()
    captured = _capture_codes(monkeypatch)
    response = guest_client.post(
        "/api/auth/email/request", json={"email": "lin.zhixia@other.example"}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "user_id_conflict"
    assert captured == {}


def test_logout_clears_session(guest_client, monkeypatch):
    _configure_email()
    captured = _capture_codes(monkeypatch)
    guest_client.post("/api/auth/email/request", json={"email": "logout.user@corp.example"})
    guest_client.post(
        "/api/auth/email/verify",
        json={"email": "logout.user@corp.example", "code": captured["code"]},
    )
    assert guest_client.get("/api/auth/me").json()["data"]["authenticated"] is True
    logout = guest_client.post("/api/auth/logout")
    assert logout.status_code == 200
    me = guest_client.get("/api/auth/me").json()["data"]
    assert me["authenticated"] is False
    assert me["source"] == "guest"
