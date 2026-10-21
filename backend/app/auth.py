"""Identity, signed-cookie sessions, IP/ID admin whitelist and permission helpers.

Round 8 makes the **team** the only organisation unit:

* account roles are ``member`` / ``team_admin`` / ``super`` (``group_admin`` is gone);
* a ``team_admin`` is scoped by ``team_ids`` and may manage that team's structure;
* e-mail accounts are still password-less: a registered account's id is the e-mail local
  part and may only be changed by a super administrator;
* the deployment device keeps the built-in ``Admin`` identity (super administrator) and is
  detected through the real client IP (loopback, the machine's own interface addresses,
  IPv4-mapped IPv6 forms and an optional ``TEAMSTUDIO_DEVICE_IPS`` allow-list). Forwarding
  headers are only trusted when the TCP peer itself is the deployment device, so a remote
  client can never spoof its way into the built-in Admin identity, while a local reverse
  proxy carrying a remote client is correctly treated as remote.

Sessions are sliding: every authenticated bootstrap/`me` request re-issues the signed
cookie with a fresh expiry, so ``auth.session.maxAgeDays`` (default 7) counts from the
most recent visit.
"""

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
from .db import db, json_loads, row, rows

SESSION_COOKIE_FALLBACK = "teamstudio_session"
STATE_COOKIE = "teamstudio_sso_state"
# Marks that the deployment device's browser explicitly logged out of the built-in
# Admin identity. The flag only *disables* automatic device-admin privileges; it never
# grants any. Visiting the login page can clear it again ("以系统内置管理员身份登录").
DEVICE_LOGOUT_COOKIE = "teamstudio_device_logout"
# Environment variable with extra device addresses (comma separated), e.g. the LAN IP of
# the deployment machine behind a NAT/router.
DEVICE_IPS_ENV = "TEAMSTUDIO_DEVICE_IPS"

USER_ROLES = ("member", "team_admin", "super")


class SessionIdentity(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str = ""
    email: str = ""
    provider: str = "sso"
    sub: str = ""
    exp: int = 0


@dataclass
class CurrentUser:
    id: str
    name: str
    email: str = ""
    avatar: str = ""
    avatar_color: str = "#5865f2"
    bio: str = ""
    skills: list[str] = field(default_factory=list)
    authenticated: bool = False
    source: str = "guest"  # local | sso | email | ip | guest
    is_device_admin: bool = False
    admin_role: str | None = None
    user_role: str = "member"
    team_ids: set[str] = field(default_factory=set)
    linked_member_id: str | None = None
    linked_member_name: str | None = None
    # Every ``members`` archive row owned by this identity across teams, ordered by team
    # and then by the member's own ordering. ``linked_member_id`` keeps the first entry;
    # write permissions check the whole list (one account may own archive rows in several
    # teams, and migration keeps historical duplicates inside one team).
    linked_member_ids: list[str] = field(default_factory=list)
    email_verified: bool = True
    sso_configured: bool = False
    # ``deploy_device`` is true whenever the request originates from the deployment
    # machine; ``device_admin_active`` tells whether the built-in Admin identity is
    # currently being used (false after an explicit logout).
    deploy_device: bool = False
    device_admin_active: bool = False
    session: SessionIdentity | None = field(default=None, repr=False)

    @property
    def is_super_admin(self) -> bool:
        return self.is_device_admin or self.admin_role == "super"

    @property
    def is_admin(self) -> bool:
        return self.is_device_admin or self.admin_role is not None

    def can_edit_settings(self) -> bool:
        return self.is_super_admin

    def can_manage_users(self) -> bool:
        return self.is_super_admin

    def can_edit_team(self, team_id: str) -> bool:
        """Super administrators edit every team; team admins only their own team_ids."""
        if self.is_super_admin:
            return True
        return bool(team_id) and team_id in self.team_ids

    def can_manage_team(self, team_id: str) -> bool:
        """Team administration (member/structure writes) inside ``team_id``."""
        return self.can_edit_team(team_id)

    def can_create_team(self) -> bool:
        """Creating (and deleting) a whole team stays reserved for super administrators."""
        return self.is_super_admin

    def can_edit_any(self) -> bool:
        return self.is_super_admin or bool(self.team_ids)

    def ensure_team(self, team_id: str) -> None:
        """Raise 403 ``not_admin`` unless the user may manage ``team_id``."""
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
        if not self.authenticated:
            return False
        if not settings_service.get().features.allowMemberSelfEdit:
            return False
        return (
            self.source in {"email", "sso"}
            or bool(self.linked_member_id)
            or bool(self.linked_member_ids)
        )

    def linked_member_id_list(self) -> list[str]:
        """All linked archive ids, keeping the single id (if any) first."""
        values = list(self.linked_member_ids)
        if self.linked_member_id and self.linked_member_id not in values:
            values.insert(0, self.linked_member_id)
        return values

    def is_linked_member(self, member_id: str | None) -> bool:
        """Whether ``member_id`` is one of this identity's archive rows (any team)."""
        if not member_id:
            return False
        return member_id in self.linked_member_id_list()

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "avatar": self.avatar,
            "avatarColor": self.avatar_color,
            "bio": self.bio,
            "skills": list(self.skills),
            "authenticated": self.authenticated,
            "source": self.source,
            "isDeviceAdmin": self.is_device_admin,
            "isSuperAdmin": self.is_super_admin,
            "userRole": self.user_role,
            "emailVerified": self.email_verified,
            "admin": {
                "role": self.admin_role,
                "teamIds": sorted(self.team_ids),
            },
            "linkedMemberId": self.linked_member_id,
            "linkedMemberName": self.linked_member_name,
            "linkedMemberIds": list(self.linked_member_ids),
            "ssoConfigured": self.sso_configured,
            "deployDevice": self.deploy_device,
            "deviceAdminActive": self.device_admin_active,
            "permissions": {
                "canEditSettings": self.can_edit_settings(),
                "canEditAny": self.can_edit_any(),
                "canEditSelf": self.can_edit_self(),
                "canManageUsers": self.can_manage_users(),
                "canManageWorkspace": self.can_edit_any(),
            },
        }


