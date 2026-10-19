"""OIDC callback behavior with a mocked identity provider."""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from backend.app import sso
from backend.app.config import DEFAULT_SETTINGS, settings_service


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise sso.httpx.HTTPStatusError("failed", request=None, response=None)  # type: ignore[arg-type]

    def json(self) -> dict:
        return self._payload


class FakeClient:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs

    def __enter__(self) -> "FakeClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def post(self, url: str, data=None, headers=None) -> FakeResponse:
        assert data["grant_type"] == "authorization_code"
        assert data["code"] == "auth-code"
        assert data["code_verifier"]
        return FakeResponse({"access_token": "access-token", "id_token": ""})

    def get(self, url: str, headers=None) -> FakeResponse:
        assert headers["Authorization"] == "Bearer access-token"
        return FakeResponse(
            {
                "sub": "sso-subject-001",
                "name": "林知夏",
                "email": "lin.zhixia@corp.example",
                "preferred_username": "lin.zhixia",
            }
        )


def _configure_sso() -> None:
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["auth"]["sso"].update(
        {
            "enabled": True,
            "issuer": "https://idp.example.com",
            "clientId": "teamstudio",
            "clientSecret": "secret",
            "redirectUri": "http://127.0.0.1:8000/api/auth/callback",
            "providerName": "企业 IdP",
        }
    )
    settings_service.save(payload)


def test_complete_login_maps_claims_and_returns_next(monkeypatch):
    _configure_sso()
    monkeypatch.setattr(
        sso,
        "discover",
        lambda: {
            "authorization_endpoint": "https://idp.example.com/authorize",
            "token_endpoint": "https://idp.example.com/token",
            "userinfo_endpoint": "https://idp.example.com/userinfo",
        },
    )
    monkeypatch.setattr(sso.httpx, "Client", FakeClient)
    login_url, state_cookie = sso.begin_login("/calendar?month=2026-10")
    state = parse_qs(urlparse(login_url).query)["state"][0]
    identity, next_path = sso.complete_login("auth-code", state, state_cookie)
    assert identity.id == "sso-subject-001"
    assert identity.name == "林知夏"
    assert identity.email == "lin.zhixia@corp.example"
    assert identity.sub == "sso-subject-001"
    assert identity.provider == "企业 IdP"
    assert next_path == "/calendar?month=2026-10"


def test_complete_login_rejects_tampered_state(monkeypatch):
    _configure_sso()
    monkeypatch.setattr(
        sso,
        "discover",
        lambda: {
            "authorization_endpoint": "https://idp.example.com/authorize",
            "token_endpoint": "https://idp.example.com/token",
            "userinfo_endpoint": "https://idp.example.com/userinfo",
        },
    )
    _, state_cookie = sso.begin_login("/")
    with pytest.raises(sso.SsoError) as exc:
        sso.complete_login("code", "tampered-state", state_cookie)
    assert exc.value.code == "sso_state_invalid"


def test_domain_allowlist_denies_unlisted_email(monkeypatch):
    _configure_sso()
    payload = settings_service.get().model_dump(mode="json")
    payload["auth"]["sso"]["allowedEmailDomains"] = ["other.example"]
    settings_service.save(payload)
    monkeypatch.setattr(
        sso,
        "discover",
        lambda: {
            "authorization_endpoint": "https://idp.example.com/authorize",
            "token_endpoint": "https://idp.example.com/token",
            "userinfo_endpoint": "https://idp.example.com/userinfo",
        },
    )
    monkeypatch.setattr(sso.httpx, "Client", FakeClient)
    login_url, state_cookie = sso.begin_login("/")
    state = parse_qs(urlparse(login_url).query)["state"][0]
    with pytest.raises(sso.SsoError) as exc:
        sso.complete_login("auth-code", state, state_cookie)
    assert exc.value.code == "sso_domain_denied"
    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
