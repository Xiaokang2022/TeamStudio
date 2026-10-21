"""Workspace administration: create / delete teams (round 8: teams only).

Base path: ``/api/workspace``.

Permission domain (see ``CurrentUser`` helpers in ``backend/app/auth.py``):

- a super administrator (device Admin or stored ``super`` role) may manage every team and
  create/delete teams;
- ``team_admin`` only sees the teams listed in ``team_ids`` and can neither create nor
  delete a team (creation/deletion of the organisation unit stays super-only);
- linked members and guests cannot open the workspace manager at all.

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
from ..services.member_identity import person_key

router = APIRouter(prefix="/api/workspace", tags=["workspace-admin"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#5865f2"
CONFIRM_TEAM_MESSAGE = "请输入完整的团队名称以确认删除"


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
    if not user.is_super_admin and not user.team_ids:
        raise fail(403, "你没有管理团队工作区的权限", "not_admin")


def _team_payload(
    team: dict[str, Any], member_count: int, user: CurrentUser
) -> dict[str, Any]:
    return {
        "id": team["id"],
        "name": team["name"],
        "shortName": team.get("short_name", ""),
        "description": team.get("description", ""),
        "color": team.get("color", DEFAULT_COLOR),
        "memberCount": int(member_count or 0),
        "canDelete": user.is_super_admin,
    }


def _member_counts(conn: sqlite3.Connection) -> dict[str, int]:
    """De-duplicated member count per team (migration keeps historical duplicates)."""
    keys: dict[str, set[str]] = {}
    for member in rows(conn, "SELECT team_id, id, external_id, email FROM members"):
        keys.setdefault(str(member["team_id"]), set()).add(person_key(member))
    return {team_id: len(values) for team_id, values in keys.items()}


def _manage_payload(conn: sqlite3.Connection, user: CurrentUser) -> dict[str, Any]:
    _require_workspace_admin(user)
    if user.is_super_admin:
        team_rows = rows(conn, "SELECT * FROM teams ORDER BY sort_order, name")
    else:
        placeholders = ",".join("?" for _ in user.team_ids)
        team_rows = rows(
            conn,
            f"SELECT * FROM teams WHERE id IN ({placeholders}) ORDER BY sort_order, name",
            tuple(sorted(user.team_ids)),
        )
    member_counts = _member_counts(conn)
    return {
        "teams": [
            _team_payload(team, member_counts.get(str(team["id"]), 0), user)
            for team in team_rows
        ],
        "permissions": {
            "canCreateTeam": user.can_create_team(),
            "canManageAnyTeam": user.is_super_admin or bool(user.team_ids),
        },
    }


def _next_sort_order(conn: sqlite3.Connection) -> int:
    current = scalar(conn, "SELECT COALESCE(MAX(sort_order), 0) FROM teams", default=0)
    return int(current or 0) + 1


def _get_team(conn: sqlite3.Connection, team_id: str) -> dict[str, Any]:
    team = row(conn, "SELECT * FROM teams WHERE id=?", (team_id,))
    if not team:
        raise fail(404, "团队不存在", "team_not_found")
    return team


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
        raise fail(403, "仅超级管理员可创建团队", "not_admin")

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
                _next_sort_order(conn),
                now_iso(),
            ),
        )
        audit(conn, user, "team.create", "team", team_id, {"name": name})
        team = _get_team(conn, team_id)
    return ok({"team": _team_payload(team, 0, user)})


@router.delete("/teams/{team_id}")
def delete_team(
    team_id: str,
    payload: dict[str, Any] | None = Body(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    if not user.is_super_admin:
        raise fail(403, "仅超级管理员可删除团队", "not_admin")
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
        # members/works/todos/tasks/boards/links/matrix/announcements/tags all reference
        # the team with ON DELETE CASCADE.
        conn.execute("DELETE FROM teams WHERE id=?", (team_id,))
        audit(conn, user, "team.delete", "team", team_id, {"name": expected})
    return ok({"deleted": True, "id": team_id})
