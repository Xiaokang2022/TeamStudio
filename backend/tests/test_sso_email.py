"""SSO protocol construction and the email reminder end-to-end pipeline."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

from backend.app.auth import unsign_payload
from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.db import db, new_id, now_iso
from backend.app.services.email_service import run_reminder_scan
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


class _FakeSMTP:
    instances: list["_FakeSMTP"] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.messages: list = []
        _FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def ehlo(self):
        return None

    def starttls(self, context=None):
        return None

    def login(self, username, password):
        return None

    def send_message(self, message):
        self.messages.append(message)


def test_email_reminder_pipeline_sends_and_deduplicates(client):
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["enabled"] = True
    payload["email"]["smtp"].update(
        {
            "host": "smtp.example.com",
            "port": 25,
            "username": "",
            "password": "",
            "fromEmail": "noreply@example.com",
            "fromName": "TeamStudio 测试",
            "useStartTls": False,
            "useSsl": False,
        }
    )
    payload["email"]["reminders"]["sendTime"] = "00:00"
    payload["email"]["reminders"]["includeAnnouncements"] = True
    settings_service.save(payload)

    _FakeSMTP.instances.clear()
    todo_id = new_id("todo")
    with db() as conn:
        conn.execute(
            "INSERT INTO todos (id,group_id,title,description,due_date,due_time,"
            "assignee_member_id,priority,status,reminder_offsets_days,email_enabled,"
            "created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                todo_id,
                "grp-frontend",
                "邮件链路验收",
                "验证 SMTP 发送、公告附加内容、模板变量与去重。",
                date.today().isoformat(),
                "23:59",
                "m-lin",
                "high",
                "todo",
                "[0]",
                1,
                "Admin",
                now_iso(),
                now_iso(),
            ),
        )

    with patch("backend.app.services.email_service.smtplib.SMTP", _FakeSMTP):
        first = run_reminder_scan()
        second = run_reminder_scan()

    assert first["sent"] >= 1
    assert second["sent"] == 0
    assert len(_FakeSMTP.instances) >= 1
    message = _FakeSMTP.instances[0].messages[0]
    assert "邮件链路验收" in message["Subject"]
    body = message.get_content()
    assert "林知夏" in body
    assert "开发组置顶公告" in body

    logs = client.get("/api/email/logs").json()["data"]["logs"]
    assert any(log.get("todo_id") == todo_id and log["status"] == "sent" for log in logs)
    status = client.get("/api/email/status").json()["data"]
    assert status["smtpConfigured"] is True
    assert status["sentToday"] >= 1

    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
