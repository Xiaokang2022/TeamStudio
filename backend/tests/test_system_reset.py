"""Device-Admin-only whole-system factory reset (round 8: no groups in the stats)."""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from backend.app.config import DEFAULT_SETTINGS, UPLOAD_DIR, settings_service
from backend.app.db import DB_PATH, db, get_meta, rows, scalar
from backend.app.seed import seed_if_empty, seed_member_tasks_if_empty, seed_users_if_empty
from backend.tests.helpers import (
    data,
    email_login,
    error,
    me,
)

DEVICE_ADMIN_MESSAGE = "仅系统内置的 Admin 可执行系统重置"

REQUIRED_STAT_KEYS = {
    "teams",
    "members",
    "works",
    "todos",
    "tasks",
    "boards",
    "entries",
    "links",
    "matrix",
    "announcements",
    "tags",
    "accounts",
    "emailCodes",
    "activationTokens",
    "emailLogs",
    "auditLogs",
}
BUSINESS_TABLES = (
    "teams",
    "members",
    "works",
    "todos",
    "member_tasks",
    "redblack_boards",
    "redblack_entries",
    "links",
    "matrix_areas",
    "announcements",
    "task_tags",
    "users",
    "email_codes",
    "user_activation_tokens",
    "email_logs",
)


# --------------------------------------------------------------------------- helpers


def _assert_device_admin_required(response) -> None:
    assert response.status_code == 403, response.text
    payload = error(response)
    assert payload["code"] == "device_admin_required"
    assert payload["message"] == DEVICE_ADMIN_MESSAGE


def _assert_stat_shape(stats: dict) -> None:
    assert REQUIRED_STAT_KEYS <= set(stats), set(stats)
    # Round 8 removes the development-group dimension from the stats payload.
    assert "groups" not in stats
    assert all(isinstance(value, int) for value in stats.values())


def _assert_everything_empty() -> None:
    with db() as conn:
        counts = {
            table: int(scalar(conn, f"SELECT COUNT(*) FROM {table}", default=0) or 0)
            for table in BUSINESS_TABLES
        }
    assert counts == {table: 0 for table in BUSINESS_TABLES}


# --------------------------------------------------------------------------- device Admin only


def test_default_site_settings_are_rebranded():
    assert DEFAULT_SETTINGS.site.name == "团队工作室"
    assert DEFAULT_SETTINGS.site.shortName == "TeamStudio"


def test_reset_preview_and_device_admin_only(client, monkeypatch):
    site_name = settings_service.get().site.name

    preview = data(client.get("/api/system/reset"))
    assert preview["deviceAdmin"] is True
    assert preview["canReset"] is True
    assert preview["siteName"] == site_name
    assert preview["defaultSiteName"] == DEFAULT_SETTINGS.site.name
    assert preview["lastResetAt"] is None
    _assert_stat_shape(preview["stats"])
    assert preview["stats"]["teams"] == 2
    assert preview["stats"]["accounts"] == 18

    # Signing out of the built-in Admin makes the device a plain guest: no reset access.
    assert client.post("/api/auth/logout").status_code == 200
    _assert_device_admin_required(client.get("/api/system/reset"))
    _assert_device_admin_required(
        client.post(
            "/api/system/reset", json={"confirmName": site_name, "acknowledge": True}
        )
    )

    # A stored super account on the deployment device is still not the built-in Admin.
    client.post("/api/auth/device/login")
    data(
        client.post(
            "/api/users",
            json={"email": "device.super.reset@corp.example", "name": "设备上的超管账号", "role": "super"},
        )
    )
    # Sign out of the built-in Admin before using the stored account session.
    client.post("/api/auth/logout")
    email_login(client, "device.super.reset@corp.example", monkeypatch)
    payload = me(client)
    assert payload["isSuperAdmin"] is True
    assert payload["isDeviceAdmin"] is False
    _assert_device_admin_required(client.get("/api/system/reset"))
    _assert_device_admin_required(
        client.post(
            "/api/system/reset", json={"confirmName": site_name, "acknowledge": True}
        )
    )


def test_reset_is_forbidden_off_device(guest_client):
    _assert_device_admin_required(guest_client.get("/api/system/reset"))
    _assert_device_admin_required(
        guest_client.post(
            "/api/system/reset",
            json={"confirmName": DEFAULT_SETTINGS.site.name, "acknowledge": True},
        )
    )


# --------------------------------------------------------------------------- validation


