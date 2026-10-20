"""Identity, signed-cookie sessions, IP/ID admin whitelist and permission helpers."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from .config import DATA_DIR, settings_service
from .db import db, row

SESSION_COOKIE_FALLBACK = "teamstudio_session"
STATE_COOKIE = "teamstudio_sso_state"
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1", "testclient"}


class SessionIdentity(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str = ""
    email: str = ""
    provider: str = "sso"
    sub: str = ""
    exp: int = 0
    groups: list[str] = []


@dataclass
class CurrentUser:
    id: str
    name: str
    email: str = ""
    authenticated: bool = False
    source: str = "guest"  # local | sso | ip | guest
    is_device_admin: bool = False
    admin_role: str | None = None
    team_ids: set[str] = field(default_factory=set)
    group_ids: set[str] = field(default_factory=set)
    linked_member_id: str | None = None
    linked_member_name: str | None = None
    sso_configured: bool = False

    @property
    def is_admin(self) -> bool:
        return self.is_device_admin or self.admin_role is not None

    def can_edit_settings(self) -> bool:
        return self.is_device_admin

    def can_edit_group(self, team_id: str, group_id: str) -> bool:
        if self.is_device_admin:
            return True
        return group_id in self.group_ids or team_id in self.team_ids

    def can_edit_any_group(self) -> bool:
        return self.is_device_admin or bool(self.team_ids or self.group_ids)

    def can_manage_team(self, team_id: str) -> bool:
        """The device Admin manages every team; a team_admin only its own ``teamIds``."""
        return self.is_device_admin or team_id in self.team_ids

    def can_create_team(self) -> bool:
        """Creating a whole team is reserved for the device Admin."""
        return self.is_device_admin

    def require_team_manager(self, team_id: str) -> None:
        """Raise 403 ``not_admin`` unless the user may restructure ``team_id``."""
        if not self.can_manage_team(team_id):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "not_admin",
                    "message": "你没有该团队的管理权限",
                    "details": None,
                },
            )

    def can_edit_self(self) -> bool:
        return bool(self.linked_member_id) and settings_service.get().features.allowMemberSelfEdit

    def ensure_group(self, team_id: str, group_id: str) -> None:
        if not self.can_edit_group(team_id, group_id):
            raise HTTPException(status_code=403, detail="你没有该开发组的管理权限")

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "authenticated": self.authenticated,
            "source": self.source,
            "isDeviceAdmin": self.is_device_admin,
            "admin": {
                "role": self.admin_role,
                "teamIds": sorted(self.team_ids),
                "groupIds": sorted(self.group_ids),
            },
            "linkedMemberId": self.linked_member_id,
            "linkedMemberName": self.linked_member_name,
            "ssoConfigured": self.sso_configured,
            "permissions": {
                "canEditSettings": self.can_edit_settings(),
                "canEditAny": self.can_edit_any_group(),
                "canEditSelf": self.can_edit_self(),
                "canManageEmail": self.is_device_admin,
            },
        }


def _secret_path() -> Path:
    return DATA_DIR / ".session_secret"


def _load_secret() -> bytes:
    env = os.environ.get("TEAMSTUDIO_SESSION_SECRET")
    if env:
        return env.encode("utf-8")
    path = _secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raw = path.read_text(encoding="utf-8").strip()
        if raw:
            return raw.encode("utf-8")
    secret = base64.urlsafe_b64encode(os.urandom(48)).decode("ascii")
    path.write_text(secret + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret.encode("utf-8")


_SECRET = _load_secret()


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def sign_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    body = _b64encode(raw)
    signature = hmac.new(_SECRET, body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64encode(signature)}"


def unsign_payload(token: str | None) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    try:
        body, signature = token.rsplit(".", 1)
        expected = hmac.new(_SECRET, body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64decode(signature)):
            return None
        payload = json.loads(_b64decode(body))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def create_session_token(identity: SessionIdentity, max_age_days: int) -> str:
    payload = identity.model_dump(mode="json")
    payload["exp"] = int(time.time()) + max_age_days * 86400
    return sign_payload(payload)


def read_session(request: Request) -> SessionIdentity | None:
    cookie_name = settings_service.get().auth.session.cookieName or SESSION_COOKIE_FALLBACK
    payload = unsign_payload(request.cookies.get(cookie_name))
    if not payload:
        return None
    try:
        return SessionIdentity.model_validate(payload)
    except ValueError:
        return None


def set_session_cookie(response: Any, identity: SessionIdentity) -> None:
    cfg = settings_service.get()
    token = create_session_token(identity, cfg.auth.session.maxAgeDays)
    response.set_cookie(
        key=cfg.auth.session.cookieName or SESSION_COOKIE_FALLBACK,
        value=token,
        max_age=cfg.auth.session.maxAgeDays * 86400,
        httponly=True,
        samesite="lax",
        secure=cfg.auth.session.secureCookie,
        path="/",
    )


def clear_session_cookie(response: Any) -> None:
    cfg = settings_service.get()
    response.delete_cookie(cfg.auth.session.cookieName or SESSION_COOKIE_FALLBACK, path="/")


def _local_addresses() -> set[str]:
    addresses = {"127.0.0.1", "::1", "localhost", "testclient"}
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            address = info[4][0]
            if address:
                addresses.add(address)
        for address in socket.gethostbyname_ex(hostname)[2]:
            addresses.add(address)
    except OSError:
        pass
    return addresses


_LOCAL_ADDRESSES = _local_addresses()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded and os.environ.get("TEAMSTUDIO_TRUST_PROXY", "0") == "1":
        return forwarded
    return request.client.host if request.client else ""


def is_local_request(request: Request) -> bool:
    # Do not treat a reverse proxy on the deployment host as the device itself.
    # When proxy headers are present without an explicit trust opt-in, refuse the
    # built-in Admin identity; the operator can still use a direct loopback URL.
    forwarded_headers = (
        request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
        or request.headers.get("forwarded")
    )
    if forwarded_headers and os.environ.get("TEAMSTUDIO_TRUST_PROXY", "0") != "1":
        return False
    host = client_ip(request)
    if host in _LOCAL_ADDRESSES:
        return True
    try:
        address = ipaddress.ip_address(host)
        return address.is_loopback or host in _LOCAL_ADDRESSES
    except ValueError:
        return False


def match_ip_admin(ip_value: str) -> tuple[list[Any], str]:
    if not ip_value:
        return [], ""
    try:
        address = ipaddress.ip_address(ip_value)
    except ValueError:
        return [], ""
    entries = settings_service.get().auth.adminWhitelist.ips
    matched = []
    display = ""
    for entry in entries:
        try:
            network = ipaddress.ip_network(entry.ip, strict=False)
        except ValueError:
            continue
        if address in network:
            matched.append(entry)
            display = display or entry.name
    return matched, display


def match_id_admin(identity: SessionIdentity) -> list[Any]:
    cfg = settings_service.get().auth.adminWhitelist.ids
    candidates = {identity.id.lower(), identity.email.lower(), identity.sub.lower()}
    candidates.discard("")
    matched = []
    for entry in cfg:
        if entry.id.lower() in candidates:
            matched.append(entry)
    return matched


def merge_scopes(entries: list[Any]) -> tuple[set[str], set[str]]:
    team_ids: set[str] = set()
    group_ids: set[str] = set()
    for entry in entries:
        if entry.role == "team_admin" and entry.teamId:
            team_ids.add(entry.teamId)
        if entry.role == "group_admin":
            group_ids.update(entry.groupIds)
    return team_ids, group_ids


def _linked_member(identity: SessionIdentity) -> dict[str, Any] | None:
    candidates = [identity.id, identity.email, identity.sub]
    lowered = [value.lower() for value in candidates if value]
    if not lowered:
        return None
    with db() as conn:
        for value in lowered:
            found = row(
                conn,
                "SELECT id, name FROM members WHERE lower(external_id)=? OR lower(email)=? "
                "ORDER BY sort_order LIMIT 1",
                (value, value),
            )
            if found:
                return found
    return None


def build_user(request: Request) -> CurrentUser:
    cfg = settings_service.get()
    sso_configured = settings_service.sso_configured()
    ip_value = client_ip(request)

    if is_local_request(request):
        return CurrentUser(
            id="device-admin",
            name="Admin",
            authenticated=True,
            source="local",
            is_device_admin=True,
            admin_role="super",
            sso_configured=sso_configured,
        )

    identity = read_session(request)
    ip_entries, ip_display = match_ip_admin(ip_value)
    entries: list[Any] = list(ip_entries)
    if identity:
        entries.extend(match_id_admin(identity))

    team_ids, group_ids = merge_scopes(entries)
    role: str | None = None
    if team_ids:
        role = "team_admin"
    elif group_ids:
        role = "group_admin"

    linked = _linked_member(identity) if identity else None

    if identity:
        return CurrentUser(
            id=identity.id,
            name=identity.name or identity.id,
            email=identity.email,
            authenticated=True,
            source="sso",
            admin_role=role,
            team_ids=team_ids,
            group_ids=group_ids,
            linked_member_id=linked["id"] if linked else None,
            linked_member_name=linked["name"] if linked else None,
            sso_configured=sso_configured,
        )

    if entries:
        return CurrentUser(
            id=f"ip:{ip_value}",
            name=ip_display or "IP 管理员",
            authenticated=True,
            source="ip",
            admin_role=role or "team_admin",
            team_ids=team_ids,
            group_ids=group_ids,
            sso_configured=sso_configured,
        )

    return CurrentUser(
        id="guest",
        name="访客",
        authenticated=False,
        source="guest",
        sso_configured=sso_configured,
    )


def get_current_user(request: Request) -> CurrentUser:
    return build_user(request)


CurrentUserDep = Depends(get_current_user)


def require_super(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_device_admin:
        raise HTTPException(status_code=403, detail="仅部署设备的 Admin 可执行此操作")
    return user


def require_group_admin(
    team_id: str, group_id: str, user: CurrentUser = Depends(get_current_user)
) -> CurrentUser:
    user.ensure_group(team_id, group_id)
    return user


def require_authenticated(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.authenticated:
        raise HTTPException(status_code=401, detail="请先登录或使用管理员设备")
    return user


def require_sso_configured() -> None:
    if not settings_service.sso_configured():
        raise HTTPException(status_code=400, detail="企业 SSO 尚未配置完整")
