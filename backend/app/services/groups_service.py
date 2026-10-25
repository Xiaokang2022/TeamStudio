"""Round-9 custom group helpers shared by the team feature routers.

A team can define its own groups for tasks (kind task) and members (kind member);
rows with an empty group_id are simply ungrouped. The helpers keep the payload shape,
validation and next-sort-order logic in one place so tasks, members and the groups
router can never drift apart.
"""

from __future__ import annotations

import re
from typing import Any

from ..db import new_id, now_iso, row, rows, scalar
from ..http import fail, text

GROUP_KINDS: tuple[str, ...] = ("task", "member")
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_GROUP_COLOR = "#5865f2"

_GROUP_SELECT = (
    "SELECT g.*, "
    "(SELECT COUNT(*) FROM member_tasks t WHERE t.group_id = g.id) AS task_count, "
    "(SELECT COUNT(*) FROM members m WHERE m.group_id = g.id) AS member_count "
    "FROM team_groups g "
)


def group_payload(group: dict[str, Any]) -> dict[str, Any]:
    """Serialize one team_groups row (camelCase, usage counts included)."""
    return {
        "id": group["id"],
        "teamId": group.get("team_id", ""),
        "kind": group.get("kind", "task"),
        "name": group.get("name", ""),
        "color": group.get("color") or DEFAULT_GROUP_COLOR,
        "sortOrder": int(group.get("sort_order") or 0),
        "taskCount": int(group.get("task_count") or 0),
        "memberCount": int(group.get("member_count") or 0),
        "createdAt": group.get("created_at", ""),
        "updatedAt": group.get("updated_at", ""),
    }


def list_groups(conn, team_id: str, kind: str | None = None) -> list[dict[str, Any]]:
    """All groups of a team (optionally only one kind), ordered for display."""
    if kind is not None:
        _check_kind(kind)
        return rows(
            conn,
            _GROUP_SELECT + "WHERE g.team_id=? AND g.kind=? "
            "ORDER BY g.sort_order, g.created_at, g.id",
            (team_id, kind),
        )
    return rows(
        conn,
        _GROUP_SELECT
        + "WHERE g.team_id=? ORDER BY g.kind, g.sort_order, g.created_at, g.id",
        (team_id,),
    )


def list_group_payloads(conn, team_id: str, kind: str) -> list[dict[str, Any]]:
    return [group_payload(group) for group in list_groups(conn, team_id, kind)]


def get_group(
    conn, team_id: str, group_id: str, kind: str | None = None
) -> dict[str, Any] | None:
    """One group that belongs to team_id; None when it does not exist."""
    if not group_id:
        return None
    if kind is not None:
        _check_kind(kind)
        return row(
            conn,
            _GROUP_SELECT + "WHERE g.id=? AND g.team_id=? AND g.kind=?",
            (group_id, team_id, kind),
        )
    return row(conn, _GROUP_SELECT + "WHERE g.id=? AND g.team_id=?", (group_id, team_id))


def require_group(conn, team_id: str, group_id: str, kind: str) -> dict[str, Any]:
    found = get_group(conn, team_id, group_id, kind)
    if not found:
        raise fail(404, "分组不存在", "group_not_found")
    return found


def resolve_group_id(conn, team_id: str, value: Any, kind: str) -> str:
    """Validate an incoming groupId value; ""/None means ungrouped."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise fail(422, "分组编号格式不正确", "validation_error")
    group_id = value.strip()
    if not group_id:
        return ""
    require_group(conn, team_id, group_id, kind)
    return group_id


def validate_group_name(value: Any) -> str:
    name = text(value, "分组名称", 30, required=True).strip()
    if not name:
        raise fail(422, "分组名称不能为空", "validation_error")
    return name


def validate_group_color(value: Any, fallback: str = DEFAULT_GROUP_COLOR) -> str:
    if value is None or value == "":
        return fallback
    color = str(value).strip()
    if not _HEX_COLOR.match(color):
        raise fail(422, "分组颜色必须是 #RRGGBB 格式", "validation_error")
    return color


def ensure_unique_name(
    conn, team_id: str, kind: str, name: str, exclude_id: str = ""
) -> None:
    found = row(
        conn,
        "SELECT id FROM team_groups WHERE team_id=? AND kind=? AND name=? AND id<>?",
        (team_id, kind, name, exclude_id),
    )
    if found:
        raise fail(409, "同类型下已存在同名分组", "group_name_conflict")


def next_sort_order(conn, team_id: str, kind: str) -> int:
    return int(
        scalar(
            conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM team_groups "
            "WHERE team_id=? AND kind=?",
            (team_id, kind),
            default=0,
        )
        or 0
    )


def _check_kind(kind: str) -> None:
    if kind not in GROUP_KINDS:
        raise fail(422, "分组类型必须是 task 或 member", "validation_error")
