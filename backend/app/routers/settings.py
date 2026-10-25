"""Settings API (round 8: teams are the only organisation unit).

Two layers:

* **Site level** – full JSON/GUI configuration (``/api/settings``). Super administrators
  only; this includes SMTP secrets, SSO, modules (including the per-module guest flags
  ``guestModules``), the admin whitelist and session policy.
* **Domain level** – team basic settings (``/api/settings/domain``). Visible to the admins
  of those teams: a super administrator sees every team, a team administrator its
  ``team_ids`` entries. Development groups no longer exist, so the domain payload is team
  only (no ``groups`` / ``canEditGroup`` / group PATCH route).

The configuration schema, validation, defaults and JSON editor schema all come from
``config.Settings`` so ``guestModules`` and the team-only admin whitelist are reflected
automatically.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from ..auth import CurrentUser, get_current_user
from ..config import DEFAULT_SETTINGS, ConfigValidationError, settings_service
from ..db import db, log_audit, rows
from ..http import fail, get_team, ok
from ..permissions import require_read_module
from ..services.team_settings import build_payload as build_team_settings
from ..services.team_settings import save as save_team_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#5865f2"


def _require_super_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Local dependency so the router does not depend on auth module internals."""
    if not user.is_super_admin:
        raise fail(403, "仅超级管理员可执行此操作", "not_admin")
    return user


def _settings_payload() -> dict[str, Any]:
    return {
        "settings": settings_service.get().model_dump(mode="json"),
        "meta": settings_service.meta(),
    }


# --------------------------------------------------------------------------- site


@router.get("")
def get_settings(user: CurrentUser = Depends(_require_super_admin)):
    return ok(_settings_payload())


@router.put("")
def save_settings(
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(_require_super_admin),
):
    try:
        saved = settings_service.save(payload)
    except ConfigValidationError as exc:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": {
                    "code": "settings_validation_failed",
                    "message": "配置校验未通过，请修正后再保存。",
                    "details": exc.details,
                },
            },
        )
    return ok(
        {
            "settings": saved.model_dump(mode="json"),
            "meta": settings_service.meta(),
            "message": "配置已保存并即时生效",
        }
    )


@router.post("/validate")
def validate_settings(
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(_require_super_admin),
):
    valid, candidate, details = settings_service.validate(payload)
    if not valid:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": {
                    "code": "settings_validation_failed",
                    "message": "JSON 配置校验未通过。",
                    "details": details,
                },
            },
        )
    return ok(
        {
            "valid": True,
            "settings": candidate.model_dump(mode="json") if candidate else None,
        }
    )


@router.get("/schema")
def settings_schema(user: CurrentUser = Depends(_require_super_admin)):
    return ok({"schema": settings_service.schema(), "meta": settings_service.meta()})


@router.get("/defaults")
def settings_defaults(user: CurrentUser = Depends(_require_super_admin)):
    return ok(DEFAULT_SETTINGS.model_dump(mode="json"))


@router.get("/workspace")
def settings_workspace(user: CurrentUser = Depends(_require_super_admin)):
    """Team list used by the settings JSON editor / domain pickers (teams only)."""
    with db() as conn:
        teams = rows(
            conn,
            "SELECT id, name, short_name, color FROM teams ORDER BY sort_order, name",
        )
    return ok({"teams": teams})


# --------------------------------------------------------------------------- domain


def _hex_color(value: Any, field: str = "颜色") -> str:
    if value is None or value == "":
        return DEFAULT_COLOR
    if not isinstance(value, str) or not HEX_PATTERN.fullmatch(value):
        raise fail(422, f"{field}必须是 #RRGGBB 格式", "validation_error")
    return value.lower()


def _text(value: Any, field: str, max_length: int, required: bool = False) -> str:
    cleaned = str(value).strip() if value is not None else ""
    if required and not cleaned:
        raise fail(422, f"{field}不能为空", "validation_error")
    if len(cleaned) > max_length:
        raise fail(422, f"{field}不能超过 {max_length} 个字符", "validation_error")
    return cleaned


