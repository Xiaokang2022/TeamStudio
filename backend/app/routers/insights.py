"""Data insights dashboard routes (``#12``).

Base path: ``/api/teams/{team_id}/groups/{group_id}``. The endpoint is readable by guests
(``require_read_access``) and honours the global browsing scope plus an analytics range.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..auth import CurrentUser
from ..db import db
from ..http import get_group, ok
from ..permissions import require_read_access
from ..scope import resolve_scope
from ..services.insights_service import build_insights

router = APIRouter(prefix="/api/teams/{team_id}/groups/{group_id}", tags=["insights"])


@router.get("/insights")
def group_insights(
    team_id: str,
    group_id: str,
    scope: str = Query(default="group"),
    range_key: str = Query(default="1m", alias="range"),
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        ctx = resolve_scope(conn, team_id, group_id, scope, user)
        data = build_insights(conn, ctx, range_key)
    return ok(data)
