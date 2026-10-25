"""Bootstrap payload, team tree and health endpoints (round 8: teams only)."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Response

from ..auth import CurrentUser, get_current_user, refresh_session_cookie
from ..config import settings_service
from ..db import db, rows, scalar
from ..http import ok
from ..services.member_identity import first_member_in_team, person_key
from ..services.team_settings import build_payload as build_team_settings
from ..services.team_settings import default_payload as default_team_settings

router = APIRouter(prefix="/api", tags=["bootstrap"])


def _team_ref(team: dict[str, Any], member_count: int, pinned_count: int) -> dict[str, Any]:
    return {
        "id": team["id"],
        "name": team["name"],
        "shortName": team.get("short_name", ""),
        "description": team.get("description", ""),
        "color": team.get("color", "#5865f2"),
        "memberCount": int(member_count or 0),
        "pinnedCount": int(pinned_count or 0),
    }


def _team_tree(conn) -> list[dict[str, Any]]:
    """Every team with its (de-duplicated) member and pinned-announcement counts."""
    teams = rows(conn, "SELECT * FROM teams ORDER BY sort_order, name")
    member_keys: dict[str, set[str]] = {}
    for member in rows(conn, "SELECT team_id, id, external_id, email FROM members"):
        member_keys.setdefault(str(member["team_id"]), set()).add(person_key(member))
    pinned_counts = {
        str(item["team_id"]): int(item["count"] or 0)
        for item in rows(
            conn,
            "SELECT team_id, COUNT(*) AS count FROM announcements "
            "WHERE pinned=1 GROUP BY team_id",
        )
    }
    return [
        _team_ref(
            team,
            len(member_keys.get(str(team["id"]), set())),
            pinned_counts.get(str(team["id"]), 0),
        )
        for team in teams
    ]


def _resolve_active_team(
    teams: list[dict[str, Any]], team_id: str | None
) -> dict[str, Any] | None:
    requested = next((team for team in teams if team["id"] == team_id), None)
    if requested is not None:
        return requested
    # An unknown teamId falls back to the first team; no teams at all means no active team.
    return teams[0] if teams else None


def _resolve_active_linked_member(
    conn, user: CurrentUser, active_team: dict[str, Any] | None
) -> None:
    """Point ``me.linkedMemberId`` at the archive row of the **active** team.

    One account may own archive rows in several teams (and historical duplicates inside
    one team). The workspace top-right "my member card" must address the current team and
    fall back to ``null`` when this team has no profile, so the UI can hide the entry
    instead of rendering a dead link.
    """
    linked_ids = user.linked_member_id_list()
    resolved = (
        first_member_in_team(conn, active_team["id"], linked_ids) if active_team else None
    )
    user.linked_member_id = resolved["id"] if resolved else None
    user.linked_member_name = resolved["name"] if resolved else None


def _bootstrap_stats(conn, teams: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "teams": len(teams),
        "members": sum(int(team["memberCount"] or 0) for team in teams),
        "todos": int(scalar(conn, "SELECT COUNT(*) FROM todos WHERE status='todo'", default=0) or 0),
        "pinned": int(
            scalar(conn, "SELECT COUNT(*) FROM announcements WHERE pinned=1", default=0) or 0
        ),
        "currentWorks": int(
            scalar(conn, "SELECT COUNT(*) FROM works WHERE status='current'", default=0) or 0
        ),
        "serverDate": date.today().isoformat(),
    }


@router.get("/bootstrap")
def bootstrap(
    response: Response,
    teamId: str | None = Query(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    # Sliding session: every visit re-signs the cookie so the configured idle window
    # (default 7 days) counts from the most recent request.
    refresh_session_cookie(response, user)
    with db() as conn:
        teams = _team_tree(conn)
        active_team = _resolve_active_team(teams, teamId)
        _resolve_active_linked_member(conn, user, active_team)
        stats = _bootstrap_stats(conn, teams)
        if active_team is not None:
            team_settings = build_team_settings(conn, str(active_team["id"]), user)
        else:
            team_settings = default_team_settings()
    # Guests only see what the team exposes to guests; logged-in members use the team
    # module switches. The site-wide switches are already folded into "effective".
    module_flags = (
        team_settings["effective"]["modules"]
        if user.authenticated
        else team_settings["effective"]["guestModules"]
    )
    active = {
        "team": active_team,
        "moduleFlags": module_flags,
        "teamSettings": team_settings["settings"],
        "canEditTeamSettings": bool(team_settings["canEdit"]),
    }
    return ok(
        {
            "me": user.as_dict(),
            "config": settings_service.public(),
            "teams": teams,
            "active": active,
            "stats": stats,
            "serverTime": date.today().isoformat(),
            "deviceAdminName": "Admin",
        }
    )


@router.get("/teams")
def get_teams(user: CurrentUser = Depends(get_current_user)):
    with db() as conn:
        return ok({"teams": _team_tree(conn)})


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
