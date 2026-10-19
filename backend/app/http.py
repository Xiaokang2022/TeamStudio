"""Small HTTP helpers shared by routers."""

from __future__ import annotations

import re
import sqlite3
from datetime import date
from typing import Any

from fastapi import HTTPException

MONTH_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DATE_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def ok(data: Any = None, **extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"ok": True, "data": data}
    result.update(extra)
    return result


def fail(status: int, message: str, code: str = "error", details: Any = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, "details": details})


def get_group(conn: sqlite3.Connection, team_id: str, group_id: str) -> dict[str, Any]:
    found = conn.execute(
        "SELECT g.id, g.team_id, g.name, g.description, g.color, g.icon, g.sort_order, "
        "g.created_at, t.name AS team_name, t.short_name AS team_short_name, t.color AS team_color "
        "FROM groups g JOIN teams t ON t.id=g.team_id WHERE g.id=? AND g.team_id=?",
        (group_id, team_id),
    ).fetchone()
    if not found:
        raise fail(404, "团队或开发组不存在", "group_not_found")
    return dict(found)


def get_member(conn: sqlite3.Connection, member_id: str, group_id: str) -> dict[str, Any]:
    found = conn.execute(
        "SELECT * FROM members WHERE id=? AND group_id=?", (member_id, group_id)
    ).fetchone()
    if not found:
        raise fail(404, "成员不存在或不属于该开发组", "member_not_found")
    return dict(found)


def parse_month(value: str | None) -> str:
    if not value:
        return date.today().strftime("%Y-%m")
    if not MONTH_PATTERN.fullmatch(value):
        raise fail(422, "月份格式应为 YYYY-MM", "invalid_month")
    return value


def parse_date(value: str, field: str = "日期") -> str:
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise fail(422, f"{field}格式应为 YYYY-MM-DD", "invalid_date")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise fail(422, f"{field}不是有效日期", "invalid_date") from exc
    return value


def parse_time(value: str, field: str = "时间") -> str:
    if not isinstance(value, str) or not TIME_PATTERN.fullmatch(value):
        raise fail(422, f"{field}格式应为 HH:MM", "invalid_time")
    return value


def text(value: Any, field: str, max_length: int = 5000, required: bool = False) -> str:
    if value is None:
        if required:
            raise fail(422, f"{field}不能为空", "validation_error")
        return ""
    if not isinstance(value, str):
        raise fail(422, f"{field}必须是字符串", "validation_error")
    value = value.strip()
    if required and not value:
        raise fail(422, f"{field}不能为空", "validation_error")
    if len(value) > max_length:
        raise fail(422, f"{field}不能超过 {max_length} 字", "validation_error")
    return value


def int_value(value: Any, field: str, minimum: int = 0, maximum: int = 1_000_000) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise fail(422, f"{field}必须是整数", "validation_error") from exc
    if parsed < minimum or parsed > maximum:
        raise fail(422, f"{field}需在 {minimum}-{maximum} 之间", "validation_error")
    return parsed