# --------------------------------------------------------------------------- sessions


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


def rotate_session_secret() -> bool:
    """Replace the in-process session signing secret with a fresh random value.

    A factory reset must invalidate every session cookie that was issued before it, so
    the signing secret is regenerated in place. When ``TEAMSTUDIO_SESSION_SECRET`` pins
    the secret through the environment nothing is overwritten and ``False`` is returned;
    otherwise ``data/.session_secret`` is rewritten in the same format as
    :func:`_load_secret` (chmod 0600 best effort), the module-level secret is replaced
    immediately and ``True`` is returned. Cookies signed with the previous secret stop
    verifying; ``hash_verification_code`` output changes as well, so pending e-mail codes
    are invalidated too.
    """
    global _SECRET
    if os.environ.get("TEAMSTUDIO_SESSION_SECRET"):
        return False
    secret = base64.urlsafe_b64encode(os.urandom(48)).decode("ascii")
    path = _secret_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secret + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:  # pragma: no cover - best effort; the in-process secret still rotates
        pass
    _SECRET = secret.encode("utf-8")
    return True


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


def hash_verification_code(email: str, code: str) -> str:
    """Keyed hash of a one-time e-mail code (the plain code is never stored)."""
    message = f"{email.strip().lower()}:{code.strip()}".encode("utf-8")
    return hmac.new(_SECRET, message, hashlib.sha256).hexdigest()


def verification_code_matches(email: str, code: str, expected_hash: str) -> bool:
    if not expected_hash:
        return False
    return hmac.compare_digest(hash_verification_code(email, code), expected_hash)


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
    days = cfg.auth.session.maxAgeDays
    token = create_session_token(identity, days)
    response.set_cookie(
        key=cfg.auth.session.cookieName or SESSION_COOKIE_FALLBACK,
        value=token,
        max_age=days * 86400,
        httponly=True,
        samesite="lax",
        secure=cfg.auth.session.secureCookie,
        path="/",
    )


def refresh_session_cookie(response: Any, user: CurrentUser) -> None:
    """Slide the signed session window forward on every visit.

    Only cookie/session based identities (e-mail login and SSO) are refreshed; the
    deployment device and IP-whitelist identities do not own a session cookie.
    """
    if not user.authenticated or user.session is None:
        return
    if user.source not in {"email", "sso"}:
        return
    set_session_cookie(response, user.session)