def test_reset_requires_explicit_acknowledgement_and_matching_name(client):
    site_name = settings_service.get().site.name
    with db() as conn:
        teams_before = int(scalar(conn, "SELECT COUNT(*) FROM teams", default=0) or 0)
    assert teams_before == 2

    rejected = client.post(
        "/api/system/reset", json={"confirmName": site_name, "acknowledge": False}
    )
    assert rejected.status_code == 422, rejected.text
    assert error(rejected)["code"] == "acknowledge_required"

    missing = client.post("/api/system/reset", json={"confirmName": site_name})
    assert missing.status_code == 422
    assert error(missing)["code"] == "acknowledge_required"

    mismatch = client.post(
        "/api/system/reset", json={"confirmName": "错误名称", "acknowledge": True}
    )
    assert mismatch.status_code == 422
    payload = error(mismatch)
    assert payload["code"] == "confirm_mismatch"
    assert payload["details"]["expected"] == site_name

    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM teams", default=0) == teams_before
    assert settings_service.get().site.name == site_name
    assert data(client.get("/api/system/reset"))["lastResetAt"] is None


# --------------------------------------------------------------------------- full reset


def test_factory_reset_wipes_data_and_stays_empty(client):
    site_name = "自定义站点名称"

    created = client.post("/api/workspace/teams", json={"name": "临时团队", "shortName": "临时"})
    assert created.status_code == 200, created.text

    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    avatar_dir = UPLOAD_DIR / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    (avatar_dir / "dummy-avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n dummy")

    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["site"]["name"] = site_name
    payload["site"]["shortName"] = "自定义"
    settings_service.save(payload)

    preview = data(client.get("/api/system/reset"))
    pre_stats = preview["stats"]
    _assert_stat_shape(pre_stats)
    assert pre_stats["teams"] == 3
    assert pre_stats["works"] > 0
    assert pre_stats["accounts"] > 0

    response = client.post(
        "/api/system/reset",
        json={"confirmName": "  自定义站点名称  ", "acknowledge": True},
    )
    assert response.status_code == 200, response.text
    reset = data(response)
    assert reset["reset"] is True
    assert datetime.fromisoformat(reset["resetAt"]).tzinfo is not None
    assert reset["sessionSecretRotated"] is False
    assert reset["uploadsRemoved"] == 1
    assert reset["cleared"] == pre_stats
    assert reset["siteName"] == DEFAULT_SETTINGS.site.name

    # The on-disk database must not retain recoverable demo content.
    markers = ("极光产品团队", "林知夏", "corp.example")
    db_bytes = DB_PATH.read_bytes()
    for marker in markers:
        assert marker.encode("utf-8") not in db_bytes, marker
    wal_path = Path(str(DB_PATH) + "-wal")
    if wal_path.exists():
        wal_bytes = wal_path.read_bytes()
        for marker in markers:
            assert marker.encode("utf-8") not in wal_bytes, marker

    # Workspace and bootstrap are empty; the device Admin is the only identity left.
    bootstrap = data(client.get("/api/bootstrap"))
    assert bootstrap["active"]["team"] is None
    assert "group" not in bootstrap["active"]
    assert bootstrap["stats"]["teams"] == 0
    assert bootstrap["stats"]["members"] == 0
    users = data(client.get("/api/users"))["users"]
    assert [user["id"] for user in users] == ["device-admin"]

    settings_payload = data(client.get("/api/settings"))["settings"]
    assert settings_payload["site"]["name"] == DEFAULT_SETTINGS.site.name
    on_disk = json.loads(Path(settings_service.path).read_text(encoding="utf-8"))
    assert on_disk["site"]["name"] == DEFAULT_SETTINGS.site.name

    assert UPLOAD_DIR.is_dir()
    assert [path for path in UPLOAD_DIR.rglob("*") if path.is_file()] == []

    _assert_everything_empty()
    with db() as conn:
        assert get_meta(conn, "factoryResetAt") == reset["resetAt"]
        assert get_meta(conn, "factoryResetBy") == "Admin"
        audit = rows(conn, "SELECT * FROM audit_logs")
    assert len(audit) == 1
    assert audit[0]["action"] == "system.factory_reset"
    assert audit[0]["actor"] == "Admin"
    assert audit[0]["entity"] == "system"
    detail = json.loads(audit[0]["detail"])
    assert detail["siteName"] == site_name
    assert detail["cleared"] == pre_stats

    after = data(client.get("/api/system/reset"))
    assert after["lastResetAt"] == reset["resetAt"]
    assert after["stats"]["auditLogs"] == 1
    assert all(
        value == 0 for key, value in after["stats"].items() if key != "auditLogs"
    )

    # Restart safety: the demo seeder must not refill an intentionally reset deployment.
    assert seed_if_empty() is False
    assert seed_member_tasks_if_empty() == 0
    assert seed_users_if_empty() == 0
    _assert_everything_empty()

    # The built-in device Admin is the recovery path: it can recreate a team.
    recovered = data(
        client.post("/api/workspace/teams", json={"name": "重建团队", "shortName": "重建"})
    )["team"]
    recovered_bootstrap = data(client.get("/api/bootstrap"))
    assert recovered_bootstrap["active"]["team"]["id"] == recovered["id"]
    assert recovered_bootstrap["stats"]["teams"] == 1
