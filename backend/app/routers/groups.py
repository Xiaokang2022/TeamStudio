"""Round-9 custom group routes (task groups / member groups).

Base path: /api/teams/{team_id}/groups. Reads need the usual read access (guests
included while guest read mode is on); every mutation requires a team administrator.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from ..auth import CurrentUser, get_current_user
from ..db import db, new_id, now_iso
from ..http import fail, get_team, ok
from ..permissions import audit, require_read_access, require_team_admin
from ..services.groups_service import (
    DEFAULT_GROUP_COLOR,
    GROUP_KINDS,
    ensure_unique_name,
    get_group,
    group_payload,
    list_groups,
    next_sort_order,
    validate_group_color,
    validate_group_name,
)

router = APIRouter(prefix="/api/teams/{team_id}/groups", tags=["groups"])


def _check_kind(kind: str) -> str:
    if kind not in GROUP_KINDS:
        raise fail(422, "分组类型必须是 task 或 member", "validation_error")
    return kind


def _load_group(conn, team_id: str, group_id: str, kind: str = "") -> dict[str, Any]:
    """Fetch one group of a team; an empty ``kind`` accepts task and member groups.

    PATCH/DELETE must stay usable without repeating the kind (clients only know the
    group id), while an explicitly supplied kind still has to be valid.
    """
    group = get_group(conn, team_id, group_id, kind or None)
    if not group:
        raise fail(404, "分组不存在", "group_not_found")
    return group


@router.get("")
def list_team_groups(
    team_id: str,
    kind: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    require_read_access(user)
    with db() as conn:
        get_team(conn, team_id)
        if kind is not None:
            _check_kind(kind)
        items = [group_payload(group) for group in list_groups(conn, team_id, kind)]
    return ok({"groups": items})


@router.post("")
def create_group(
    team_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_team(conn, team_id)
        require_team_admin(user, team_id)
        kind = _check_kind(str(payload.get("kind") or "task"))
        name = validate_group_name(payload.get("name"))
        color = validate_group_color(payload.get("color"), DEFAULT_GROUP_COLOR)
        ensure_unique_name(conn, team_id, kind, name)
        group_id = new_id("grp")
        now = now_iso()
        conn.execute(
            "INSERT INTO team_groups (id, team_id, kind, name, color, sort_order, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                group_id,
                team_id,
                kind,
                name,
                color,
                next_sort_order(conn, team_id, kind),
                now,
                now,
            ),
        )
        group = get_group(conn, team_id, group_id, kind)
        audit(
            conn,
            user,
            "group.create",
            "team_group",
            group_id,
            {"name": name, "kind": kind},
        )
    return ok({"group": group_payload(group or {})})


@router.patch("/{group_id}")
def update_group(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_team(conn, team_id)
        require_team_admin(user, team_id)
        group = _load_group(conn, team_id, group_id, str(payload.get("kind") or ""))
        kind = str(group["kind"])
        name = (
            validate_group_name(payload["name"])
            if "name" in payload and payload.get("name") is not None
            else str(group["name"])
        )
        color = validate_group_color(
            payload.get("color"), str(group.get("color") or DEFAULT_GROUP_COLOR)
        )
        ensure_unique_name(conn, team_id, kind, name, exclude_id=group_id)
        conn.execute(
            "UPDATE team_groups SET name=?, color=?, updated_at=? WHERE id=?",
            (name, color, now_iso(), group_id),
        )
        updated = get_group(conn, team_id, group_id, kind)
        audit(conn, user, "group.update", "team_group", group_id, {"name": name})
    return ok({"group": group_payload(updated or {})})


@router.delete("/{group_id}")
def delete_group(
    team_id: str,
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_team(conn, team_id)
        require_team_admin(user, team_id)
        group = _load_group(conn, team_id, group_id)
        conn.execute(
            "UPDATE member_tasks SET group_id='' WHERE group_id=? AND team_id=?",
            (group_id, team_id),
        )
        conn.execute(
            "UPDATE members SET group_id='' WHERE group_id=? AND team_id=?",
            (group_id, team_id),
        )
        conn.execute("DELETE FROM team_groups WHERE id=?", (group_id,))
        audit(
            conn,
            user,
            "group.delete",
            "team_group",
            group_id,
            {"name": group["name"]},
        )
    return ok({"deleted": True})