def clear_session_cookie(response: Any) -> None:
    cfg = settings_service.get()
    response.delete_cookie(cfg.auth.session.cookieName or SESSION_COOKIE_FALLBACK, path="/")


def device_admin_logged_out(request: Request) -> bool:
    """Whether this browser explicitly signed out of the built-in device Admin."""
    return request.cookies.get(DEVICE_LOGOUT_COOKIE) == "1"


def set_device_logout_cookie(response: Any) -> None:
    cfg = settings_service.get()
    response.set_cookie(
        DEVICE_LOGOUT_COOKIE,
        "1",
        max_age=365 * 86400,
        httponly=True,
        samesite="lax",
        secure=cfg.auth.session.secureCookie,
        path="/",
    )


def clear_device_logout_cookie(response: Any) -> None:
    response.delete_cookie(DEVICE_LOGOUT_COOKIE, path="/")


# ------------------------------------------------------------------- device (local) detection


def normalize_ip(value: Any) -> str:
    """Normalise one IP-ish header value (quotes, ports, IPv4-mapped IPv6, case)."""
    text = str(value or "").strip().strip('"').strip("'").strip()
    if not text:
        return ""
    if text.startswith("["):  # "[::1]:8080" or "[::ffff:127.0.0.1]"
        closing = text.find("]")
        if closing > 0:
            text = text[1:closing]
    elif text.count(":") == 1 and "." in text:  # "192.168.1.5:8080"
        host, _, port = text.rpartition(":")
        if port.isdigit():
            text = host
    text = text.strip().strip("[]").strip().lower()
    if not text:
        return ""
    if text in {"localhost", "testclient"}:
        return text
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return text  # hostname or unparsable value: compared verbatim (lower-cased)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    return str(address)


def _collect_local_addresses() -> set[str]:
    """Loopback + every address of this machine, cached for the process lifetime."""
    addresses = {"127.0.0.1", "::1", "localhost", "testclient", "0:0:0:0:0:0:0:1"}
    hostnames: set[str] = set()
    try:
        hostnames.add(socket.gethostname())
    except OSError:  # pragma: no cover - unusual socket-less environment
        pass
    try:
        hostnames.add(socket.getfqdn())
    except OSError:  # pragma: no cover
        pass
    for hostname in hostnames:
        if not hostname:
            continue
        addresses.add(normalize_ip(hostname))
        try:
            for info in socket.getaddrinfo(hostname, None):
                addresses.add(normalize_ip(info[4][0]))
        except OSError:
            pass
        try:
            addresses.update(normalize_ip(item) for item in socket.gethostbyname_ex(hostname)[2])
        except OSError:
            pass
    return {item for item in addresses if item}


_LOCAL_ADDRESSES = _collect_local_addresses()


def device_ip_allowlist() -> set[str]:
    """Extra deployment-device addresses from ``TEAMSTUDIO_DEVICE_IPS`` (comma separated)."""
    raw = os.environ.get(DEVICE_IPS_ENV, "")
    return {normalize_ip(item) for item in raw.split(",") if item.strip()} - {""}


def local_addresses() -> set[str]:
    """Every address that identifies the deployment device right now."""
    return _LOCAL_ADDRESSES | device_ip_allowlist()


def is_local_ip(value: str) -> bool:
    """Whether one normalised IP/hostname belongs to the deployment device."""
    normalized = normalize_ip(value)
    if not normalized:
        return False
    if normalized in local_addresses():
        return True
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    # Loopback is the device by definition even when the cached address set is stale.
    return address.is_loopback


def _effective_forwarded_ip(request: Request) -> str:
    """The real client IP reported by an on-device reverse proxy, if any.

    ``X-Forwarded-For`` is a comma separated chain; the last entry is appended by the
    closest proxy and therefore names the real client. ``X-Real-IP`` and the RFC 7239
    ``Forwarded: for=`` values are used as fallbacks.
    """
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        parts = [part.strip() for part in forwarded_for.split(",") if part.strip()]
        if parts:
            return normalize_ip(parts[-1])
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return normalize_ip(real_ip)
    forwarded = request.headers.get("forwarded")
    if forwarded:
        values: list[str] = []
        for element in forwarded.split(","):
            for part in element.split(";"):
                key, _, value = part.partition("=")
                if key.strip().lower() == "for" and value.strip():
                    values.append(normalize_ip(value))
        if values:
            return values[-1]
    return ""


