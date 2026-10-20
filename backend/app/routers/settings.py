"""Settings API.

Two layers (round 5):

* **Site level** – full JSON/GUI configuration (``/api/settings``). Super
  administrators only; this includes SMTP secrets, SSO, modules, accounts whitelist
  and session policy.
* **Domain level** – team / development-group basic settings
  (``/api/settings/domain``). Visible to the admins of that domain: a super
  administrator sees everything, a team administrator its teams and their groups,
  a development-group administrator only its groups.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from ..auth import CurrentUser, get_current_user, require_super
from ..config import DEFAULT_SETTINGS, ConfigValidationError, settings_service
from ..db import db, log_audit, row, rows
from ..http import fail, ok

router = APIRouter(prefix="/api/settings", tags=["settings"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#5865f2"


def _settings_payload() -> dict[str, Any]:
    return {
        "settings": settings_service.get().model_dump(mode="json"),
        "meta": settings_service.meta(),
    }


# --------------------------------------------------------------------------- site


@router.get("")
def get_settings(user: CurrentUser = Depends(require_super)):
    return ok(_settings_payload())


@router.put("")
def save_settings(
    payload: dict[str, Any] = Body(...), user: CurrentUser = Depends(require_super)
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
def validate_settings(payload: dict[str, Any] = Body(...), user: CurrentUser = Depends(require_super)):
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
    return ok({"valid": True, "settings": candidate.model_dump(mode="json") if candidate else None})


@router.get("/schema")
def settings_schema(user: CurrentUser = Depends(require_super)):
    return ok({"schema": settings_service.schema(), "meta": settings_service.meta()})


@router.get("/defaults")
def settings_defaults(user: CurrentUser = Depends(require_super)):
    return ok(DEFAULT_SETTINGS.model_dump(mode="json"))


@router.get("/workspace")
def settings_workspace(user: CurrentUser = Depends(require_super)):
    with db() as conn:
        teams = rows(conn, "SELECT id,name,short_name,color FROM teams ORDER BY sort_order, name")
        groups = rows(conn, "SELECT id,team_id,name,color FROM groups ORDER BY sort_order, name")
        members = rows(
            conn,
            "SELECT id,team_id,group_id,name,email,title FROM members ORDER BY team_id, group_id, sort_order",
        )
    return ok({"teams": teams, "groups": groups, "members": members})


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


def _visible_domain(conn: sqlite3.Connection, user: CurrentUser) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not user.is_admin:
        raise fail(403, "仅管理员可访问领域设置", "not_admin")
    team_rows = rows(conn, "SELECT * FROM teams ORDER BY sort_order, name")
    group_rows = rows(conn, "SELECT * FROM groups ORDER BY sort_order, name")
    if user.is_super_admin:
        return team_rows, group_rows
    if user.team_ids:
        return (
            [team for team in team_rows if team["id"] in user.team_ids],
            [group for group in group_rows if group["team_id"] in user.team_ids],
        )
    allowed_groups = {group["id"]: group for group in group_rows if group["id"] in user.group_ids}
    allowed_teams = {group["team_id"] for group in allowed_groups.values()}
    return (
        [team for team in team_rows if team["id"] in allowed_teams],
        list(allowed_groups.values()),
    )


def _domain_payload(conn: sqlite3.Connection, user: CurrentUser) -> dict[str, Any]:
    team_rows, group_rows = _visible_domain(conn, user)
    groups_by_team: dict[str, list[dict[str, Any]]] = {}
    for group in group_rows:
        groups_by_team.setdefault(group["team_id"], []).append(
            {
                "id": group["id"],
                "teamId": group["team_id"],
                "name": group["name"],
                "description": group.get("description", ""),
                "color": group.get("color", DEFAULT_COLOR),
                "icon": group.get("icon", "layers"),
                "canEdit": bool(
                    user.is_super_admin
                    or user.can_manage_team(group["team_id"])
                    or user.can_manage_group_settings(group["id"])
                ),
            }
        )
    teams = [
        {
            "id": team["id"],
            "name": team["name"],
            "shortName": team.get("short_name", ""),
            "description": team.get("description", ""),
            "color": team.get("color", DEFAULT_COLOR),
            "canEdit": bool(user.is_super_admin or user.can_manage_team(team["id"])),
            "groups": groups_by_team.get(team["id"], []),
        }
        for team in team_rows
    ]
    return {
        "teams": teams,
        "permissions": {
            "canEditSite": user.is_super_admin,
            "canEditStructure": bool(user.is_super_admin or user.team_ids),
            "canEditTeam": bool(user.is_super_admin or user.team_ids),
            "canEditGroup": bool(
                user.is_super_admin or user.team_ids or user.group_ids
            ),
            "isSuperAdmin": user.is_super_admin,
            "isDeviceAdmin": user.is_device_admin,
        },
    }


@router.get("/domain")
def get_domain_settings(user: CurrentUser = Depends(get_current_user)):
    with db() as conn:
        return ok(_domain_payload(conn, user))


def _get_team(conn: sqlite3.Connection, team_id: str) -> dict[str, Any]:
    team = row(conn, "SELECT * FROM teams WHERE id=?", (team_id,))
    if not team:
        raise fail(404, "团队不存在", "team_not_found")
    return team


def _get_group(conn: sqlite3.Connection, team_id: str, group_id: str) -> dict[str, Any]:
    group = row(conn, "SELECT * FROM groups WHERE id=? AND team_id=?", (group_id, team_id))
    if not group:
        raise fail(404, "开发组不存在或不属于该团队", "group_not_found")
    return group


@router.patch("/teams/{team_id}")
def update_domain_team(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        team = _get_team(conn, team_id)
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
        team = _get_team(conn, team_id)
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


@router.patch("/teams/{team_id}/groups/{group_id}")
def update_domain_group(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        group = _get_group(conn, team_id, group_id)
        allowed = (
            user.is_super_admin
            or user.can_manage_team(team_id)
            or user.can_manage_group_settings(group_id)
        )
        if not allowed:
            raise fail(403, "你没有该开发组设置的管理权限", "not_admin")
        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = _text(payload.get("name"), "开发组名称", 40, required=True)
        if "description" in payload:
            updates["description"] = _text(payload.get("description"), "开发组简介", 120)
        if "color" in payload:
            updates["color"] = _hex_color(payload.get("color"))
        if "icon" in payload:
            updates["icon"] = _text(payload.get("icon"), "图标", 40) or "layers"
        if updates:
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE groups SET {assignments} WHERE id=? AND team_id=?",
                (*updates.values(), group_id, team_id),
            )
            log_audit(
                conn,
                user.name or user.id,
                "group.settings.update",
                "group",
                group_id,
                {"fields": sorted(payload.keys()), "teamId": team_id},
            )
        group = _get_group(conn, team_id, group_id)
    return ok(
        {
            "group": {
                "id": group["id"],
                "teamId": group["team_id"],
                "name": group["name"],
                "description": group.get("description", ""),
                "color": group.get("color", DEFAULT_COLOR),
                "icon": group.get("icon", "layers"),
            }
        }
    )
