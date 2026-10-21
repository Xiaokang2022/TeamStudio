"""Password-less e-mail login, pre-created accounts (round-8 requirement #4) and sessions.

Round 8 removes the ``account_not_activated`` gate: a pre-created account
(``email_verified=0``) can request a verification code and log in normally; a successful
verification marks it activated. One-time activation links stay available as a shortcut.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from backend.app.config import settings_service
from backend.app.db import db, row
from backend.tests.helpers import (
    capture_email_codes,
    data,
    email_login,
    enable_email,
    error,
    me,
    member_by_email,
    remote_client,
)


def _activation_path(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.path}?{parts.query}"


# --------------------------------------------------------------------------- registration / login


def test_email_code_registers_and_logs_in(guest_client, monkeypatch):
    enable_email()
    captured = capture_email_codes(monkeypatch)

    requested = guest_client.post(
        "/api/auth/email/request", json={"email": "Alice.New@Corp.Example"}
    )
    assert requested.status_code == 200
    payload = data(requested)
    assert payload["sent"] is True
    assert payload["purpose"] == "register"
    assert payload["registered"] is False
    assert payload["codeLength"] == 6
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
    assert error(rejected)["code"] == "code_mismatch"
    assert error(rejected)["details"]["remainingAttempts"] == 4

    verified = guest_client.post(
        "/api/auth/email/verify", json={"email": "alice.new@corp.example", "code": code}
    )
    assert verified.status_code == 200
    result = data(verified)
    assert result["loggedIn"] is True
    assert result["isNewUser"] is True
    assert result["user"]["id"] == "alice.new"
    assert result["user"]["role"] == "member"
    assert "Max-Age=604800" in verified.headers.get("set-cookie", "")

    payload = me(guest_client)
    assert payload["authenticated"] is True
    assert payload["source"] == "email"
    assert payload["id"] == "alice.new"
    assert payload["email"] == "alice.new@corp.example"
    assert payload["isSuperAdmin"] is False
    assert payload["admin"]["role"] is None
    assert payload["admin"]["teamIds"] == []
    assert payload["permissions"]["canEditSettings"] is False

    # Session is sliding: bootstrap re-issues the cookie.
    boot = guest_client.get("/api/bootstrap")
    assert boot.status_code == 200
    assert "Max-Age" in boot.headers.get("set-cookie", "")


def test_unactivated_precreated_account_can_request_code_and_login(client, monkeypatch):
    """Requirement #4: no ``account_not_activated`` gate for pre-created accounts."""
    created = create_account_via_api(client, "future.member@corp.example", "预创建成员")
    assert created["emailVerified"] is False

    enable_email()
    captured = capture_email_codes(monkeypatch)
    with remote_client("10.20.30.61", 51201) as browser:
        requested = browser.post(
            "/api/auth/email/request", json={"email": "future.member@corp.example"}
        )
        # The old 403 ``account_not_activated`` branch must be gone.
        assert requested.status_code == 200, requested.text
        payload = data(requested)
        assert payload["sent"] is True
        assert payload["purpose"] in {"register", "login"}
        code = captured["code"]

        verified = browser.post(
            "/api/auth/email/verify",
            json={"email": "future.member@corp.example", "code": code},
        )
        assert verified.status_code == 200, verified.text
        assert data(verified)["loggedIn"] is True

        payload = me(browser)
        assert payload["authenticated"] is True
        assert payload["id"] == "future.member"
        assert payload["emailVerified"] is True
        assert payload["source"] == "email"

    # A successful verification marks the stored account as activated.
    with db() as conn:
        account = row(
            conn, "SELECT email_verified FROM users WHERE email=?", ("future.member@corp.example",)
        )
    assert account is not None
    assert account["email_verified"] == 1


def test_seeded_account_login_links_member_profile(client, monkeypatch):
    member = member_by_email(client, "lin.zhixia@corp.example")
    with remote_client("10.20.30.62", 51202) as browser:
        email_login(browser, "lin.zhixia@corp.example", monkeypatch)
        payload = me(browser)
        assert payload["id"] == "lin.zhixia"
        assert payload["name"] == "林知夏"
        assert payload["linkedMemberId"] == member["id"]
        assert payload["linkedMemberIds"] == [member["id"]]
        assert payload["admin"]["teamIds"] == []
        assert payload["permissions"]["canEditSelf"] is True

        # Team scoped content is readable after login.
        assert browser.get("/api/teams/team-aurora/overview").status_code == 200


# --------------------------------------------------------------------------- activation link (optional)


