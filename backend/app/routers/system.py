"""Whole-system factory reset (deployment device only).

The reset operation is deliberately restricted to the built-in ``Admin`` identity of the
deployment device (``user.is_device_admin``). A stored ``super`` account is rejected with
``403 device_admin_required`` even though it is a super administrator: wiping an entire
deployment is a physical-operator action, and the non-stored device Admin identity is the
guaranteed recovery path afterwards (it can rebuild a team through
``POST /api/workspace/teams``).

``POST /api/system/reset`` empties every business/account/log table, restores
``DEFAULT_SETTINGS``, removes uploaded files and rotates the session signing secret. The
``factoryResetAt`` marker written to ``app_meta`` keeps
:func:`backend.app.seed.seed_if_empty` from refilling demo data on the next restart, so a
reset system stays intentionally empty until the operator creates new teams.

Response envelope is always ``{"ok": true, "data": ...}``.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, Response

from ..auth import (
    CurrentUser,
    clear_session_cookie,
    get_current_user,
    rotate_session_secret,
)
from ..config import DEFAULT_SETTINGS, UPLOAD_DIR, settings_service
from ..db import db, get_meta, log_audit, now_iso, scalar, set_meta
from ..http import fail, ok

router = APIRouter(prefix="/api/system", tags=["system"])

RESET_AT_KEY = "factoryResetAt"
RESET_BY_KEY = "factoryResetBy"

DEVICE_ADMIN_MESSAGE = "仅系统内置的 Admin 可执行系统重置"
ACKNOWLEDGE_MESSAGE = "重置操作需要显式确认"
CONFIRM_MISMATCH_MESSAGE = "站点名称不匹配，无法重置系统"

# Public stat keys -> SQLite table, in the fixed order the API contract documents.
_STAT_TABLES: tuple[tuple[str, str], ...] = (
    ("teams", "teams"),
    ("groups", "groups"),
    ("members", "members"),
    ("works", "works"),
    ("todos", "todos"),
    ("tasks", "member_tasks"),
    ("boards", "redblack_boards"),
    ("entries", "redblack_entries"),
    ("links", "links"),
    ("matrix", "matrix_areas"),
    ("announcements", "announcements"),
    ("tags", "task_tags"),
    ("accounts", "users"),
    ("emailCodes", "email_codes"),
    ("activationTokens", "user_activation_tokens"),
    ("emailLogs", "email_logs"),
    ("auditLogs", "audit_logs"),
)

# Foreign-key-safe deletion order (children before parents); ``app_meta`` is cleared too.
_WIPE_TABLES: tuple[str, ...] = (
    "redblack_entries",
    "redblack_boards",
    "member_tasks",
    "todos",
    "works",
    "task_tags",
    "announcements",
    "matrix_areas",
    "links",
    "members",
    "groups",
    "teams",
    "user_activation_tokens",
    "email_codes",
    "email_logs",
    "audit_logs",
    "users",
)


def _require_device_admin(user: CurrentUser) -> None:
    if not user.is_device_admin:
        raise fail(403, DEVICE_ADMIN_MESSAGE, "device_admin_required")


def _stat_counts(conn: sqlite3.Connection) -> dict[str, int]:
    """Row counts shared by the reset preview (GET) and the wipe itself (POST)."""
    return {
        key: int(scalar(conn, f"SELECT COUNT(*) FROM {table}", default=0) or 0)
        for key, table in _STAT_TABLES
    }


def _upload_files() -> list[Path]:
    """Every regular file currently below ``UPLOAD_DIR`` (hidden files included)."""
    if not UPLOAD_DIR.is_dir():
        return []
    found: list[Path] = []
    for root, _dirs, names in os.walk(UPLOAD_DIR):
        for name in names:
            candidate = Path(root) / name
            try:
                if candidate.is_file() and not candidate.is_symlink():
                    found.append(candidate)
            except OSError:  # pragma: no cover - unreadable entry, best effort
                continue
    return found


def _clear_upload_dir() -> int:
    """Delete every file/directory below ``UPLOAD_DIR``, keeping the directory itself.

    Best effort only: an ``OSError`` on one entry never aborts the reset. Returns the
    number of removed regular files.
    """
    removed = 0
    if not UPLOAD_DIR.is_dir():
        return removed
    for root, dirs, names in os.walk(UPLOAD_DIR, topdown=False):
        for name in names:
            candidate = Path(root) / name
            try:
                if candidate.is_symlink():
                    candidate.unlink()
                elif candidate.is_file():
                    candidate.unlink()
                    removed += 1
            except OSError:
                continue
        for name in dirs:
            candidate = Path(root) / name
            try:
                if candidate.is_symlink():
                    candidate.unlink()
                else:
                    candidate.rmdir()
            except OSError:
                continue
    return removed


def _reset_preview(conn: sqlite3.Connection) -> dict[str, Any]:
    cfg = settings_service.get()
    last_reset_at = get_meta(conn, RESET_AT_KEY)
    last_reset_by = get_meta(conn, RESET_BY_KEY, "")
    return {
        "deviceAdmin": True,
        "canReset": True,
        "siteName": cfg.site.name,
        "siteShortName": cfg.site.shortName,
        "defaultSiteName": DEFAULT_SETTINGS.site.name,
        "defaultSiteShortName": DEFAULT_SETTINGS.site.shortName,
        "stats": _stat_counts(conn),
        "lastResetAt": str(last_reset_at) if last_reset_at else None,
        "lastResetBy": str(last_reset_by or ""),
    }


@router.get("/reset")
def get_reset_preview(user: CurrentUser = Depends(get_current_user)):
    _require_device_admin(user)
    with db() as conn:
        return ok(_reset_preview(conn))


@router.post("/reset")
def reset_system(
    response: Response,
    payload: dict[str, Any] | None = Body(default=None),
    user: CurrentUser = Depends(get_current_user),
):
    _require_device_admin(user)

    body = payload or {}
    if body.get("acknowledge") is not True:
        raise fail(422, ACKNOWLEDGE_MESSAGE, "acknowledge_required")

    expected_name = settings_service.get().site.name
    submitted = body.get("confirmName")
    submitted_name = submitted.strip() if isinstance(submitted, str) else ""
    if submitted_name != expected_name:
        raise fail(
            422,
            CONFIRM_MISMATCH_MESSAGE,
            "confirm_mismatch",
            {"expected": expected_name},
        )

    reset_at = now_iso()
    actor = user.name or "Admin"
    # Count the uploaded files before the wipe so the single audit record can report how
    # many files this destructive action removes; the best-effort deletion itself happens
    # after the settings reset below (single reset at a time, so the numbers agree).
    pending_files = len(_upload_files())

    with db() as conn:
        cleared = _stat_counts(conn)
        for table in _WIPE_TABLES:
            conn.execute(f"DELETE FROM {table}")
        conn.execute("DELETE FROM app_meta")
        set_meta(conn, RESET_AT_KEY, reset_at)
        set_meta(conn, RESET_BY_KEY, actor)
        log_audit(
            conn,
            actor,
            "system.factory_reset",
            "system",
            "",
            {
                "siteName": expected_name,
                "cleared": cleared,
                "removedFiles": pending_files,
            },
        )

    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
    removed_files = _clear_upload_dir()
    rotated = rotate_session_secret()
    clear_session_cookie(response)

    return ok(
        {
            "reset": True,
            "resetAt": reset_at,
            "sessionSecretRotated": rotated,
            "uploadsRemoved": removed_files,
            "cleared": cleared,
            "siteName": DEFAULT_SETTINGS.site.name,
            "siteShortName": DEFAULT_SETTINGS.site.shortName,
        }
    )
