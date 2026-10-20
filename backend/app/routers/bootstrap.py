"""Bootstrap payload, workspace tree and health endpoints."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Response

from ..auth import CurrentUser, get_current_user, refresh_session_cookie
from ..config import settings_service
from ..db import db, rows, scalar
from ..http import ok


router = APIRouter(prefix="/api", tags=["bootstrap"])


def _workspace_tree(conn) -> list[dict[str, Any]]:
    teams = rows(conn, "SELECT * FROM teams ORDER BY sort_order, name")
    groups = rows(conn, "SELECT * FROM groups ORDER BY sort_order, name")
    member_counts = {
        item["group_id"]: item["count"]
        for item in rows(
            conn, "SELECT group_id, COUNT(*) AS count FROM members GROUP BY group_id"
        )
    }
    pinned_counts = {
        item["group_id"]: item["count"]
        for item in rows(
            conn,
            "SELECT group_id, COUNT(*) AS count FROM announcements WHERE pinned=1 GROUP BY group_id",
        )
    }
    result = []
    for team in teams:
        team_groups = []
        for group in groups:
            if group["team_id"] != team["id"]:
                continue
            team_groups.append(
                {
                    "id": group["id"],
                    "teamId": group["team_id"],
                    "name": group["name"],
                    "description": group["description"],
                    "color": group["color"],
                    "icon": group["icon"],
                    "memberCount": member_counts.get(group["id"], 0),
                    "pinnedCount": pinned_counts.get(group["id"], 0),
                }
            )
        result.append(
            {
                "id": team["id"],
                "name": team["name"],
                "shortName": team["short_name"],
                "description": team["description"],
                "color": team["color"],
                "groups": team_groups,
            }
        )
    return result


def _resolve_active(
    teams: list[dict[str, Any]], team_id: str | None, group_id: str | None
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    active_team = next((team for team in teams if team["id"] == team_id), None)
    if not active_team and team_id:
        active_team = next(
            (
                team
                for team in teams
                if any(group["id"] == group_id for group in team["groups"])
            ),
            None,
        )
    if not active_team:
        active_team = teams[0] if teams else None
    active_group = None
    if active_team:
        active_group = next(
            (group for group in active_team["groups"] if group["id"] == group_id), None
        )
        if not active_group:
            active_group = active_team["groups"][0] if active_team["groups"] else None
    return active_team, active_group


@router.get("/bootstrap")
def bootstrap(
    response: Response,
    teamId: str | None = Query(default=None),
    groupId: str | None = Query(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    cfg = settings_service.get()
    # Sliding session: every visit re-signs the cookie so the configured idle
    # window (default 7 days) counts from the most recent request.
    refresh_session_cookie(response, user)
    with db() as conn:
        teams = _workspace_tree(conn)
        active_team, active_group = _resolve_active(teams, teamId, groupId)
        stats = {
            "teams": len(teams),
            "groups": sum(len(team["groups"]) for team in teams),
            "members": scalar(conn, "SELECT COUNT(*) FROM members", default=0),
            "todos": scalar(
                conn,
                "SELECT COUNT(*) FROM todos WHERE status='todo'",
                default=0,
            ),
            "pinned": scalar(
                conn,
                "SELECT COUNT(*) FROM announcements WHERE pinned=1",
                default=0,
            ),
        }
        if active_group:
            stats["members"] = scalar(
                conn,
                "SELECT COUNT(*) FROM members WHERE group_id=?",
                (active_group["id"],),
                default=0,
            )
            stats["todos"] = scalar(
                conn,
                "SELECT COUNT(*) FROM todos WHERE group_id=? AND status='todo'",
                (active_group["id"],),
                default=0,
            )
            stats["pinned"] = scalar(
                conn,
                "SELECT COUNT(*) FROM announcements WHERE group_id=? AND pinned=1",
                (active_group["id"],),
                default=0,
            )
            stats["currentWorks"] = scalar(
                conn,
                "SELECT COUNT(*) FROM works w JOIN members m ON m.id=w.member_id "
                "WHERE m.group_id=? AND w.status='current'",
                (active_group["id"],),
                default=0,
            )
        stats["serverDate"] = date.today().isoformat()
    return ok(
        {
            "me": user.as_dict(),
            "config": settings_service.public(),
            "teams": teams,
            "active": {"team": active_team, "group": active_group},
            "stats": stats,
            "serverTime": date.today().isoformat(),
            "deviceAdminName": "Admin",
        }
    )


@router.get("/teams")
def get_teams(user: CurrentUser = Depends(get_current_user)):
    with db() as conn:
        return ok({"teams": _workspace_tree(conn)})


@router.get("/health")
def health():
    with db() as conn:
        scalar(conn, "SELECT 1")
    cfg = settings_service.get()
    return ok(
        {
            "status": "ok",
            "app": cfg.site.name,
            "version": "1.0.0",
            "ssoConfigured": settings_service.sso_configured(),
            "emailEnabled": cfg.email.enabled,
            "emailConfigured": settings_service.email_configured(),
        }
    )
