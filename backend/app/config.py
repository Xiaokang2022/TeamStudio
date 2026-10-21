"""Application configuration: schema, atomic JSON storage and public projection.

Round 5 changes
---------------
* The bundled (self-hosted) SMTP server and the calendar e-mail reminders were removed.
  ``email`` now only describes the external SMTP relay used to deliver six-digit
  verification codes.
* Sessions are sliding: ``auth.session.maxAgeDays`` (default 7) is both the cookie
  lifetime and the idle window refreshed on every visit.
* ``auth.emailLogin`` controls the password-less e-mail code login/registration flow.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("TEAMSTUDIO_DATA_DIR", ROOT_DIR / "data"))
SETTINGS_PATH = Path(os.environ.get("TEAMSTUDIO_SETTINGS", DATA_DIR / "settings.json"))
FRONTEND_DIST = ROOT_DIR / "web" / "dist"
UPLOAD_DIR = DATA_DIR / "uploads"

TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ThemeSettings(StrictModel):
    # Retained for settings-file compatibility only: round 8 resolves light/dark from the
    # user's personal preference (auto/light/dark) and never from this site-level value.
    mode: Literal["light", "dark", "auto"] = "auto"
    accent: str = "#0a59f7"
    accentSecondary: str = "#4d8dff"
    radius: int = Field(default=18, ge=8, le=32)

    @field_validator("accent", "accentSecondary")
    @classmethod
    def valid_hex(cls, value: str) -> str:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise ValueError("必须是 #RRGGBB 格式的颜色值")
        return value.lower()


class SiteSettings(StrictModel):
    name: str = Field(default="团队工作室", min_length=1, max_length=40)
    shortName: str = Field(default="TeamStudio", min_length=1, max_length=12)
    tagline: str = Field(default="把每一次协作，变成看得见的成长。", max_length=120)
    logoText: str = Field(default="TS", min_length=1, max_length=4)
    footerText: str = Field(default="TeamStudio · 让团队协作有温度", max_length=120)
    theme: ThemeSettings = Field(default_factory=ThemeSettings)


class ModuleFlags(StrictModel):
    overview: bool = True
    calendar: bool = True
    redblack: bool = True
    links: bool = True
    matrix: bool = True
    announcements: bool = True
    # Round 9: the settings entry is permission-based (super admins / team admins) and
    # can never be hidden by a module switch. The field stays for settings-file and API
    # compatibility but is normalised back to ``True`` on every load/save.
    settings: bool = Field(
        default=True,
        description="系统设置入口由账号权限决定，恒为开启；保留该字段仅为配置兼容。",
    )
    tasks: bool = True
    insights: bool = True

    @field_validator("settings")
    @classmethod
    def settings_always_enabled(cls, _value: bool) -> bool:
        """The settings module must never be switchable off (round-9 requirement)."""
        return True


class GuestModuleFlags(StrictModel):
    """Which modules unauthenticated guests may read (round 8 requirement #6).

    Everything except the system settings module is open by default so the historical
    read-only guest experience is preserved until an administrator narrows it down.
    """

    overview: bool = True
    calendar: bool = True
    redblack: bool = True
    links: bool = True
    matrix: bool = True
    announcements: bool = True
    tasks: bool = True
    insights: bool = True
    # Guests can never reach the settings module: the entry is permission-based.
    settings: bool = False

    @field_validator("settings")
    @classmethod
    def settings_never_for_guests(cls, _value: bool) -> bool:
        return False


class AnnouncementSettings(StrictModel):
    maxPinned: int = Field(default=3, ge=0, le=3)
    dashboardLimit: int = Field(default=4, ge=1, le=10)
    showOnDashboard: bool = True


class CalendarSettings(StrictModel):
    weekStartsOn: Literal[0, 1] = 1
    showWeekends: bool = True
    allowPastDue: bool = True


class RedBlackSettings(StrictModel):
    showScores: bool = True
    monthlyThemeEnabled: bool = True
    redLabel: str = "红榜 · 高光时刻"
    blackLabel: str = "黑榜 · 待改进"


class SmtpSettings(StrictModel):
    """External SMTP relay used for e-mail verification codes.

    ``host`` accepts an IP address or a hostname. ``username`` / ``password`` are the
    relay account (the proxy mailbox), while ``fromEmail`` is the visible sender.
    """

    host: str = Field(default="", max_length=190)
    port: int = Field(default=587, ge=1, le=65535)
    username: str = Field(default="", max_length=190)
    password: str = Field(default="", max_length=500)
    fromEmail: str = Field(default="", max_length=190)
    fromName: str = Field(default="团队工作室", max_length=80)
    useStartTls: bool = True
    useSsl: bool = False
    timeoutSeconds: int = Field(default=15, ge=3, le=120)

    @field_validator("host")
    @classmethod
    def valid_host(cls, value: str) -> str:
        cleaned = value.strip()
        if any(char.isspace() for char in cleaned):
            raise ValueError("SMTP 服务器地址不能包含空格")
        return cleaned

    @field_validator("fromEmail")
    @classmethod
    def valid_from_email(cls, value: str) -> str:
        if value and not EMAIL_PATTERN.fullmatch(value):
            raise ValueError("发件邮箱格式不正确")
        return value

    @model_validator(mode="after")
    def tls_exclusive(self) -> "SmtpSettings":
        if self.useSsl and self.useStartTls:
            raise ValueError("SSL 与 STARTTLS 只能开启一种")
        return self


class EmailSettings(StrictModel):
    enabled: bool = True
    smtp: SmtpSettings = Field(default_factory=SmtpSettings)
    # Verification mail content (kept simple; the six-digit code is appended).
    subjectTemplate: str = Field(default="[{{siteName}}] 邮箱验证码", max_length=160)
    bodyTemplate: str = Field(
        default=(
            "你好：\n\n"
            "你正在登录「{{siteName}}」，本次验证码为：\n\n"
            "{{code}}\n\n"
            "验证码 {{expiresMinutes}} 分钟内有效，请勿转发给他人。"
            "如果不是你本人操作，请忽略本邮件。\n\n"
            "—— {{siteName}}"
        ),
        max_length=4000,
    )


class SsoSettings(StrictModel):
    enabled: bool = False
    providerName: str = "企业 SSO"
    issuer: str = ""
    clientId: str = ""
    clientSecret: str = ""
    scopes: str = "openid profile email"
    redirectUri: str = "http://127.0.0.1:8000/api/auth/callback"
    authorizationEndpoint: str = ""
    tokenEndpoint: str = ""
    userinfoEndpoint: str = ""
    endSessionEndpoint: str = ""
    claimId: str = "sub"
    claimName: str = "name"
    claimEmail: str = "email"
    allowedEmailDomains: list[str] = Field(default_factory=list)
    autoProvision: bool = False


class EmailLoginSettings(StrictModel):
    enabled: bool = True
    codeLength: int = Field(default=6, ge=4, le=8)
    codeExpiryMinutes: int = Field(default=10, ge=2, le=30)
    resendSeconds: int = Field(default=60, ge=30, le=600)
    maxAttempts: int = Field(default=5, ge=3, le=10)
    # Pre-created accounts may activate (and log in) without an e-mail code. Entering
    # their e-mail opens a confirmation window of this many minutes.
    precreatedActivationMinutes: int = Field(default=10, ge=1, le=120)


class AdminIdEntry(StrictModel):
    """A whitelisted SSO/e-mail identity (round 8: team administrators only).

    ``role`` may only be ``team_admin`` and the grant is scoped by ``teamId``; an empty
    ``teamId`` is accepted so legacy settings keep loading, but grants no permission.
    """

    id: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=60)
    role: Literal["team_admin"] = "team_admin"
    teamId: str = ""
    note: str = Field(default="", max_length=200)


class AdminIpEntry(StrictModel):
    """A whitelisted source IP/CIDR (round 8: team administrators only)."""

    ip: str = Field(min_length=1, max_length=80)
    name: str = Field(default="", max_length=60)
    role: Literal["team_admin"] = "team_admin"
    teamId: str = ""
    note: str = Field(default="", max_length=200)

    @field_validator("ip")
    @classmethod
    def valid_ip(cls, value: str) -> str:
        try:
            ipaddress.ip_network(value, strict=False)
        except ValueError as exc:
            raise ValueError(f"IP/CIDR 格式不正确: {value}") from exc
        return value


class AdminWhitelist(StrictModel):
    ips: list[AdminIpEntry] = Field(default_factory=list)
    ids: list[AdminIdEntry] = Field(default_factory=list)


class SessionSettings(StrictModel):
    cookieName: str = Field(default="teamstudio_session", min_length=3, max_length=64)
    maxAgeDays: int = Field(default=7, ge=1, le=90)
    secureCookie: bool = False


class AuthSettings(StrictModel):
    guestMode: bool = True
    allowGuestRead: bool = True
    emailLogin: EmailLoginSettings = Field(default_factory=EmailLoginSettings)
    sso: SsoSettings = Field(default_factory=SsoSettings)
    adminWhitelist: AdminWhitelist = Field(default_factory=AdminWhitelist)
    session: SessionSettings = Field(default_factory=SessionSettings)


class FeatureSettings(StrictModel):
    allowMemberSelfEdit: bool = True
    showGuestBanner: bool = True
    showDemoBadge: bool = True
    auditLog: bool = True
    allowGuestTodoCreate: bool = False


class Settings(StrictModel):
    version: int = 3
    site: SiteSettings = Field(default_factory=SiteSettings)
    modules: ModuleFlags = Field(default_factory=ModuleFlags)
    guestModules: GuestModuleFlags = Field(default_factory=GuestModuleFlags)
    announcements: AnnouncementSettings = Field(default_factory=AnnouncementSettings)
    calendar: CalendarSettings = Field(default_factory=CalendarSettings)
    redblack: RedBlackSettings = Field(default_factory=RedBlackSettings)
    email: EmailSettings = Field(default_factory=EmailSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)
    features: FeatureSettings = Field(default_factory=FeatureSettings)


DEFAULT_SETTINGS = Settings()

# Keys removed in round 5; they are stripped automatically when an older
# ``data/settings.json`` is loaded so existing deployments upgrade in place.
_LEGACY_EMAIL_KEYS = ("deliveryMode", "builtin", "reminders")
_LEGACY_CALENDAR_KEYS = (
    "defaultReminderOffsetsDays",
    "defaultReminderTime",
    "defaultEmailEnabled",
)


def _migrate_whitelist_entry(entry: Any) -> dict[str, Any] | None:
    """Normalise one legacy admin-whitelist entry to the round-8 team-only shape.

    Returns ``None`` when the entry cannot be mapped to a real team (a legacy
    ``group_admin`` grant without a ``teamId``), so the loaded configuration never keeps
    a permission-less or group-scoped grant around.
    """
    if not isinstance(entry, dict):
        return None
    cleaned = dict(entry)
    cleaned.pop("groupIds", None)
    cleaned["role"] = "team_admin"
    raw_team = cleaned.get("teamId")
    team_id = raw_team.strip() if isinstance(raw_team, str) else ""
    cleaned["teamId"] = team_id
    if not team_id:
        # Round 8 §1.3: group-admin entries without a team, and empty grants, are dropped.
        return None
    return cleaned


def migrate_legacy_settings(
    raw: dict[str, Any], *, sanitize_legacy: bool = True
) -> tuple[dict[str, Any], bool]:
    """Return ``(clean_payload, changed)`` after upgrading older settings files.

    Round 5 removed the bundled mail/reminder keys; round 8 (version 3) adds
    ``guestModules``, removes the development-group whitelist fields
    (``groupIds`` / ``role='group_admin'``) and keeps ``site.theme.mode`` as an unused
    compatibility field.

    ``sanitize_legacy`` is true when loading an existing settings file (legacy grants are
    converted and unusable ones dropped) and false when validating a payload submitted
    through the API, so invalid input keeps being rejected with a path-specific 422
    instead of being silently rewritten.
    """
    if not isinstance(raw, dict):
        return raw, False
    changed = False

    email = raw.get("email")
    if isinstance(email, dict):
        for key in _LEGACY_EMAIL_KEYS:
            if key in email:
                email.pop(key, None)
                changed = True
        smtp = email.get("smtp")
        if isinstance(smtp, dict) and "useSsl" in smtp and "useStartTls" in smtp:
            if smtp["useSsl"] and smtp["useStartTls"]:
                smtp["useStartTls"] = False
                changed = True

    calendar = raw.get("calendar")
    if isinstance(calendar, dict):
        for key in _LEGACY_CALENDAR_KEYS:
            if key in calendar:
                calendar.pop(key, None)
                changed = True

    modules = raw.get("modules")
    if isinstance(modules, dict) and "email" in modules:
        modules.pop("email", None)
        changed = True

    auth = raw.get("auth")
    if isinstance(auth, dict) and "emailLogin" not in auth:
        auth["emailLogin"] = EmailLoginSettings().model_dump(mode="json")
        changed = True

    if sanitize_legacy:
        if isinstance(auth, dict):
            whitelist = auth.get("adminWhitelist")
            if isinstance(whitelist, dict):
                for key in ("ips", "ids"):
                    entries = whitelist.get(key)
                    if not isinstance(entries, list):
                        continue
                    cleaned_entries = [
                        item
                        for item in (_migrate_whitelist_entry(entry) for entry in entries)
                        if item is not None
                    ]
                    if cleaned_entries != entries:
                        whitelist[key] = cleaned_entries
                        changed = True

        guest_modules = raw.get("guestModules")
        guest_defaults = GuestModuleFlags().model_dump(mode="json")
        if not isinstance(guest_modules, dict):
            raw["guestModules"] = guest_defaults
            changed = True
        else:
            cleaned_flags = {
                key: (
                    bool(guest_modules[key])
                    if isinstance(guest_modules.get(key), bool)
                    else default
                )
                for key, default in guest_defaults.items()
            }
            # The settings module is permission-based and never guest-readable.
            cleaned_flags["settings"] = False
            if cleaned_flags != guest_modules:
                raw["guestModules"] = cleaned_flags
                changed = True

        # Round 9: ``modules.settings`` is a compatibility field only; the settings entry
        # is permission-based and must never be hideable. Normalise old files back to true.
        if isinstance(modules, dict) and modules.get("settings") is not True:
            modules["settings"] = True
            changed = True

        site = raw.get("site")
        if isinstance(site, dict):
            theme = site.get("theme")
            if isinstance(theme, dict) and theme.get("mode") not in ("auto", "light", "dark"):
                theme["mode"] = "auto"
                changed = True

    if raw.get("version") != DEFAULT_SETTINGS.version:
        raw["version"] = DEFAULT_SETTINGS.version
        changed = True
    return raw, changed


def _write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(content, encoding="utf-8")
    temp.replace(path)


def flatten_validation_errors(exc: ValidationError) -> list[dict[str, str]]:
    details: list[dict[str, str]] = []
    for error in exc.errors():
        path = ".".join(str(part) for part in error.get("loc", ())) or "(root)"
        details.append({"path": path, "message": error.get("msg", "配置项不合法")})
    return details


def mask_email(value: str) -> str:
    if "@" not in value:
        return value
    name, domain = value.split("@", 1)
    if len(name) <= 2:
        return name[:1] + "***@" + domain
    return name[:2] + "***@" + domain


class SettingsService:
    """Thread-safe settings cache backed by an editable JSON file."""

    def __init__(self, path: Path = SETTINGS_PATH) -> None:
        self.path = path
        self._lock = threading.RLock()
        self.updated_at = now_iso()
        self._settings = Settings()
        if not path.exists():
            self.save(DEFAULT_SETTINGS.model_dump(mode="json"))
            self.updated_at = now_iso()
        else:
            self.reload()

    def reload(self) -> Settings:
        with self._lock:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            clean, changed = migrate_legacy_settings(raw)
            self._settings = Settings.model_validate(clean)
            self.updated_at = datetime.fromtimestamp(
                self.path.stat().st_mtime, tz=timezone.utc
            ).astimezone().isoformat(timespec="seconds")
            if changed:
                text = json.dumps(
                    self._settings.model_dump(mode="json"), ensure_ascii=False, indent=2
                )
                _write_atomic(self.path, text + "\n")
            return self._settings

    def get(self) -> Settings:
        with self._lock:
            return self._settings.model_copy(deep=True)

    def validate(self, payload: dict) -> tuple[bool, Settings | None, list[dict[str, str]]]:
        try:
            # API payloads are validated as-is: a legacy group-scoped or unknown field is
            # a path-specific 422 instead of being silently rewritten.
            clean, _ = migrate_legacy_settings(payload, sanitize_legacy=False)
            candidate = Settings.model_validate(clean)
            return True, candidate, []
        except ValidationError as exc:
            return False, None, flatten_validation_errors(exc)

    def save(self, payload: dict) -> Settings:
        valid, candidate, details = self.validate(payload)
        if not valid or candidate is None:
            raise ConfigValidationError(details)
        with self._lock:
            text = json.dumps(candidate.model_dump(mode="json"), ensure_ascii=False, indent=2)
            _write_atomic(self.path, text + "\n")
            self._settings = candidate
            self.updated_at = now_iso()
            return candidate

    def email_configured(self) -> bool:
        cfg = self.get().email
        return bool(
            cfg.enabled and cfg.smtp.host.strip() and cfg.smtp.fromEmail.strip()
        )

    def public(self) -> dict:
        cfg = self.get()
        sso = cfg.auth.sso
        smtp = cfg.email.smtp
        return {
            "site": cfg.site.model_dump(mode="json"),
            "modules": cfg.modules.model_dump(mode="json"),
            "guestModules": cfg.guestModules.model_dump(mode="json"),
            "announcements": cfg.announcements.model_dump(mode="json"),
            "calendar": cfg.calendar.model_dump(mode="json"),
            "redblack": cfg.redblack.model_dump(mode="json"),
            "features": cfg.features.model_dump(mode="json"),
            "email": {
                "enabled": cfg.email.enabled,
                "configured": self.email_configured(),
                "fromEmail": smtp.fromEmail,
                "fromName": smtp.fromName,
            },
            "auth": {
                "guestMode": cfg.auth.guestMode,
                "allowGuestRead": cfg.auth.allowGuestRead,
                "emailLogin": {
                    "enabled": cfg.auth.emailLogin.enabled,
                    "codeLength": cfg.auth.emailLogin.codeLength,
                    "codeExpiryMinutes": cfg.auth.emailLogin.codeExpiryMinutes,
                    "resendSeconds": cfg.auth.emailLogin.resendSeconds,
                    "precreatedActivationMinutes": cfg.auth.emailLogin.precreatedActivationMinutes,
                },
                "sessionDays": cfg.auth.session.maxAgeDays,
                "sso": {
                    "enabled": sso.enabled,
                    "configured": self.sso_configured(),
                    "providerName": sso.providerName,
                },
            },
        }

    def sso_configured(self) -> bool:
        sso = self.get().auth.sso
        return bool(sso.enabled and sso.issuer and sso.clientId and sso.clientSecret and sso.redirectUri)

    def schema(self) -> dict:
        return Settings.model_json_schema()

    def meta(self) -> dict:
        return {
            "path": str(self.path),
            "updatedAt": self.updated_at,
            "schemaVersion": self.get().version,
            "deviceAdminName": "Admin",
        }

    def public_copy(self) -> dict:
        return self.public()


class ConfigValidationError(ValueError):
    def __init__(self, details: list[dict[str, str]]) -> None:
        super().__init__("配置校验失败")
        self.details = details


settings_service = SettingsService()
