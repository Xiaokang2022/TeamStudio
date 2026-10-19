"""Group board routes: monthly red/black board, links, responsibility matrix, announcements.

Base path: ``/api/teams/{team_id}/groups/{group_id}``.

All GET routes honour the guest read gate; every mutation requires an in-scope admin
(``user.ensure_group(team_id, group_id)``) and writes an audit entry.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Depends, Query

from ..auth import CurrentUser, get_current_user
from ..config import settings_service
from ..db import db, new_id, now_iso, row, rows, scalar
from ..http import fail, get_group, get_member, int_value, ok, parse_month, text
from ..permissions import audit, require_admin, require_read_access
from ..scope import resolve_scope

router = APIRouter(prefix="/api/teams/{team_id}/groups/{group_id}", tags=["boards"])

HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
ANNOUNCEMENT_LEVELS = {"info", "important", "celebration"}
MAX_PINNED_HARD_CAP = 3


def _in_clause(group_ids: list[str]) -> str:
    """SQL ``IN`` placeholder list; an empty scope matches nothing."""
    return ",".join("?" for _ in group_ids) if group_ids else "NULL"


# --------------------------------------------------------------------------- shared helpers


def _flag(value: Any, field: str, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    raise fail(422, f"{field}必须是布尔值", "validation_error")


def _hex_color(value: Any, field: str = "颜色", fallback: str = "#5865f2") -> str:
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not HEX_PATTERN.fullmatch(value):
        raise fail(422, f"{field}必须是 #RRGGBB 格式", "validation_error")
    return value.lower()


def _optional_id(value: Any, field: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise fail(422, f"{field} ID 必须是字符串", "validation_error")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > 80:
        raise fail(422, f"{field} ID 过长", "validation_error")
    return cleaned


def _member_ref(conn, group_id: str, value: Any, field: str) -> str | None:
    member_id = _optional_id(value, field)
    if member_id is None:
        return None
    get_member(conn, member_id, group_id)
    return member_id


# --------------------------------------------------------------------------- red / black board


def _entry_payload(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "side": entry["side"],
        "memberId": entry.get("member_id"),
        "memberName": entry.get("member_name", ""),
        "title": entry["title"],
        "reason": entry.get("reason", ""),
        "score": float(entry.get("score") or 0),
        "createdAt": entry.get("created_at", ""),
    }


def _board_payload(conn, board: dict[str, Any]) -> dict[str, Any]:
    entries = rows(
        conn,
        "SELECT * FROM redblack_entries WHERE board_id=? ORDER BY side, sort_order, created_at",
        (board["id"],),
    )
    return {
        "id": board["id"],
        "groupId": board.get("group_id", ""),
        "month": board["month"],
        "theme": board.get("theme", ""),
        "updatedAt": board.get("updated_at", ""),
        "red": [_entry_payload(entry) for entry in entries if entry["side"] == "red"],
        "black": [_entry_payload(entry) for entry in entries if entry["side"] == "black"],
    }


def _empty_board(month: str) -> dict[str, Any]:
    return {
        "id": None,
        "month": month,
        "theme": "",
        "updatedAt": None,
        "red": [],
        "black": [],
        "exists": False,
    }


def _available_months(conn, group_id: str, selected: str) -> list[str]:
    months = {
        item["month"]
        for item in rows(
            conn, "SELECT DISTINCT month FROM redblack_boards WHERE group_id=?", (group_id,)
        )
    }
    months.add(selected)
    return sorted(months, reverse=True)


def _next_month(month: str) -> str:
    year, month_number = (int(part) for part in month.split("-"))
    month_number += 1
    if month_number > 12:
        year += 1
        month_number = 1
    return f"{year:04d}-{month_number:02d}"


def _score(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, bool):
        raise fail(422, "评分必须是 0-100 的数字", "validation_error")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise fail(422, "评分必须是 0-100 的数字", "validation_error") from exc
    if parsed < 0 or parsed > 100:
        raise fail(422, "评分必须在 0-100 之间", "validation_error")
    return round(parsed, 1)


def _entry_inputs(conn, group_id: str, value: Any, side: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise fail(422, "红黑榜条目必须是数组", "validation_error")
    if len(value) > 50:
        raise fail(422, "单侧榜单最多 50 条", "validation_error")
    label = "红" if side == "red" else "黑"
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise fail(422, "红黑榜条目格式不正确", "validation_error")
        member_id = _optional_id(item.get("memberId"), "成员")
        member_name = text(item.get("memberName"), "成员姓名", 60)
        if member_id:
            member = get_member(conn, member_id, group_id)
            member_name = member_name or member["name"]
        if not member_name:
            raise fail(422, "红黑榜条目需要填写成员", "validation_error")
        result.append(
            {
                "member_id": member_id,
                "member_name": member_name,
                "title": text(item.get("title"), f"{label}榜标题", 160, required=True),
                "reason": text(item.get("reason"), "上榜理由", 1000),
                "score": _score(item.get("score")),
            }
        )
    return result


@router.get("/redblack")
def get_redblack(
    team_id: str,
    group_id: str,
    month: str | None = Query(default=None),
    user: CurrentUser = Depends(require_read_access),
):
    selected = parse_month(month)
    with db() as conn:
        get_group(conn, team_id, group_id)
        board = row(
            conn,
            "SELECT * FROM redblack_boards WHERE group_id=? AND month=?",
            (group_id, selected),
        )
        available = _available_months(conn, group_id, selected)
        # ``null`` board lets the frontend show its dedicated empty state.
        payload = _board_payload(conn, board) if board else None
    return ok({"month": selected, "board": payload, "availableMonths": available})


@router.put("/redblack")
def upsert_redblack(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        require_admin(user, team_id, group_id)

        selected = parse_month(payload.get("month"))
        theme = text(payload.get("theme"), "月度主题", 120)
        red_entries = _entry_inputs(conn, group_id, payload.get("red"), "red")
        black_entries = _entry_inputs(conn, group_id, payload.get("black"), "black")

        now = now_iso()
        existing = row(
            conn,
            "SELECT * FROM redblack_boards WHERE group_id=? AND month=?",
            (group_id, selected),
        )
        if existing:
            board_id = existing["id"]
            conn.execute(
                "UPDATE redblack_boards SET theme=?, updated_at=? WHERE id=?",
                (theme, now, board_id),
            )
        else:
            board_id = new_id("board")
            conn.execute(
                "INSERT INTO redblack_boards (id,group_id,month,theme,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (board_id, group_id, selected, theme, now, now),
            )
        # Full replacement keeps PUT idempotent inside one transaction.
        conn.execute("DELETE FROM redblack_entries WHERE board_id=?", (board_id,))
        for side, entries in (("red", red_entries), ("black", black_entries)):
            for index, entry in enumerate(entries):
                conn.execute(
                    "INSERT INTO redblack_entries (id,board_id,side,member_id,member_name,title,"
                    "reason,score,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        new_id("entry"),
                        board_id,
                        side,
                        entry["member_id"],
                        entry["member_name"],
                        entry["title"],
                        entry["reason"],
                        entry["score"],
                        index,
                        now,
                    ),
                )
        audit(
            conn,
            user,
            "redblack.update",
            "redblack_board",
            board_id,
            {"month": selected, "red": len(red_entries), "black": len(black_entries)},
        )
        board = _board_payload(
            conn, row(conn, "SELECT * FROM redblack_boards WHERE id=?", (board_id,))
        )
        available = _available_months(conn, group_id, selected)
    return ok({"month": selected, "board": board, "availableMonths": available})


@router.post("/redblack/rollover")
def rollover_redblack(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] | None = Body(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    payload = payload or {}
    with db() as conn:
        get_group(conn, team_id, group_id)
        require_admin(user, team_id, group_id)

        source_month = parse_month(payload.get("fromMonth") or payload.get("month"))
        target_month = (
            parse_month(payload.get("toMonth"))
            if payload.get("toMonth")
            else _next_month(source_month)
        )
        target = row(
            conn,
            "SELECT * FROM redblack_boards WHERE group_id=? AND month=?",
            (group_id, target_month),
        )
        created = False
        if target is None:
            source = row(
                conn,
                "SELECT * FROM redblack_boards WHERE group_id=? AND month=?",
                (group_id, source_month),
            )
            theme = ""
            if source and settings_service.get().redblack.monthlyThemeEnabled:
                theme = source.get("theme", "")
            now = now_iso()
            board_id = new_id("board")
            conn.execute(
                "INSERT INTO redblack_boards (id,group_id,month,theme,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (board_id, group_id, target_month, theme, now, now),
            )
            audit(
                conn,
                user,
                "redblack.rollover",
                "redblack_board",
                board_id,
                {"from": source_month, "to": target_month},
            )
            target = row(conn, "SELECT * FROM redblack_boards WHERE id=?", (board_id,))
            created = True
        board = _board_payload(conn, target)
        available = _available_months(conn, group_id, target_month)
    return ok(
        {
            "month": target_month,
            "sourceMonth": source_month,
            "created": created,
            "board": board,
            "availableMonths": available,
        }
    )


# --------------------------------------------------------------------------- links board


def _link_payload(link: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": link["id"],
        "groupId": link.get("group_id", ""),
        "groupName": link.get("group_name", ""),
        "teamId": link.get("group_team_id", ""),
        "teamName": link.get("team_name", ""),
        "title": link["title"],
        "url": link["url"],
        "description": link.get("description", ""),
        "category": link.get("category", ""),
        "color": link.get("color", "#5865f2"),
        "sortOrder": int(link.get("sort_order") or 0),
    }


def _validate_url(value: Any) -> str:
    url = text(value, "链接地址", 500, required=True)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise fail(422, "链接地址必须是完整的 http(s) 地址", "validation_error")
    return url


def _get_link(conn, link_id: str, group_id: str) -> dict[str, Any]:
    found = row(
        conn,
        "SELECT l.*, g.name AS group_name, g.team_id AS group_team_id, "
        "tm.name AS team_name FROM links l "
        "JOIN groups g ON g.id=l.group_id JOIN teams tm ON tm.id=g.team_id "
        "WHERE l.id=? AND l.group_id=?",
        (link_id, group_id),
    )
    if not found:
        raise fail(404, "链接不存在", "link_not_found")
    return found


def _next_sort_order(conn, table: str, group_id: str) -> int:
    if table not in {"links", "matrix_areas"}:
        raise ValueError(f"unsupported table: {table}")
    return int(
        scalar(
            conn,
            f"SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {table} WHERE group_id=?",
            (group_id,),
            default=0,
        )
        or 0
    )


@router.get("/links")
def list_links(
    team_id: str,
    group_id: str,
    scope: str = Query(default="group"),
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        ctx = resolve_scope(conn, team_id, group_id, scope)
        group_ids = ctx["groupIds"]
        placeholders = _in_clause(group_ids)
        items = rows(
            conn,
            "SELECT l.*, g.name AS group_name, g.team_id AS group_team_id, "
            "tm.name AS team_name FROM links l "
            "JOIN groups g ON g.id=l.group_id JOIN teams tm ON tm.id=g.team_id "
            f"WHERE l.group_id IN ({placeholders}) "
            "ORDER BY g.sort_order, g.name, l.sort_order, l.created_at",
            tuple(group_ids),
        )
    return ok(
        {"links": [_link_payload(link) for link in items], "scope": ctx}
    )


@router.post("/links")
def create_link(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        require_admin(user, team_id, group_id)
        link_id = new_id("link")
        now = now_iso()
        sort_order = (
            int_value(payload.get("sortOrder"), "排序", 0, 100_000)
            if payload.get("sortOrder") is not None
            else _next_sort_order(conn, "links", group_id)
        )
        conn.execute(
            "INSERT INTO links (id,group_id,title,url,description,category,color,sort_order,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                link_id,
                group_id,
                text(payload.get("title"), "链接标题", 80, required=True),
                _validate_url(payload.get("url")),
                text(payload.get("description"), "链接描述", 500),
                text(payload.get("category"), "分类", 40) or "常用",
                _hex_color(payload.get("color")),
                sort_order,
                now,
                now,
            ),
        )
        audit(conn, user, "link.create", "link", link_id)
        link = _link_payload(_get_link(conn, link_id, group_id))
    return ok({"link": link})


@router.patch("/links/{link_id}")
def update_link(
    team_id: str,
    group_id: str,
    link_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        _get_link(conn, link_id, group_id)
        require_admin(user, team_id, group_id)

        updates: dict[str, Any] = {}
        if "title" in payload:
            updates["title"] = text(payload.get("title"), "链接标题", 80, required=True)
        if "url" in payload:
            updates["url"] = _validate_url(payload.get("url"))
        if "description" in payload:
            updates["description"] = text(payload.get("description"), "链接描述", 500)
        if "category" in payload:
            updates["category"] = text(payload.get("category"), "分类", 40) or "常用"
        if "color" in payload:
            updates["color"] = _hex_color(payload.get("color"))
        if "sortOrder" in payload:
            updates["sort_order"] = int_value(payload.get("sortOrder"), "排序", 0, 100_000)
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE links SET {assignments} WHERE id=? AND group_id=?",
                (*updates.values(), link_id, group_id),
            )
            audit(conn, user, "link.update", "link", link_id, {"fields": sorted(payload)})
        link = _link_payload(_get_link(conn, link_id, group_id))
    return ok({"link": link})


@router.delete("/links/{link_id}")
def delete_link(
    team_id: str,
    group_id: str,
    link_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        link = _get_link(conn, link_id, group_id)
        require_admin(user, team_id, group_id)
        conn.execute("DELETE FROM links WHERE id=? AND group_id=?", (link_id, group_id))
        audit(conn, user, "link.delete", "link", link_id, {"title": link["title"]})
    return ok({"deleted": True, "id": link_id})


# --------------------------------------------------------------------------- responsibility matrix

_MATRIX_SELECT = (
    "SELECT a.id, a.group_id, a.area, a.description, a.owner_member_id, o.name AS owner_name, "
    "o.avatar_color AS owner_color, a.backup_member_id, b.name AS backup_name, "
    "b.avatar_color AS backup_color, a.channel, a.contact, a.sort_order, "
    "g.name AS group_name, g.team_id AS group_team_id, tm.name AS team_name "
    "FROM matrix_areas a LEFT JOIN members o ON o.id=a.owner_member_id "
    "LEFT JOIN members b ON b.id=a.backup_member_id "
    "JOIN groups g ON g.id=a.group_id JOIN teams tm ON tm.id=g.team_id "
)


def _area_payload(area: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": area["id"],
        "groupId": area.get("group_id", ""),
        "groupName": area.get("group_name", ""),
        "teamId": area.get("group_team_id", ""),
        "teamName": area.get("team_name", ""),
        "area": area["area"],
        "description": area.get("description", ""),
        "ownerMemberId": area.get("owner_member_id"),
        "ownerName": area.get("owner_name") or "",
        "ownerColor": area.get("owner_color") or "",
        "backupMemberId": area.get("backup_member_id"),
        "backupName": area.get("backup_name") or "",
        "backupColor": area.get("backup_color") or "",
        "channel": area.get("channel", ""),
        "contact": area.get("contact", ""),
        "sortOrder": int(area.get("sort_order") or 0),
    }


def _get_area_detail(conn, area_id: str, group_id: str) -> dict[str, Any]:
    found = row(conn, _MATRIX_SELECT + "WHERE a.id=? AND a.group_id=?", (area_id, group_id))
    if not found:
        raise fail(404, "职责分工不存在", "matrix_not_found")
    return found


@router.get("/matrix")
def list_matrix(
    team_id: str,
    group_id: str,
    scope: str = Query(default="group"),
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        ctx = resolve_scope(conn, team_id, group_id, scope)
        group_ids = ctx["groupIds"]
        items = rows(
            conn,
            _MATRIX_SELECT
            + f"WHERE a.group_id IN ({_in_clause(group_ids)}) "
            "ORDER BY g.sort_order, g.name, a.sort_order, a.created_at",
            tuple(group_ids),
        )
    return ok({"areas": [_area_payload(area) for area in items], "scope": ctx})


@router.post("/matrix")
def create_matrix_area(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        require_admin(user, team_id, group_id)
        area_id = new_id("matrix")
        now = now_iso()
        sort_order = (
            int_value(payload.get("sortOrder"), "排序", 0, 100_000)
            if payload.get("sortOrder") is not None
            else _next_sort_order(conn, "matrix_areas", group_id)
        )
        conn.execute(
            "INSERT INTO matrix_areas (id,group_id,area,description,owner_member_id,"
            "backup_member_id,channel,contact,sort_order,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                area_id,
                group_id,
                text(payload.get("area"), "职责领域", 80, required=True),
                text(payload.get("description"), "职责说明", 500),
                _member_ref(conn, group_id, payload.get("ownerMemberId"), "负责人"),
                _member_ref(conn, group_id, payload.get("backupMemberId"), "备份人"),
                text(payload.get("channel"), "沟通渠道", 40) or "企业微信",
                text(payload.get("contact"), "联系方式", 120),
                sort_order,
                now,
                now,
            ),
        )
        audit(conn, user, "matrix.create", "matrix_area", area_id)
        area = _area_payload(_get_area_detail(conn, area_id, group_id))
    return ok({"area": area})


@router.patch("/matrix/{area_id}")
def update_matrix_area(
    team_id: str,
    group_id: str,
    area_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        _get_area_detail(conn, area_id, group_id)
        require_admin(user, team_id, group_id)

        updates: dict[str, Any] = {}
        if "area" in payload:
            updates["area"] = text(payload.get("area"), "职责领域", 80, required=True)
        if "description" in payload:
            updates["description"] = text(payload.get("description"), "职责说明", 500)
        if "ownerMemberId" in payload:
            updates["owner_member_id"] = _member_ref(
                conn, group_id, payload.get("ownerMemberId"), "负责人"
            )
        if "backupMemberId" in payload:
            updates["backup_member_id"] = _member_ref(
                conn, group_id, payload.get("backupMemberId"), "备份人"
            )
        if "channel" in payload:
            updates["channel"] = text(payload.get("channel"), "沟通渠道", 40) or "企业微信"
        if "contact" in payload:
            updates["contact"] = text(payload.get("contact"), "联系方式", 120)
        if "sortOrder" in payload:
            updates["sort_order"] = int_value(payload.get("sortOrder"), "排序", 0, 100_000)
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE matrix_areas SET {assignments} WHERE id=? AND group_id=?",
                (*updates.values(), area_id, group_id),
            )
            audit(conn, user, "matrix.update", "matrix_area", area_id, {"fields": sorted(payload)})
        area = _area_payload(_get_area_detail(conn, area_id, group_id))
    return ok({"area": area})


@router.delete("/matrix/{area_id}")
def delete_matrix_area(
    team_id: str,
    group_id: str,
    area_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        area = _get_area_detail(conn, area_id, group_id)
        require_admin(user, team_id, group_id)
        conn.execute("DELETE FROM matrix_areas WHERE id=? AND group_id=?", (area_id, group_id))
        audit(conn, user, "matrix.delete", "matrix_area", area_id, {"area": area["area"]})
    return ok({"deleted": True, "id": area_id})


# --------------------------------------------------------------------------- announcements


def _pinned_cap() -> int:
    configured = int(settings_service.get().announcements.maxPinned)
    return max(0, min(configured, MAX_PINNED_HARD_CAP))


def _ensure_pinned_slot(conn, group_id: str, exclude_id: str = "") -> None:
    cap = _pinned_cap()
    # Serialize the count-check + insert so concurrent pins cannot break the cap.
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    used = int(
        scalar(
            conn,
            "SELECT COUNT(*) FROM announcements WHERE group_id=? AND pinned=1 AND id<>?",
            (group_id, exclude_id),
            default=0,
        )
        or 0
    )
    if used >= cap:
        raise fail(
            409,
            f"置顶公告最多 {cap} 条，请先取消其他置顶。",
            "pinned_limit_reached",
            {"maxPinned": cap, "pinned": used},
        )


def _announcement_payload(announcement: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": announcement["id"],
        "groupId": announcement.get("group_id", ""),
        "groupName": announcement.get("group_name", ""),
        "teamId": announcement.get("group_team_id", ""),
        "teamName": announcement.get("team_name", ""),
        "title": announcement["title"],
        "content": announcement.get("content", ""),
        "pinned": bool(announcement.get("pinned")),
        "level": announcement.get("level", "info"),
        "authorName": announcement.get("author_name", ""),
        "createdAt": announcement.get("created_at", ""),
        "updatedAt": announcement.get("updated_at", ""),
    }


def _validate_level(value: Any, default: str = "info") -> str:
    if value is None or value == "":
        return default
    if value not in ANNOUNCEMENT_LEVELS:
        raise fail(422, "公告级别必须是 info/important/celebration", "validation_error")
    return value


def _get_announcement(conn, announcement_id: str, group_id: str) -> dict[str, Any]:
    found = row(
        conn,
        "SELECT a.*, g.name AS group_name, g.team_id AS group_team_id, "
        "tm.name AS team_name FROM announcements a "
        "JOIN groups g ON g.id=a.group_id JOIN teams tm ON tm.id=g.team_id "
        "WHERE a.id=? AND a.group_id=?",
        (announcement_id, group_id),
    )
    if not found:
        raise fail(404, "公告不存在", "announcement_not_found")
    return found


@router.get("/announcements")
def list_announcements(
    team_id: str,
    group_id: str,
    scope: str = Query(default="group"),
    user: CurrentUser = Depends(require_read_access),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        ctx = resolve_scope(conn, team_id, group_id, scope)
        group_ids = ctx["groupIds"]
        items = rows(
            conn,
            "SELECT a.*, g.name AS group_name, g.team_id AS group_team_id, "
            "tm.name AS team_name FROM announcements a "
            "JOIN groups g ON g.id=a.group_id JOIN teams tm ON tm.id=g.team_id "
            f"WHERE a.group_id IN ({_in_clause(group_ids)}) "
            "ORDER BY a.pinned DESC, g.sort_order, g.name, a.created_at DESC",
            tuple(group_ids),
        )
    pinned_count = sum(1 for item in items if item.get("pinned"))
    return ok(
        {
            "announcements": [_announcement_payload(item) for item in items],
            "maxPinned": _pinned_cap(),
            "pinnedCount": pinned_count,
            "scope": ctx,
        }
    )


@router.post("/announcements")
def create_announcement(
    team_id: str,
    group_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        require_admin(user, team_id, group_id)

        pinned = _flag(payload.get("pinned"), "置顶", False)
        if pinned:
            _ensure_pinned_slot(conn, group_id)
        announcement_id = new_id("ann")
        now = now_iso()
        conn.execute(
            "INSERT INTO announcements (id,group_id,title,content,pinned,level,author_name,"
            "created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                announcement_id,
                group_id,
                text(payload.get("title"), "公告标题", 120, required=True),
                text(payload.get("content"), "公告内容", 8000),
                1 if pinned else 0,
                _validate_level(payload.get("level")),
                text(payload.get("authorName"), "作者", 60) or user.name or "Admin",
                user.id,
                now,
                now,
            ),
        )
        audit(
            conn,
            user,
            "announcement.create",
            "announcement",
            announcement_id,
            {"pinned": pinned},
        )
        announcement = _announcement_payload(_get_announcement(conn, announcement_id, group_id))
    return ok({"announcement": announcement})


@router.patch("/announcements/{announcement_id}")
def update_announcement(
    team_id: str,
    group_id: str,
    announcement_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        _get_announcement(conn, announcement_id, group_id)
        require_admin(user, team_id, group_id)

        updates: dict[str, Any] = {}
        if "title" in payload:
            updates["title"] = text(payload.get("title"), "公告标题", 120, required=True)
        if "content" in payload:
            updates["content"] = text(payload.get("content"), "公告内容", 8000)
        if "level" in payload:
            updates["level"] = _validate_level(payload.get("level"))
        if "authorName" in payload:
            updates["author_name"] = (
                text(payload.get("authorName"), "作者", 60) or user.name or "Admin"
            )
        if "pinned" in payload:
            pinned = _flag(payload.get("pinned"), "置顶", False)
            if pinned:
                # Exclude the row being patched from the pinned count.
                _ensure_pinned_slot(conn, group_id, announcement_id)
            updates["pinned"] = 1 if pinned else 0
        if updates:
            updates["updated_at"] = now_iso()
            assignments = ", ".join(f"{column}=?" for column in updates)
            conn.execute(
                f"UPDATE announcements SET {assignments} WHERE id=? AND group_id=?",
                (*updates.values(), announcement_id, group_id),
            )
            audit(
                conn,
                user,
                "announcement.update",
                "announcement",
                announcement_id,
                {"fields": sorted(payload)},
            )
        announcement = _announcement_payload(
            _get_announcement(conn, announcement_id, group_id)
        )
    return ok({"announcement": announcement})


@router.delete("/announcements/{announcement_id}")
def delete_announcement(
    team_id: str,
    group_id: str,
    announcement_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    with db() as conn:
        get_group(conn, team_id, group_id)
        announcement = _get_announcement(conn, announcement_id, group_id)
        require_admin(user, team_id, group_id)
        conn.execute(
            "DELETE FROM announcements WHERE id=? AND group_id=?", (announcement_id, group_id)
        )
        audit(
            conn,
            user,
            "announcement.delete",
            "announcement",
            announcement_id,
            {"title": announcement["title"]},
        )
    return ok({"deleted": True, "id": announcement_id})