def test_activation_link_is_an_optional_shortcut(client):
    payload = settings_service.get().model_dump(mode="json")
    payload["email"]["enabled"] = False
    payload["email"]["smtp"]["host"] = ""
    payload["email"]["smtp"]["fromEmail"] = ""
    payload["auth"]["emailLogin"]["precreatedActivationMinutes"] = 5
    settings_service.save(payload)

    created = create_account_via_api(client, "invited.user@corp.example", "待激活成员")
    assert created["emailVerified"] is False
    activation = data(
        client.post("/api/users/invited.user/activation-link")
    )["activation"]
    assert activation is not None
    path = _activation_path(activation["url"])

    with remote_client("10.20.30.63", 51203) as browser:
        opened = browser.get(path, follow_redirects=False)
        assert opened.status_code == 303
        assert opened.headers["location"] == "/#/overview"
        assert "teamstudio_session" in opened.headers.get("set-cookie", "")
        signed_in = me(browser)
        assert signed_in["id"] == "invited.user"
        assert signed_in["name"] == "待激活成员"
        assert signed_in["emailVerified"] is True
        assert signed_in["authenticated"] is True

        # One-time use: the same link reports as already used.
        reused = browser.get(path, follow_redirects=False)
        assert reused.status_code == 303
        assert "activation=used" in reused.headers["location"]


def test_activation_link_expiry_and_regeneration(client):
    payload = settings_service.get().model_dump(mode="json")
    payload["auth"]["emailLogin"]["precreatedActivationMinutes"] = 5
    settings_service.save(payload)
    created = create_account_via_api(client, "expired.link@corp.example", "过期链接")
    user_id = created["id"]
    activation = data(client.post(f"/api/users/{user_id}/activation-link"))["activation"]
    old_path = _activation_path(activation["url"])

    with db() as conn:
        expired_at = (
            datetime.now(timezone.utc).astimezone() - timedelta(seconds=1)
        ).isoformat(timespec="seconds")
        conn.execute(
            "UPDATE user_activation_tokens SET expires_at=? WHERE user_id=?",
            (expired_at, user_id),
        )

    with remote_client("10.20.30.64", 51204) as browser:
        expired = browser.get(old_path, follow_redirects=False)
        assert expired.status_code == 303
        assert "activation=expired" in expired.headers["location"]
        assert me(browser)["authenticated"] is False

    renewed = data(client.post(f"/api/users/{user_id}/activation-link"))["activation"]
    new_path = _activation_path(renewed["url"])
    with remote_client("10.20.30.65", 51205) as browser:
        opened = browser.get(new_path, follow_redirects=False)
        assert opened.status_code == 303
        assert opened.headers["location"] == "/#/overview"
        assert me(browser)["id"] == user_id

    # Already activated accounts cannot get another link.
    already = client.post(f"/api/users/{user_id}/activation-link")
    assert already.status_code == 409
    assert error(already)["code"] == "account_already_activated"


# --------------------------------------------------------------------------- validation / limits


def test_request_code_rate_limit_and_expiry(guest_client, monkeypatch):
    enable_email()
    capture_email_codes(monkeypatch)
    first = guest_client.post("/api/auth/email/request", json={"email": "rate.limit@corp.example"})
    assert first.status_code == 200

    limited = guest_client.post("/api/auth/email/request", json={"email": "rate.limit@corp.example"})
    assert limited.status_code == 429
    assert error(limited)["code"] == "code_rate_limited"
    assert error(limited)["details"]["retryAfterSeconds"] >= 1

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
    assert error(expired)["code"] == "code_expired"


def test_email_not_configured_is_reported(guest_client):
    payload = settings_service.get().model_dump(mode="json")
    payload["email"]["enabled"] = False
    payload["email"]["smtp"]["host"] = ""
    payload["email"]["smtp"]["fromEmail"] = ""
    settings_service.save(payload)
    response = guest_client.post("/api/auth/email/request", json={"email": "someone@corp.example"})
    assert response.status_code in (422, 503)
    assert error(response)["code"] in {"email_not_configured", "email_login_disabled"}


def test_id_conflict_is_rejected_before_sending(guest_client, monkeypatch):
    enable_email()
    captured = capture_email_codes(monkeypatch)
    response = guest_client.post(
        "/api/auth/email/request", json={"email": "lin.zhixia@other.example"}
    )
    assert response.status_code == 409
    assert error(response)["code"] == "user_id_conflict"
    assert captured == {}


def test_logout_clears_session(guest_client, monkeypatch):
    email_login(guest_client, "logout.user@corp.example", monkeypatch)
    assert me(guest_client)["authenticated"] is True
    logout = guest_client.post("/api/auth/logout")
    assert logout.status_code == 200
    payload = me(guest_client)
    assert payload["authenticated"] is False
    assert payload["source"] == "guest"


# --------------------------------------------------------------------------- helpers


def create_account_via_api(client, email: str, name: str = "") -> dict:
    payload = {"email": email}
    if name:
        payload["name"] = name
    response = client.post("/api/users", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["data"]["user"]
