"""Per-team module settings (round 9).

The site settings (``settings_service.get()``) provide the default module
switches; the ``team_settings`` table stores per-team JSON overrides.  A team
setting is the *stored* value (site default with the team override merged on
top), while the *effective* visibility is

    effective.modules[k]       = site.modules[k] AND stored.modules[k]
    effective.guestModules[k]  = site.guestModules[k]
                                 AND stored.guestModules[k]
                                 AND stored.modules[k]

``settings`` is special: team settings can never switch the settings module off
for logged-in users (stored.modules.settings is forced to ``True``) nor on for
guests (stored.guestModules.settings is forced to ``False``).

Payload shape shared by GET/PUT /api/teams/{team_id}/settings and bootstrap::

    {"settings": {"modules": {..}, "guestModules": {..}},
     "effective": {"modules": {..}, "guestModules": {..}},
     "canEdit": bool,
     "updatedAt": "2026-10-25T12:00:00+00:00" | ""}
"""

from __future__ import annotations

import sqlite3
from typing import Any

from ..config import settings_service
from ..db import json_dumps, json_loads, log_audit, now_iso, row
from ..http import fail

# Contract §2.3 module keys; order matters for stable payloads/tests.
MODULE_KEYS: tuple[str, ...] = (
    "overview",
    "tasks",
    "insights",
    "calendar",
    "redblack",
    "announcements",
    "matrix",
    "links",
    "settings",
)

# The settings module itself is never team-configurable.
FORCED_MODULES: dict[str, bool] = {"settings": True}
FORCED_GUEST_MODULES: dict[str, bool] = {"settings": False}


def _site_modules() -> dict[str, bool]:
    config = settings_service.get()
    return {key: bool(getattr(config.modules, key, False)) for key in MODULE_KEYS}


def _site_guest_modules() -> dict[str, bool]:
    config = settings_service.get()
    return {key: bool(getattr(config.guestModules, key, False)) for key in MODULE_KEYS}


def _default_stored() -> dict[str, dict[str, bool]]:
    """The stored view when a team has no override row yet (site defaults)."""
    modules = _site_modules()
    guest_modules = _site_guest_modules()
    modules.update(FORCED_MODULES)
    guest_modules.update(FORCED_GUEST_MODULES)
    return {"modules": modules, "guestModules": guest_modules}


def _normalise_stored(raw: Any) -> dict[str, dict[str, bool]]:
    """Merge an arbitrary stored JSON blob onto the site defaults."""
    stored = _default_stored()
    if isinstance(raw, dict):
        for group in ("modules", "guestModules"):
            values = raw.get(group)
            if not isinstance(values, dict):
                continue
            for key in MODULE_KEYS:
                value = values.get(key)
                if isinstance(value, bool):
                    stored[group][key] = value
    stored["modules"].update(FORCED_MODULES)
    stored["guestModules"].update(FORCED_GUEST_MODULES)
    return stored


def _record(conn: sqlite3.Connection, team_id: str) -> dict[str, Any] | None:
    return row(conn, "SELECT data, updated_at FROM team_settings WHERE team_id=?", (team_id,))


def get_stored(conn: sqlite3.Connection, team_id: str) -> dict[str, dict[str, bool]]:
    """Stored module switches for one team (site defaults + team overrides)."""
    record = _record(conn, team_id)
    raw = json_loads(record["data"], {}) if record else {}
    return _normalise_stored(raw)


def build_payload(
    conn: sqlite3.Connection,
    team_id: str,
    user: Any | None = None,
) -> dict[str, Any]:
    """Full team settings payload: stored switches, effective visibility, canEdit."""
    stored = get_stored(conn, team_id)
    site_modules = _site_modules()
    site_guest_modules = _site_guest_modules()
    effective = {
        "modules": {
            key: site_modules[key] and stored["modules"][key] for key in MODULE_KEYS
        },
        "guestModules": {
            key: site_guest_modules[key]
            and stored["guestModules"][key]
            and stored["modules"][key]
            for key in MODULE_KEYS
        },
    }
    record = _record(conn, team_id)
    return {
        "settings": stored,
        "effective": effective,
        "canEdit": bool(getattr(user, "can_edit_team", lambda _team: False)(team_id))
        if user is not None
        else False,
        "updatedAt": str(record["updated_at"]) if record else "",
    }


def default_payload(user: Any | None = None) -> dict[str, Any]:
    """Site-default payload used when no active team is resolved (bootstrap)."""
    stored = _default_stored()
    effective = {
        "modules": dict(stored["modules"]),
        "guestModules": dict(stored["guestModules"]),
    }
    return {
        "settings": stored,
        "effective": effective,
        "canEdit": False,
        "updatedAt": "",
    }


def _validate_patch(patch: Any) -> dict[str, dict[str, bool]]:
    if not isinstance(patch, dict):
        raise fail(400, "团队设置格式不正确", "validation_error")
    unknown = sorted(set(patch) - {"modules", "guestModules"})
    if unknown:
        raise fail(400, f"未知的团队设置项：{unknown[0]}", "invalid_settings")
    cleaned: dict[str, dict[str, bool]] = {}
    for group in ("modules", "guestModules"):
        if group not in patch:
            continue
        values = patch[group]
        if not isinstance(values, dict):
            raise fail(400, f"{group} 必须是对象", "invalid_settings")
        items: dict[str, bool] = {}
        for key, value in values.items():
            if key not in MODULE_KEYS:
                raise fail(400, f"未知的模块设置项：{key}", "invalid_settings")
            if not isinstance(value, bool):
                raise fail(400, f"模块开关 {key} 必须是布尔值", "invalid_settings")
            items[key] = value
        cleaned[group] = items
    return cleaned


def save(
    conn: sqlite3.Connection,
    team_id: str,
    patch: Any,
    user: Any | None = None,
) -> dict[str, Any]:
    """Validate and merge a partial settings patch, then return build_payload()."""
    cleaned = _validate_patch(patch)
    record = _record(conn, team_id)
    # Persist only the explicit overrides, never a materialised snapshot of the site
    # defaults: a later site-level change must still flow through to every team that
    # did not override that key.
    overrides = json_loads(record["data"], {}) if record else {}
    if not isinstance(overrides, dict):
        overrides = {}
    for group, values in cleaned.items():
        existing = overrides.get(group)
        if not isinstance(existing, dict):
            existing = {}
        existing.update(values)
        overrides[group] = existing
    payload = json_dumps(overrides)
    stored = get_stored(conn, team_id)
    now = now_iso()
    if record:
        conn.execute(
            "UPDATE team_settings SET data=?, updated_at=? WHERE team_id=?",
            (payload, now, team_id),
        )
    else:
        conn.execute(
            "INSERT INTO team_settings (team_id, data, created_at, updated_at) "
            "VALUES (?,?,?,?)",
            (team_id, payload, now, now),
        )
    if user is not None and settings_service.get().features.auditLog:
        actor = getattr(user, "name", "") or getattr(user, "id", "") or "system"
        log_audit(
            conn,
            actor,
            "team.settings.modules",
            "team_settings",
            team_id,
            {"settings": stored},
        )
    return build_payload(conn, team_id, user)
