"""Data insights dashboard routes (``#12``).

Base path: ``/api/teams/{team_id}``. Round 8 removed the browsing ``scope``: the dashboard
always aggregates exactly one team. Guests may read it only while the ``insights`` module is
enabled for guests (``Depends(require_read_module("insights"))``).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..auth import CurrentUser
from ..db import db
from ..http import get_team, ok
from ..permissions import require_read_module
from ..services.insights_service import build_insights

router = APIRouter(prefix="/api/teams/{team_id}", tags=["insights"])


@router.get("/insights")
def team_insights(
    team_id: str,
    range_key: str = Query(default="1m", alias="range"),
    user: CurrentUser = Depends(require_read_module("insights")),
):
    with db() as conn:
        get_team(conn, team_id)
        data = build_insights(conn, team_id, range_key)
    return ok(data)
