"""Shared helpers for the round-8 (team-only) backend test suite.

The suite talks to the real FastAPI application through ``TestClient`` and uses only the
public round-8 API contract (``docs/ROUND8_CONTRACT.md``): no group ids, no ``scope``
query parameter and every business route below ``/api/teams/{team_id}``. Identities are
produced the same way a browser produces them (email code login, signed session, admin
IP whitelist), so the tests also cover the authentication plumbing.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

from fastapi.testclient import TestClient

# Seeded demo teams (stable ids, see backend/app/seed.py).
TEAM_AURORA = "team-aurora"
TEAM_VOYAGE = "team-voyage"

# Minimal 1x1 PNG used by the avatar tests.
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


# --------------------------------------------------------------------------- responses


def data(response) -> Any:
    """Assert a successful ``{"ok": true, "data": ...}`` envelope and return ``data``."""
    assert response.status_code == 200, (
        f"{response.request.method} {response.request.url} -> "
        f"{response.status_code}: {response.text[:1200]}"
    )
    body = response.json()
    assert body.get("ok") is True, body
    return body["data"]


def error(response) -> dict[str, Any]:
    """Assert a failure envelope and return its ``error`` object."""
    body = response.json()
    assert body.get("ok") is False, body
    return body["error"]


def assert_error(response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    payload = error(response)
    assert payload["code"] == code, payload
    return payload


# --------------------------------------------------------------------------- teams / overview


def bootstrap(client: TestClient, team_id: str | None = None) -> dict[str, Any]:
    path = "/api/bootstrap"
    if team_id:
        path += f"?teamId={team_id}"
    return data(client.get(path))


def team_ids(client: TestClient) -> list[str]:
    return [item["id"] for item in bootstrap(client)["teams"]]


def team_base(team_id: str) -> str:
    return f"/api/teams/{team_id}"


def overview(client: TestClient, team_id: str = TEAM_AURORA) -> dict[str, Any]:
    return data(client.get(f"{team_base(team_id)}/overview"))


def members_of(client: TestClient, team_id: str = TEAM_AURORA) -> list[dict[str, Any]]:
    return overview(client, team_id)["members"]


def member_by_id(
    client: TestClient, member_id: str, team_id: str = TEAM_AURORA
) -> dict[str, Any]:
    for member in members_of(client, team_id):
        if member_id in member.get("memberIds", [member["id"]]):
            return member
    raise AssertionError(f"member {member_id!r} not found in team {team_id!r}")


def member_by_email(
    client: TestClient, email: str, team_id: str = TEAM_AURORA
) -> dict[str, Any]:
    lowered = email.lower()
    for member in members_of(client, team_id):
        if (member.get("email") or "").lower() == lowered:
            return member
    raise AssertionError(f"member with email {email!r} not found in team {team_id!r}")


def tasks_payload(client: TestClient, team_id: str = TEAM_AURORA) -> dict[str, Any]:
    return data(client.get(f"{team_base(team_id)}/tasks"))


def insights_payload(
    client: TestClient, team_id: str = TEAM_AURORA, range_key: str | None = None
) -> dict[str, Any]:
    path = f"{team_base(team_id)}/insights"
    if range_key:
        path += f"?range={range_key}"
    return data(client.get(path))


# --------------------------------------------------------------------------- remote clients


@contextmanager
def remote_client(ip: str = "10.20.30.99", port: int = 53000) -> Iterator[TestClient]:
    """A browser-like client that reaches the app from a configurable source IP."""
    from backend.app.main import app

    with TestClient(app, client=(ip, port), raise_server_exceptions=False) as client:
        yield client


# --------------------------------------------------------------------------- email login


def enable_email(*, enabled: bool = True) -> None:
    """Configure a syntactically valid SMTP relay on top of the current settings."""
    from backend.app.config import settings_service

    payload = settings_service.get().model_dump(mode="json")
    payload.setdefault("email", {})
    payload["email"]["enabled"] = enabled
    smtp = payload["email"].setdefault("smtp", {})
    smtp.update(
        {
            "host": "127.0.0.1",
            "port": 2525,
            "username": "noreply@corp.example",
            "password": "smtp-secret",
            "fromEmail": "noreply@corp.example",
        }
    )
    settings_service.save(payload)


def capture_email_codes(monkeypatch) -> dict[str, Any]:
    """Replace the verification mail sender and capture the generated code."""
    captured: dict[str, Any] = {}

    def fake_send(
        *,
        recipient: str,
        code: str,
        purpose: str = "login",
        expires_minutes: int = 10,
        **_kwargs: Any,
    ) -> None:
        captured.update(
            recipient=recipient, code=code, purpose=purpose, expires=expires_minutes
        )

    patched = False
    try:
        from backend.app.routers import auth as auth_router

        if hasattr(auth_router, "send_verification_code"):
            monkeypatch.setattr(auth_router, "send_verification_code", fake_send)
            patched = True
    except Exception:  # pragma: no cover - import errors surface in the test itself
        pass
    try:
        from backend.app.services import email_service

        if hasattr(email_service, "send_verification_code"):
            monkeypatch.setattr(email_service, "send_verification_code", fake_send)
            patched = True
    except Exception:  # pragma: no cover
        pass
    assert patched, "the verification-code sender could not be intercepted"
    return captured


def email_login(client: TestClient, email: str, monkeypatch) -> dict[str, Any]:
    """Perform the full password-less login flow and return the ``verify`` data."""
    enable_email()
    captured = capture_email_codes(monkeypatch)
    requested = client.post("/api/auth/email/request", json={"email": email})
    assert requested.status_code == 200, requested.text
    code = captured.get("code")
    assert code, "no verification code was captured"
    verified = client.post("/api/auth/email/verify", json={"email": email, "code": code})
    assert verified.status_code == 200, verified.text
    return verified.json()["data"]


def me(client: TestClient) -> dict[str, Any]:
    return data(client.get("/api/auth/me"))


# --------------------------------------------------------------------------- sessions / admin roles


def session_token(
    user_id: str, *, email: str = "", name: str = "", provider: str = "email"
) -> str:
    from backend.app.auth import SessionIdentity, create_session_token

    identity = SessionIdentity(
        id=user_id,
        name=name or user_id,
        email=email or f"{user_id}@corp.example",
        provider=provider,
    )
    return create_session_token(identity, 7)


def sign_in(
    client: TestClient,
    user_id: str,
    *,
    email: str = "",
    name: str = "",
    provider: str = "email",
) -> None:
    client.cookies.set(
        "teamstudio_session",
        session_token(user_id, email=email, name=name, provider=provider),
    )


def save_admin_whitelist(
    *, ips: list[dict[str, Any]] | None = None, ids: list[dict[str, Any]] | None = None
) -> None:
    from backend.app.config import settings_service

    payload = settings_service.get().model_dump(mode="json")
    whitelist = payload["auth"]["adminWhitelist"]
    if ips is not None:
        whitelist["ips"] = ips
    if ids is not None:
        whitelist["ids"] = ids
    settings_service.save(payload)


@contextmanager
def ip_admin(
    team_id: str = TEAM_AURORA, *, ip: str = "10.90.1.23", port: int = 53100
) -> Iterator[TestClient]:
    """A client whose source IP is whitelisted as ``team_admin`` of one team."""
    save_admin_whitelist(
        ips=[
            {
                "ip": ip,
                "name": "楼层管理员",
                "role": "team_admin",
                "teamId": team_id,
            }
        ]
    )
    with remote_client(ip, port) as client:
        yield client


# --------------------------------------------------------------------------- accounts / members


def create_account(
    client: TestClient,
    email: str,
    *,
    name: str = "",
    role: str | None = None,
    team_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Create a pre-created account through the super-admin users API."""
    payload: dict[str, Any] = {"email": email}
    if name:
        payload["name"] = name
    if role:
        payload["role"] = role
    if team_ids is not None:
        payload["teamIds"] = list(team_ids)
    response = client.post("/api/users", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["data"]["user"]


def create_member(
    client: TestClient,
    user_id: str,
    *,
    team_id: str = TEAM_AURORA,
    **fields: Any,
) -> dict[str, Any]:
    """Create a member archive from an existing account."""
    payload: dict[str, Any] = {"userId": user_id, **fields}
    response = client.post(f"{team_base(team_id)}/members", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["data"]["member"]


def upload_avatar(client: TestClient, data: bytes = PNG_BYTES) -> str:
    response = client.post(
        "/api/profile/avatar",
        files={"file": ("avatar.png", data, "image/png")},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["avatar"]


def login_seeded_member(
    client: TestClient, member: dict[str, Any], monkeypatch
) -> dict[str, Any]:
    """Log the account of a seeded member in and return ``/api/auth/me``."""
    email = member.get("email") or ""
    assert email, f"seeded member {member['id']} has no e-mail"
    email_login(client, email, monkeypatch)
    return me(client)


def linked_member_id(client: TestClient) -> str:
    value = me(client).get("linkedMemberId")
    assert value, "the signed-in identity is not linked to a member profile"
    return value
