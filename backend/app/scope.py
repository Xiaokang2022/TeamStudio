"""Data browsing scope: single development group, a whole team, or every team.

Feature GET routes accept an optional ``scope`` query parameter:

- ``group`` (default): only the path development group.
- ``team``: every development group of the path team.
- ``all``: every development group of every team.

Writes stay group-scoped; the frontend routes a write back to the group that owns the
entity (each payload item carries ``groupId``). The resolver below only widens reads, so
the existing permission model is untouched.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import Query

from .db import rows
from .http import fail

SCOPE_KINDS = ("group", "team", "all")
DEFAULT_SCOPE = "group"


def normalize_scope(value: str | None) -> str:
    cleaned = (value or DEFAULT_SCOPE).strip().lower()
    if cleaned not in SCOPE_KINDS:
        raise fail(422, "scope 必须是 group/team/all", "invalid_scope")
    return cleaned


def scope_query(scope: str | None = Query(default=DEFAULT_SCOPE)) -> str:
    """FastAPI dependency that validates the raw ``scope`` query value."""
    return normalize_scope(scope)


def _groups_payload(groups: list[dict[str, Any]], teams: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for group in groups:
        team = teams.get(group["team_id"], {})
        result.append(
            {
                "id": group["id"],
                "teamId": group["team_id"],
                "teamName": team.get("name", ""),
                "teamShortName": team.get("short_name", ""),
                "name": group["name"],
                "color": group.get("color", "#5865f2"),
                "icon": group.get("icon", "layers"),
            }
        )
    return result


def resolve_scope(
    conn: sqlite3.Connection,
    team_id: str | None,
    group_id: str | None,
    scope: str | None = DEFAULT_SCOPE,
) -> dict[str, Any]:
    """Resolve the effective read scope for one request.

    Returns ``{kind, label, teamIds, groupIds, groups, team, group}`` where ``groups`` is
    a camelCase list that the UI can use for labels and pickers.
    """
    kind = normalize_scope(scope)
    team_rows = rows(conn, "SELECT id, name, short_name, color FROM teams ORDER BY sort_order, name")
    group_rows = rows(
        conn,
        "SELECT id, team_id, name, color, icon FROM groups ORDER BY sort_order, name",
    )
    teams = {item["id"]: item for item in team_rows}
    groups = {item["id"]: item for item in group_rows}

    active_group = groups.get(group_id or "")
    active_team = teams.get(team_id or "")
    if not active_team and active_group:
        active_team = teams.get(active_group["team_id"])

    if kind == "group":
        if not active_group:
            raise fail(404, "团队或开发组不存在", "group_not_found")
        selected = [active_group]
    elif kind == "team":
        if not active_team:
            raise fail(404, "团队不存在", "team_not_found")
        selected = [group for group in group_rows if group["team_id"] == active_team["id"]]
        if not selected:
            raise fail(404, "团队下没有开发组", "group_not_found")
    else:
        selected = list(group_rows)

    selected_ids = [item["id"] for item in selected]
    team_ids: list[str] = []
    for item in selected:
        if item["team_id"] not in team_ids:
            team_ids.append(item["team_id"])

    if kind == "group":
        label = active_group["name"] if active_group else "开发组"
    elif kind == "team":
        label = f"{active_team['name']} · 全团队" if active_team else "全团队"
    else:
        label = "全部团队"

    return {
        "kind": kind,
        "label": label,
        "teamIds": team_ids,
        "groupIds": selected_ids,
        "groups": _groups_payload(selected, teams),
        "team": (
            {
                "id": active_team["id"],
                "name": active_team["name"],
                "shortName": active_team.get("short_name", ""),
                "color": active_team.get("color", "#5865f2"),
            }
            if active_team
            else None
        ),
        "group": (
            {
                "id": active_group["id"],
                "teamId": active_group["team_id"],
                "name": active_group["name"],
                "color": active_group.get("color", "#5865f2"),
            }
            if active_group
            else None
        ),
    }


def group_placeholders(group_ids: list[str]) -> str:
    """SQL ``IN`` placeholder list for a non-empty group id list."""
    return ",".join("?" for _ in group_ids)


def group_names(scope: dict[str, Any]) -> dict[str, str]:
    return {item["id"]: item["name"] for item in scope["groups"]}
