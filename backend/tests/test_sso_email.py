"""SSO protocol construction and the external SMTP e-mail settings.

Round 5 removed the bundled SMTP server, the local mailbox and every calendar
reminder/e-mail setting. ``email`` now only describes the external relay used to
deliver six-digit verification codes (see ROUND5_CONTRACT §5).
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

from backend.app.auth import unsign_payload
from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app import sso


def _settings_with_sso(enabled: bool = True) -> dict:
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["auth"]["sso"].update(
        {
            "enabled": enabled,
            "issuer": "https://sso.example.com",
            "clientId": "teamstudio-client",
            "clientSecret": "secret",
            "redirectUri": "http://127.0.0.1:8000/api/auth/callback",
            "providerName": "Example SSO",
        }
    )
    return payload


def test_sso_begin_login_has_pkce_and_signed_state(monkeypatch):
    settings_service.save(_settings_with_sso())
    monkeypatch.setattr(
        sso,
        "discover",
        lambda: {
            "authorization_endpoint": "https://sso.example.com/authorize",
            "token_endpoint": "https://sso.example.com/token",
            "userinfo_endpoint": "https://sso.example.com/userinfo",
        },
    )
    url, state_cookie = sso.begin_login("/calendar?month=2026-10")
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    assert parsed.netloc == "sso.example.com"
    assert query["client_id"] == ["teamstudio-client"]
    assert query["response_type"] == ["code"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"][0]
    assert query["state"][0]
    state_payload = unsign_payload(state_cookie)
    assert state_payload is not None
    assert state_payload["state"] == query["state"][0]
    assert state_payload["next"] == "/calendar?month=2026-10"
    assert state_payload["verifier"]


def test_sso_unconfigured_falls_back_to_guest(guest_client):
    base = guest_client.get("/api/auth/config").json()["data"]
    assert base["sso"]["configured"] is False
    response = guest_client.get("/api/auth/login", follow_redirects=False)
    assert response.status_code == 303
    assert "sso=unconfigured" in response.headers["location"]

    settings_service.save(_settings_with_sso(enabled=True))
    # Still unconfigured when required fields are missing.
    payload = _settings_with_sso()
    payload["auth"]["sso"]["clientId"] = ""
    settings_service.save(payload)
    assert settings_service.sso_configured() is False


def test_email_settings_use_external_smtp_schema(client):
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["enabled"] = True
    payload["email"]["smtp"].update(
        {
            "host": "smtp.example.com",
            "port": 25,
            "username": "relay-user",
            "password": "relay-secret",
            "fromEmail": "noreply@example.com",
            "fromName": "TeamStudio 测试",
            "useStartTls": False,
            "useSsl": False,
            "timeoutSeconds": 10,
        }
    )
    # Round-4 leftovers are accepted on save but stripped from the stored settings.
    payload["email"]["deliveryMode"] = "smtp"
    payload["email"]["builtin"] = {"enabled": True}
    payload["email"]["reminders"] = {"sendTime": "09:00", "includeAnnouncements": True}
    payload["calendar"].update(
        {
            "defaultReminderOffsetsDays": [3, 1, 0],
            "defaultReminderTime": "09:00",
            "defaultEmailEnabled": True,
        }
    )
    settings_service.save(payload)

    cfg = settings_service.get()
    assert cfg.email.smtp.host == "smtp.example.com"
    assert cfg.email.smtp.port == 25
    assert cfg.email.smtp.useStartTls is False
    assert cfg.email.smtp.fromEmail == "noreply@example.com"
    for removed in ("deliveryMode", "builtin", "reminders"):
        assert not hasattr(cfg.email, removed)
    for removed in ("defaultReminderOffsetsDays", "defaultReminderTime", "defaultEmailEnabled"):
        assert not hasattr(cfg.calendar, removed)
    assert settings_service.email_configured() is True

    status = client.get("/api/email/status").json()["data"]
    assert status["enabled"] is True
    assert status["configured"] is True
    assert status["host"] == "smtp.example.com"
    assert status["port"] == 25
    assert status["fromEmail"] == "noreply@example.com"
    assert status["useStartTls"] is False
    # The relay password never leaves the server.
    serialized = json.dumps(status)
    assert "relay-secret" not in serialized
    assert "password" not in serialized

    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