def candidate_ips(request: Request) -> list[str]:
    """Candidate real client IPs: TCP peer first, then the forwarded real IP."""
    values = []
    if request.client and request.client.host:
        values.append(normalize_ip(request.client.host))
    forwarded = _effective_forwarded_ip(request)
    if forwarded:
        values.append(forwarded)
    return [item for item in values if item]


def client_ip(request: Request) -> str:
    """The real client IP used for IP-whitelist matching.

    Forwarding headers are only trusted when the TCP peer is the deployment device (a
    local reverse proxy), so a remote client cannot spoof a whitelisted address.
    """
    peer = normalize_ip(request.client.host if request.client else "")
    forwarded = _effective_forwarded_ip(request)
    if peer and is_local_ip(peer) and forwarded:
        return forwarded
    return peer


def is_local_request(request: Request) -> bool:
    """Whether the request really originates from the deployment device.

    The TCP peer must be a device address; forwarding headers can then only *narrow* the
    decision (a local reverse proxy carrying a remote client is not the device). A remote
    peer never becomes the device by sending forwarding headers.
    """
    peer = normalize_ip(request.client.host if request.client else "")
    if not is_local_ip(peer):
        return False
    forwarded = _effective_forwarded_ip(request)
    if forwarded:
        return is_local_ip(forwarded)
    return True


# --------------------------------------------------------------------------- admin whitelist


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


def merge_team_scopes(entries: list[Any]) -> set[str]:
    """Team ids granted by whitelist entries (empty ``teamId`` grants nothing)."""
    team_ids: set[str] = set()
    for entry in entries:
        team_id = str(getattr(entry, "teamId", "") or "").strip()
        if entry.role == "team_admin" and team_id:
            team_ids.add(team_id)
    return team_ids


def _find_user(identity: SessionIdentity) -> dict[str, Any] | None:
    candidates = [identity.id, identity.email, identity.sub]
    lowered = [value.strip().lower() for value in candidates if value and value.strip()]
    if not lowered:
        return None
    with db() as conn:
        for value in lowered:
            found = row(
                conn,
                "SELECT * FROM users WHERE lower(id)=? OR lower(email)=? LIMIT 1",
                (value, value),
            )
            if found:
                return found
    return None


def _linked_members(identity: SessionIdentity) -> list[dict[str, Any]]:
    """Every ``members`` archive row owned by this session identity.

    One query matches every account identifier (id / e-mail / SSO sub) against both
    ``external_id`` and ``email``: historical rows store the e-mail in ``external_id``
    while account-created rows store the account id, and the same account may own rows in
    several teams (or several historical rows inside one team). Rows are ordered by team
    and then by the member's own ordering, so the first row is the global "primary"
    archive kept in ``linked_member_id``.
    """
    candidates = [identity.id, identity.email, identity.sub]
    lowered = sorted({value.strip().lower() for value in candidates if value and value.strip()})
    if not lowered:
        return []
    placeholders = ",".join("?" for _ in lowered)
    with db() as conn:
        return rows(
            conn,
            "SELECT m.id, m.name, m.team_id FROM members m "
            "JOIN teams t ON t.id = m.team_id "
            f"WHERE lower(m.external_id) IN ({placeholders}) "
            f"OR lower(m.email) IN ({placeholders}) "
            "ORDER BY t.sort_order, t.name, m.sort_order, m.created_at, m.id",
            (*lowered, *lowered),
        )


def _role_from_user(user: dict[str, Any] | None) -> str:
    if not user:
        return "member"
    role = str(user.get("role") or "member")
    return role if role in USER_ROLES else "member"


def _json_list(user: dict[str, Any] | None, key: str) -> set[str]:
    if not user:
        return set()
    parsed = json_loads(user.get(key), [])
    if not isinstance(parsed, list):
        return set()
    return {str(item) for item in parsed if str(item).strip()}


