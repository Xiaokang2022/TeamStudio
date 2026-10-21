"""Small HTTP helpers shared by routers (round 8: team-scoped lookups)."""

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


def get_team(conn: sqlite3.Connection, team_id: str) -> dict[str, Any]:
    """Load one team or raise 404 ``team_not_found``."""
    found = conn.execute("SELECT * FROM teams WHERE id=?", (team_id,)).fetchone()
    if not found:
        raise fail(404, "团队不存在", "team_not_found")
    return dict(found)


def get_member(conn: sqlite3.Connection, team_id: str, member_id: str) -> dict[str, Any]:
    """Load one member of ``team_id`` or raise 404 ``member_not_found``."""
    found = conn.execute(
        "SELECT * FROM members WHERE id=? AND team_id=?", (member_id, team_id)
    ).fetchone()
    if not found:
        raise fail(404, "成员不存在", "member_not_found")
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
