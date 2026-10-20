"""Workspace administration: create / delete teams and development groups.

Base path: ``/api/workspace``.

Permission domain (see ``CurrentUser`` helpers in ``backend/app/auth.py``):

- Device Admin (``is_device_admin``) may manage every team and create teams.
- ``team_admin`` may manage only the teams listed in ``team_ids``: it can create and
  delete development groups inside those teams, but it can neither create nor delete a
  team.
- ``group_admin`` / linked member / guest cannot restructure the workspace at all.

Every destructive action requires the caller to type the target's exact name; a mismatch is
reported as ``422 confirm_mismatch`` with the expected name in ``details``.

Response envelope is always ``{"ok": true, "data": ...}``.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends

from ..auth import CurrentUser, get_current_user
from ..db import db, new_id, now_iso, row, rows, scalar
from ..http import fail, ok, text
from ..permissions import audit

router = APIRouter(prefix="/api/workspace", tags=["workspace-admin"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#5865f2"
DEFAULT_GROUP_ICON = "layers"
CONFIRM_TEAM_MESSAGE = "请输入完整的团队名称以确认删除"
CONFIRM_GROUP_MESSAGE = "请输入完整的开发组名称以确认删除"


# --------------------------------------------------------------------------- helpers


def _hex_color(value: Any, field: str = "颜色", fallback: str = DEFAULT_COLOR) -> str:
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not HEX_PATTERN.fullmatch(value):
        raise fail(422, f"{field}必须是 #RRGGBB 格式", "validation_error")
    return value.lower()


def _confirm_name(payload: dict[str, Any] | None) -> str:
    value = (payload or {}).get("confirmName")
    return value.strip() if isinstance(value, str) else ""


def _require_workspace_admin(user: CurrentUser) -> None:
    """A caller without any manageable team cannot open the workspace manager."""
    if not user.is_device_admin and not user.team_ids:
        raise fail(403, "你没有管理团队工作区的权限", "not_admin")


def _group_payload(
    group: dict[str, Any], member_count: int, can_delete: bool
) -> dict[str, Any]:
    return {
        "id": group["id"],
        "teamId": group["team_id"],
        "name": group["name"],
        "description": group.get("description", ""),
        "color": group.get("color", DEFAULT_COLOR),
        "icon": group.get("icon", DEFAULT_GROUP_ICON),
        "memberCount": int(member_count or 0),
        "canDelete": can_delete,
    }


def _team_payload(
    team: dict[str, Any],
    groups: list[dict[str, Any]],
    member_count: int,
    user: CurrentUser,
) -> dict[str, Any]:
    return {
        "id": team["id"],
        "name": team["name"],
        "shortName": team.get("short_name", ""),
        "description": team.get("description", ""),
        "color": team.get("color", DEFAULT_COLOR),
        "groupCount": len(groups),
        "memberCount": int(member_count or 0),
        "canDelete": user.is_device_admin,
        "canCreateGroup": user.can_manage_team(team["id"]),
        "groups": groups,
    }


def _manage_payload(conn: sqlite3.Connection, user: CurrentUser) -> dict[str, Any]:
    _require_workspace_admin(user)
    if user.is_device_admin:
        team_rows = rows(conn, "SELECT * FROM teams ORDER BY sort_order, name")
    else:
        placeholders = ",".join("?" for _ in user.team_ids)
        team_rows = rows(
            conn,
            f"SELECT * FROM teams WHERE id IN ({placeholders}) ORDER BY sort_order, name",
            tuple(sorted(user.team_ids)),
        )
    group_rows = rows(conn, "SELECT * FROM groups ORDER BY sort_order, name")
    group_member_counts = {
        item["group_id"]: item["count"]
        for item in rows(
            conn, "SELECT group_id, COUNT(*) AS count FROM members GROUP BY group_id"
        )
    }
    team_member_counts = {
        item["team_id"]: item["count"]
        for item in rows(
            conn, "SELECT team_id, COUNT(*) AS count FROM members GROUP BY team_id"
        )
    }
    visible_team_ids = {team["id"] for team in team_rows}
    groups_by_team: dict[str, list[dict[str, Any]]] = {}
    for group in group_rows:
        team_id = group["team_id"]
        if team_id not in visible_team_ids:
            continue
        groups_by_team.setdefault(team_id, []).append(
            _group_payload(
                group,
                group_member_counts.get(group["id"], 0),
                user.can_manage_team(team_id),
            )
        )
    teams = [
        _team_payload(
            team,
            groups_by_team.get(team["id"], []),
            team_member_counts.get(team["id"], 0),
            user,
        )
        for team in team_rows
    ]
    return {
        "teams": teams,
        "permissions": {
            "canCreateTeam": user.can_create_team(),
            "canCreateGroup": user.is_device_admin or bool(user.team_ids),
            "canManageAnyTeam": bool(user.is_device_admin or user.team_ids),
        },
    }


def _next_sort_order(
    conn: sqlite3.Connection, table: str, where: str = "", params: tuple[Any, ...] = ()
) -> int:
    clause = f" WHERE {where}" if where else ""
    current = scalar(
        conn,
        f"SELECT COALESCE(MAX(sort_order), 0) FROM {table}{clause}",
        params,
        default=0,
    )
    return int(current or 0) + 1


def _get_team(conn: sqlite3.Connection, team_id: str) -> dict[str, Any]:
    team = row(conn, "SELECT * FROM teams WHERE id=?", (team_id,))
    if not team:
        raise fail(404, "团队不存在", "team_not_found")
    return team


def _get_group(
    conn: sqlite3.Connection, team_id: str, group_id: str
) -> dict[str, Any]:
    group = row(
        conn, "SELECT * FROM groups WHERE id=? AND team_id=?", (group_id, team_id)
    )
    if not group:
        raise fail(404, "开发组不存在或不属于该团队", "group_not_found")
    return group


# --------------------------------------------------------------------------- read


@router.get("/manage")
def manage_workspace(user: CurrentUser = Depends(get_current_user)):
    with db() as conn:
        return ok(_manage_payload(conn, user))


# --------------------------------------------------------------------------- teams


@router.post("/teams")
def create_team(
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    if not user.can_create_team():
        raise fail(403, "仅部署设备的 Admin 可创建团队", "not_admin")

    name = text(payload.get("name"), "团队名称", 40, required=True)
    raw_short_name = payload.get("shortName")
    if raw_short_name is None or raw_short_name == "":
        short_name = name[:4]
    else:
        short_name = text(raw_short_name, "团队简称", 12) or name[:4]
    description = text(payload.get("description"), "团队简介", 120)
    color = _hex_color(payload.get("color"))

    with db() as conn:
        team_id = new_id("team")
        conn.execute(
            "INSERT INTO teams (id,name,short_name,description,color,sort_order,created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                team_id,
                name,
                short_name,
                description,
                color,
                _next_sort_order(conn, "teams"),
                now_iso(),
            ),
        )
        audit(conn, user, "team.create", "team", team_id, {"name": name})
        team = _get_team(conn, team_id)
    return ok({"team": _team_payload(team, [], 0, user)})


@router.delete("/teams/{team_id}")
def delete_team(
    team_id: str,
    payload: dict[str, Any] | None = Body(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    if not user.is_device_admin:
        raise fail(403, "仅部署设备的 Admin 可删除团队", "not_admin")
    with db() as conn:
        team = _get_team(conn, team_id)
        expected = team["name"]
        if _confirm_name(payload) != expected.strip():
            raise fail(
                422,
                CONFIRM_TEAM_MESSAGE,
                "confirm_mismatch",
                {"expected": expected},
            )
        # groups/members/works/todos/tasks/boards/links/matrix/announcements/tags all
        # reference the team (directly or through groups) with ON DELETE CASCADE.
        conn.execute("DELETE FROM teams WHERE id=?", (team_id,))
        audit(conn, user, "team.delete", "team", team_id, {"name": expected})
    return ok({"deleted": True, "id": team_id})


# --------------------------------------------------------------------------- groups


@router.post("/teams/{team_id}/groups")
def create_group(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        _get_team(conn, team_id)
        user.require_team_manager(team_id)

        name = text(payload.get("name"), "开发组名称", 40, required=True)
        description = text(payload.get("description"), "开发组简介", 120)
        color = _hex_color(payload.get("color"))
        icon = text(payload.get("icon"), "图标", 40) or DEFAULT_GROUP_ICON

        group_id = new_id("group")
        conn.execute(
            "INSERT INTO groups (id,team_id,name,description,color,icon,sort_order,"
            "created_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                group_id,
                team_id,
                name,
                description,
                color,
                icon,
                _next_sort_order(conn, "groups", "team_id=?", (team_id,)),
                now_iso(),
            ),
        )
        audit(
            conn,
            user,
            "group.create",
            "group",
            group_id,
            {"name": name, "teamId": team_id},
        )
        group = _get_group(conn, team_id, group_id)
    return ok({"group": _group_payload(group, 0, user.can_manage_team(team_id))})


@router.delete("/teams/{team_id}/groups/{group_id}")
def delete_group(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] | None = Body(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        _get_team(conn, team_id)
        user.require_team_manager(team_id)
        group = _get_group(conn, team_id, group_id)
        expected = group["name"]
        if _confirm_name(payload) != expected.strip():
            raise fail(
                422,
                CONFIRM_GROUP_MESSAGE,
                "confirm_mismatch",
                {"expected": expected},
            )
        # members/works/todos/tasks/boards/links/matrix/announcements/tags cascade.
        conn.execute(
            "DELETE FROM groups WHERE id=? AND team_id=?", (group_id, team_id)
        )
        audit(
            conn,
            user,
            "group.delete",
            "group",
            group_id,
            {"name": expected, "teamId": team_id},
        )
    return ok({"deleted": True, "id": group_id})
