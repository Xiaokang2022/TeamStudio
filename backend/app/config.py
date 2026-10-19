"""Application configuration: schema, atomic JSON storage and public projection."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("TEAMSTUDIO_DATA_DIR", ROOT_DIR / "data"))
SETTINGS_PATH = Path(os.environ.get("TEAMSTUDIO_SETTINGS", DATA_DIR / "settings.json"))
FRONTEND_DIST = ROOT_DIR / "web" / "dist"

TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ThemeSettings(StrictModel):
    mode: Literal["light", "dark", "auto"] = "light"
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
    name: str = Field(default="星港团队工作室", min_length=1, max_length=40)
    shortName: str = Field(default="星港", min_length=1, max_length=12)
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
    settings: bool = True
    email: bool = True
    tasks: bool = True


class AnnouncementSettings(StrictModel):
    maxPinned: int = Field(default=3, ge=0, le=3)
    dashboardLimit: int = Field(default=4, ge=1, le=10)
    showOnDashboard: bool = True


class CalendarSettings(StrictModel):
    weekStartsOn: Literal[0, 1] = 1
    showWeekends: bool = True
    defaultReminderOffsetsDays: list[int] = Field(default_factory=lambda: [3, 1, 0])
    defaultReminderTime: str = "09:00"
    allowPastDue: bool = True
    defaultEmailEnabled: bool = True

    @field_validator("defaultReminderOffsetsDays")
    @classmethod
    def valid_offsets(cls, value: list[int]) -> list[int]:
        if any(offset < 0 or offset > 60 for offset in value):
            raise ValueError("提醒提前天数必须在 0-60 之间")
        return sorted(set(value), reverse=True)

    @field_validator("defaultReminderTime")
    @classmethod
    def valid_time(cls, value: str) -> str:
        if not TIME_PATTERN.fullmatch(value):
            raise ValueError("时间必须是 HH:MM")
        return value


class RedBlackSettings(StrictModel):
    showScores: bool = True
    monthlyThemeEnabled: bool = True
    redLabel: str = "红榜 · 高光时刻"
    blackLabel: str = "黑榜 · 待改进"


class SmtpSettings(StrictModel):
    host: str = ""
    port: int = Field(default=587, ge=1, le=65535)
    username: str = ""
    password: str = ""
    fromEmail: str = ""
    fromName: str = "团队工作室"
    useStartTls: bool = True
    useSsl: bool = False
    timeoutSeconds: int = Field(default=15, ge=3, le=120)

    @field_validator("fromEmail")
    @classmethod
    def valid_from_email(cls, value: str) -> str:
        if value and not EMAIL_PATTERN.fullmatch(value):
            raise ValueError("发件邮箱格式不正确")
        return value


class ReminderSettings(StrictModel):
    enabled: bool = True
    offsetsDays: list[int] = Field(default_factory=lambda: [3, 1, 0])
    sendTime: str = "09:00"
    scanIntervalSeconds: int = Field(default=60, ge=30, le=86400)
    notifyAssignee: bool = True
    additionalRecipients: list[str] = Field(default_factory=list)
    includeAnnouncements: bool = True
    includeTodoDescription: bool = True
    includeExtra: bool = True
    extraContent: str = "请及时同步进度；如遇阻塞，请在开发组日历中更新状态并 @ 对应负责人。"
    subjectTemplate: str = "[{{siteName}}] {{groupName}} · {{todoTitle}} 将于 {{dueDate}} 到期"
    bodyTemplate: str = (
        "{{memberName}} 你好：\n\n"
        "这是一封来自「{{siteName}}」的日程提醒。\n\n"
        "事项：{{todoTitle}}\n"
        "所属团队：{{teamName}} / {{groupName}}\n"
        "截止时间：{{dueDate}} {{dueTime}}\n"
        "优先级：{{priority}}\n"
        "事项说明：{{todoDescription}}\n\n"
        "{{announcements}}\n"
        "{{extraContent}}\n\n"
        "—— 团队工作室自动提醒"
    )

    @field_validator("offsetsDays")
    @classmethod
    def valid_offsets(cls, value: list[int]) -> list[int]:
        if any(offset < 0 or offset > 60 for offset in value):
            raise ValueError("提醒提前天数必须在 0-60 之间")
        return sorted(set(value), reverse=True)

    @field_validator("sendTime")
    @classmethod
    def valid_send_time(cls, value: str) -> str:
        if not TIME_PATTERN.fullmatch(value):
            raise ValueError("提醒发送时间必须是 HH:MM")
        return value

    @field_validator("additionalRecipients")
    @classmethod
    def valid_recipients(cls, value: list[str]) -> list[str]:
        for email in value:
            if not EMAIL_PATTERN.fullmatch(email):
                raise ValueError(f"附加收件人邮箱格式不正确: {email}")
        return list(dict.fromkeys(value))


class EmailSettings(StrictModel):
    enabled: bool = False
    smtp: SmtpSettings = Field(default_factory=SmtpSettings)
    reminders: ReminderSettings = Field(default_factory=ReminderSettings)


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


class AdminIdEntry(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=60)
    role: Literal["team_admin", "group_admin"] = "group_admin"
    teamId: str = ""
    groupIds: list[str] = Field(default_factory=list)
    note: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def scope_required(self) -> "AdminIdEntry":
        if self.role == "team_admin" and not self.teamId:
            raise ValueError("团队管理员必须指定 teamId")
        if self.role == "group_admin" and not self.groupIds:
            raise ValueError("开发组管理员必须至少指定一个 groupId")
        return self


class AdminIpEntry(StrictModel):
    ip: str = Field(min_length=1, max_length=80)
    name: str = Field(default="", max_length=60)
    role: Literal["team_admin", "group_admin"] = "team_admin"
    teamId: str = ""
    groupIds: list[str] = Field(default_factory=list)
    note: str = Field(default="", max_length=200)

    @field_validator("ip")
    @classmethod
    def valid_ip(cls, value: str) -> str:
        try:
            ipaddress.ip_network(value, strict=False)
        except ValueError as exc:
            raise ValueError(f"IP/CIDR 格式不正确: {value}") from exc
        return value

    @model_validator(mode="after")
    def scope_required(self) -> "AdminIpEntry":
        if self.role == "team_admin" and not self.teamId:
            raise ValueError("团队管理员必须指定 teamId")
        if self.role == "group_admin" and not self.groupIds:
            raise ValueError("开发组管理员必须至少指定一个 groupId")
        return self


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
    version: int = 1
    site: SiteSettings = Field(default_factory=SiteSettings)
    modules: ModuleFlags = Field(default_factory=ModuleFlags)
    announcements: AnnouncementSettings = Field(default_factory=AnnouncementSettings)
    calendar: CalendarSettings = Field(default_factory=CalendarSettings)
    redblack: RedBlackSettings = Field(default_factory=RedBlackSettings)
    email: EmailSettings = Field(default_factory=EmailSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)
    features: FeatureSettings = Field(default_factory=FeatureSettings)


DEFAULT_SETTINGS = Settings()


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
            self._settings = Settings.model_validate(raw)
            self.updated_at = datetime.fromtimestamp(
                self.path.stat().st_mtime, tz=timezone.utc
            ).astimezone().isoformat(timespec="seconds")
            return self._settings

    def get(self) -> Settings:
        with self._lock:
            return self._settings.model_copy(deep=True)

    def validate(self, payload: dict) -> tuple[bool, Settings | None, list[dict[str, str]]]:
        try:
            candidate = Settings.model_validate(payload)
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

    def public(self) -> dict:
        cfg = self.get()
        sso = cfg.auth.sso
        return {
            "site": cfg.site.model_dump(mode="json"),
            "modules": cfg.modules.model_dump(mode="json"),
            "announcements": cfg.announcements.model_dump(mode="json"),
            "calendar": cfg.calendar.model_dump(mode="json"),
            "redblack": cfg.redblack.model_dump(mode="json"),
            "features": cfg.features.model_dump(mode="json"),
            "email": {"enabled": cfg.email.enabled, "remindersEnabled": cfg.email.reminders.enabled},
            "auth": {
                "guestMode": cfg.auth.guestMode,
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
