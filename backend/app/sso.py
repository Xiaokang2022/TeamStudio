"""Minimal, dependency-light OpenID Connect authorization-code + PKCE client."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import urllib.parse
from typing import Any
from urllib.parse import urlencode

import httpx

from .auth import SessionIdentity, sign_payload, unsign_payload
from .config import DATA_DIR, settings_service


class SsoError(Exception):
    def __init__(self, message: str, code: str = "sso_error") -> None:
        super().__init__(message)
        self.code = code


_DISCOVERY_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_PATH = DATA_DIR / ".oidc_discovery.json"


def _load_disk_cache() -> dict[str, Any]:
    try:
        return json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_disk_cache(data: dict[str, Any]) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def discover() -> dict[str, Any]:
    sso = settings_service.get().auth.sso
    if not sso.issuer:
        raise SsoError("SSO issuer 未配置", "sso_unconfigured")
    cached = _DISCOVERY_CACHE.get(sso.issuer)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]
    disk = _load_disk_cache().get(sso.issuer)
    if disk and time.time() - int(disk.get("_cachedAt", 0)) < 86400:
        result = {k: v for k, v in disk.items() if not k.startswith("_")}
        _DISCOVERY_CACHE[sso.issuer] = (time.time(), result)
        return result
    url = sso.issuer.rstrip("/") + "/.well-known/openid-configuration"
    try:
        with httpx.Client(timeout=12, follow_redirects=True) as client:
            response = client.get(url, headers={"Accept": "application/json"})
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise SsoError(f"无法读取 SSO 配置发现文档: {exc}", "sso_discovery_failed") from exc
    if not data.get("authorization_endpoint") or not data.get("token_endpoint"):
        raise SsoError("SSO 发现文档缺少必要端点", "sso_discovery_incomplete")
    _DISCOVERY_CACHE[sso.issuer] = (time.time(), data)
    cache = _load_disk_cache()
    cache[sso.issuer] = {**data, "_cachedAt": int(time.time())}
    _save_disk_cache(cache)
    return data


def _endpoints() -> dict[str, str]:
    sso = settings_service.get().auth.sso
    discovered = discover()
    return {
        "authorization": sso.authorizationEndpoint or discovered.get("authorization_endpoint", ""),
        "token": sso.tokenEndpoint or discovered.get("token_endpoint", ""),
        "userinfo": sso.userinfoEndpoint or discovered.get("userinfo_endpoint", ""),
        "end_session": sso.endSessionEndpoint or discovered.get("end_session_endpoint", ""),
    }


def _safe_next(value: str | None) -> str:
    if not value or not value.startswith("/") or value.startswith("//"):
        return "/"
    return value


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def begin_login(next_path: str | None) -> tuple[str, str]:
    sso = settings_service.get().auth.sso
    endpoints = _endpoints()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64)
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state_cookie = sign_payload(
        {
            "state": state,
            "nonce": nonce,
            "verifier": verifier,
            "next": _safe_next(next_path),
            "exp": int(time.time()) + 600,
        }
    )
    params = {
        "response_type": "code",
        "client_id": sso.clientId,
        "redirect_uri": sso.redirectUri,
        "scope": sso.scopes or "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    separator = "&" if "?" in endpoints["authorization"] else "?"
    return endpoints["authorization"] + separator + urlencode(params), state_cookie


def _claim(payload: dict[str, Any], path: str) -> Any:
    current: Any = payload
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    try:
        body = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (IndexError, ValueError, json.JSONDecodeError):
        return {}


def complete_login(code: str, state: str, state_cookie: str | None) -> tuple[SessionIdentity, str]:
    sso = settings_service.get().auth.sso
    saved = unsign_payload(state_cookie)
    if not saved or saved.get("state") != state:
        raise SsoError("登录状态校验失败，请重新发起 SSO 登录", "sso_state_invalid")
    endpoints = _endpoints()
    token_payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": sso.redirectUri,
        "client_id": sso.clientId,
        "client_secret": sso.clientSecret,
        "code_verifier": saved.get("verifier", ""),
    }
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            token_response = client.post(
                endpoints["token"],
                data=token_payload,
                headers={"Accept": "application/json"},
            )
            token_response.raise_for_status()
            tokens = token_response.json()
            access_token = tokens.get("access_token", "")
            claims: dict[str, Any] = {}
            if endpoints["userinfo"] and access_token:
                profile = client.get(
                    endpoints["userinfo"],
                    headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
                )
                if profile.status_code < 400:
                    claims = profile.json()
            if not claims and tokens.get("id_token"):
                claims = _decode_jwt_payload(tokens["id_token"])
    except (httpx.HTTPError, ValueError) as exc:
        raise SsoError(f"SSO 令牌交换失败: {exc}", "sso_token_exchange_failed") from exc

    identifier = _claim(claims, sso.claimId)
    email = _claim(claims, sso.claimEmail) or claims.get("preferred_username") or ""
    name = _claim(claims, sso.claimName) or email or str(identifier or "")
    if not identifier:
        raise SsoError("SSO 用户信息缺少唯一标识", "sso_missing_id")
    if sso.allowedEmailDomains and email:
        domain = str(email).split("@")[-1].lower()
        allowed = {item.lower().lstrip("@") for item in sso.allowedEmailDomains}
        if domain not in allowed:
            raise SsoError("该企业邮箱域名不在允许范围内", "sso_domain_denied")

    identity = SessionIdentity(
        id=str(identifier),
        name=str(name),
        email=str(email),
        provider=sso.providerName or "SSO",
        sub=str(claims.get("sub") or identifier),
    )
    return identity, saved.get("next") or "/"


def logout_url() -> str | None:
    sso = settings_service.get().auth.sso
    if not sso.enabled:
        return None
    try:
        endpoint = _endpoints().get("end_session")
    except SsoError:
        return None
    if not endpoint:
        return None
    return endpoint