def build_user(request: Request) -> CurrentUser:
    cfg = settings_service.get()
    sso_configured = settings_service.sso_configured()
    ip_value = client_ip(request)
    local = is_local_request(request)
    identity = read_session(request)

    # A deployment-device browser is the built-in Admin until its owner explicitly
    # signs out. After that, only the signed e-mail/SSO session (if any) identifies the
    # request — it must never inherit device-admin privileges.
    if local and not device_admin_logged_out(request):
        return CurrentUser(
            id="device-admin",
            name="Admin",
            authenticated=True,
            source="local",
            is_device_admin=True,
            admin_role="super",
            user_role="super",
            deploy_device=True,
            device_admin_active=True,
            sso_configured=sso_configured,
        )

    if local:
        # The device owner is using another account: IP-based admin grants are not
        # applied so the session really behaves like any other browser session.
        ip_entries: list[Any] = []
        ip_display = ""
    else:
        ip_entries, ip_display = match_ip_admin(ip_value)
    entries: list[Any] = list(ip_entries)
    if identity:
        entries.extend(match_id_admin(identity))

    team_ids = merge_team_scopes(entries)
    role: str | None = "team_admin" if team_ids else None

    account = _find_user(identity) if identity else None
    if account:
        account_role = _role_from_user(account)
        team_ids |= _json_list(account, "team_ids")
        if account_role == "super":
            role = "super"
        elif account_role == "team_admin":
            role = "team_admin"
        elif role is None and team_ids:
            role = "team_admin"

    linked_rows = _linked_members(identity) if identity else []
    linked = linked_rows[0] if linked_rows else None
    linked_ids = [item["id"] for item in linked_rows]

    if account and identity:
        display_name = account.get("name") or identity.name or account["id"]
        return CurrentUser(
            id=account["id"],
            name=display_name,
            email=account.get("email") or identity.email,
            avatar=account.get("avatar") or "",
            avatar_color=account.get("avatar_color") or "#5865f2",
            bio=account.get("bio") or "",
            skills=list(json_loads(account.get("skills"), []) or []),
            authenticated=True,
            source="email" if identity.provider == "email" else "sso",
            admin_role=role,
            user_role=_role_from_user(account),
            team_ids=team_ids,
            linked_member_id=linked["id"] if linked else None,
            linked_member_name=linked["name"] if linked else None,
            linked_member_ids=linked_ids,
            email_verified=bool(account.get("email_verified")),
            sso_configured=sso_configured,
            deploy_device=local,
            device_admin_active=False,
            session=identity,
        )

    if identity:
        return CurrentUser(
            id=identity.id,
            name=identity.name or identity.id,
            email=identity.email,
            authenticated=True,
            source="sso",
            admin_role=role,
            user_role=role or "member",
            team_ids=team_ids,
            linked_member_id=linked["id"] if linked else None,
            linked_member_name=linked["name"] if linked else None,
            linked_member_ids=linked_ids,
            sso_configured=sso_configured,
            deploy_device=local,
            device_admin_active=False,
            session=identity,
        )

    if team_ids:
        return CurrentUser(
            id=f"ip:{ip_value}",
            name=ip_display or "IP 管理员",
            authenticated=True,
            source="ip",
            admin_role="team_admin",
            user_role="team_admin",
            team_ids=team_ids,
            sso_configured=sso_configured,
            deploy_device=local,
            device_admin_active=False,
        )

    # A whitelist entry without a team grants nothing (round 8 §2.1).
    return CurrentUser(
        id="guest",
        name="访客",
        authenticated=False,
        source="guest",
        sso_configured=sso_configured,
        deploy_device=local,
        device_admin_active=False,
    )


def get_current_user(request: Request) -> CurrentUser:
    return build_user(request)


CurrentUserDep = Depends(get_current_user)


def require_super(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Require a super administrator (device Admin or a stored ``super`` role)."""
    if not user.is_super_admin:
        raise HTTPException(status_code=403, detail="仅超级管理员可执行此操作")
    return user


def require_device_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Require the deployment device's built-in Admin identity."""
    if not user.is_device_admin:
        raise HTTPException(status_code=403, detail="仅系统内置的 Admin 可执行此操作")
    return user


def require_authenticated(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.authenticated:
        raise HTTPException(status_code=401, detail="请先登录或使用管理员设备")
    return user


def require_sso_configured() -> None:
    if not settings_service.sso_configured():
        raise HTTPException(status_code=400, detail="企业 SSO 尚未配置完整")