def _visible_teams(
    conn: sqlite3.Connection, user: CurrentUser
) -> list[dict[str, Any]]:
    if not user.is_admin:
        raise fail(403, "仅管理员可访问领域设置", "not_admin")
    team_rows = rows(conn, "SELECT * FROM teams ORDER BY sort_order, name")
    if user.is_super_admin:
        return team_rows
    return [team for team in team_rows if team["id"] in user.team_ids]


def _domain_payload(conn: sqlite3.Connection, user: CurrentUser) -> dict[str, Any]:
    team_rows = _visible_teams(conn, user)
    teams = [
        {
            "id": team["id"],
            "name": team["name"],
            "shortName": team.get("short_name", ""),
            "description": team.get("description", ""),
            "color": team.get("color", DEFAULT_COLOR),
            "canEdit": bool(user.is_super_admin or user.can_manage_team(team["id"])),
        }
        for team in team_rows
    ]
    return {
        "teams": teams,
        "permissions": {
            "canEditSite": user.is_super_admin,
            "canEditStructure": bool(user.is_super_admin or user.team_ids),
            "canEditTeam": bool(user.is_super_admin or user.team_ids),
            "isSuperAdmin": user.is_super_admin,
            "isDeviceAdmin": user.is_device_admin,
        },
    }


@router.get("/domain")
def get_domain_settings(user: CurrentUser = Depends(get_current_user)):
    with db() as conn:
        return ok(_domain_payload(conn, user))


@router.patch("/teams/{team_id}")
def update_domain_team(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        team = get_team(conn, team_id)
        if not (user.is_super_admin or user.can_manage_team(team_id)):
            raise fail(403, "你没有该团队设置的管理权限", "not_admin")
        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = _text(payload.get("name"), "团队名称", 40, required=True)
        if "shortName" in payload:
            short_name = _text(payload.get("shortName"), "团队简称", 12)
            updates["short_name"] = short_name or (updates.get("name", team["name"])[:4])
        if "description" in payload:
            updates["description"] = _text(payload.get("description"), "团队简介", 120)
        if "color" in payload:
            updates["color"] = _hex_color(payload.get("color"))
        if updates:
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE teams SET {assignments} WHERE id=?",
                (*updates.values(), team_id),
            )
            log_audit(
                conn,
                user.name or user.id,
                "team.settings.update",
                "team",
                team_id,
                {"fields": sorted(payload.keys())},
            )
        team = get_team(conn, team_id)
    return ok(
        {
            "team": {
                "id": team["id"],
                "name": team["name"],
                "shortName": team.get("short_name", ""),
                "description": team.get("description", ""),
                "color": team.get("color", DEFAULT_COLOR),
            }
        }
    )

# ------------------------------------------------------------------- team modules
#
# Round 9: each team owns module switches ("team settings"). GET/PUT live under
# /api/teams/{team_id}/settings and reuse the round-9 service; the site-level
# router above (including PATCH /api/settings/teams/{team_id}) is unchanged.

team_router = APIRouter(prefix="/api/teams", tags=["settings"])


@team_router.get("/{team_id}/settings")
def get_team_settings(
    team_id: str,
    user: CurrentUser = Depends(require_read_module("settings")),
):
    """Stored team module switches + effective visibility (readable team members)."""
    with db() as conn:
        get_team(conn, team_id)
        payload = build_team_settings(conn, team_id, user)
    return ok(payload)


@team_router.put("/{team_id}/settings")
def update_team_settings(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Partially merge team module switches; team administrators only."""
    with db() as conn:
        get_team(conn, team_id)
        if not user.can_edit_team(team_id):
            raise fail(403, "你没有该团队设置的管理权限", "not_admin")
        result = save_team_settings(conn, team_id, payload, user)
    return ok(result)

