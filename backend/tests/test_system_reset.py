"""Tests for the device-Admin-only whole-system factory reset API.

The ``client`` fixture connects through loopback, which makes every request the built-in
deployment-device Admin; ``guest_client`` simulates a remote browser. A stored ``super``
account is created and signed in on the device to prove that only ``is_device_admin``
grants the reset capability.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from backend.app.config import DEFAULT_SETTINGS, UPLOAD_DIR, settings_service
from backend.app.db import DB_PATH, db, get_meta, rows, scalar
from backend.app.routers import auth as auth_router
from backend.app.seed import (
    seed_if_empty,
    seed_member_tasks_if_empty,
    seed_users_if_empty,
)
from backend.app.services import accounts

DEVICE_ADMIN_MESSAGE = "仅系统内置的 Admin 可执行系统重置"
ACKNOWLEDGE_MESSAGE = "重置操作需要显式确认"
CONFIRM_MISMATCH_MESSAGE = "站点名称不匹配，无法重置系统"

STAT_KEYS = [
    "teams",
    "groups",
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
]

BUSINESS_TABLES = (
    "teams",
    "groups",
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


def _configure_email() -> None:
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["enabled"] = True
    payload["email"]["smtp"].update(
        {
            "host": "127.0.0.1",
            "port": 2525,
            "fromEmail": "noreply@corp.example",
        }
    )
    settings_service.save(payload)


def _capture_codes(monkeypatch) -> dict:
    captured: dict = {}

    def fake_send(*, recipient: str, code: str, purpose: str = "login", expires_minutes: int = 10):
        captured.update({"recipient": recipient, "code": code, "purpose": purpose})

    monkeypatch.setattr(auth_router, "send_verification_code", fake_send)
    return captured


def _email_login(client, email: str, monkeypatch) -> dict:
    captured = _capture_codes(monkeypatch)
    requested = client.post("/api/auth/email/request", json={"email": email})
    assert requested.status_code == 200, requested.text
    verified = client.post(
        "/api/auth/email/verify", json={"email": email, "code": captured["code"]}
    )
    assert verified.status_code == 200, verified.text
    return verified.json()["data"]


def _assert_device_admin_required(response) -> None:
    assert response.status_code == 403, response.text
    error = response.json()["error"]
    assert error["code"] == "device_admin_required"
    assert error["message"] == DEVICE_ADMIN_MESSAGE


def _assert_stat_shape(stats: dict) -> None:
    assert list(stats.keys()) == STAT_KEYS
    assert all(isinstance(value, int) for value in stats.values())


def _assert_everything_empty() -> dict[str, int]:
    with db() as conn:
        counts = {
            table: int(scalar(conn, f"SELECT COUNT(*) FROM {table}", default=0) or 0)
            for table in BUSINESS_TABLES
        }
    assert counts == {table: 0 for table in BUSINESS_TABLES}
    return counts


# --------------------------------------------------------------------------- device Admin only


def test_default_site_settings_are_rebranded():
    assert DEFAULT_SETTINGS.site.name == "团队工作室"
    assert DEFAULT_SETTINGS.site.shortName == "TeamStudio"


def test_reset_preview_and_device_admin_only(client, monkeypatch):
    _configure_email()
    site_name = settings_service.get().site.name

    preview = client.get("/api/system/reset")
    assert preview.status_code == 200, preview.text
    data = preview.json()["data"]
    assert data["deviceAdmin"] is True
    assert data["canReset"] is True
    assert data["siteName"] == site_name
    assert data["siteShortName"] == settings_service.get().site.shortName
    assert data["defaultSiteName"] == DEFAULT_SETTINGS.site.name
    assert data["defaultSiteShortName"] == DEFAULT_SETTINGS.site.shortName
    assert data["lastResetAt"] is None
    assert data["lastResetBy"] == ""
    _assert_stat_shape(data["stats"])
    assert data["stats"]["teams"] > 0
    assert data["stats"]["accounts"] > 0

    # Signing out of the built-in Admin makes the device a plain guest: no reset access.
    assert client.post("/api/auth/logout").status_code == 200
    _assert_device_admin_required(client.get("/api/system/reset"))
    _assert_device_admin_required(
        client.post(
            "/api/system/reset",
            json={"confirmName": site_name, "acknowledge": True},
        )
    )

    # A stored ``super`` account signed in on the deployment device is still not the
    # built-in device Admin, so the whole-system reset stays forbidden to it.
    with db() as conn:
        accounts.create_user(
            conn,
            email="device.super.reset@corp.example",
            name="设备上的超管账号",
            role="super",
            email_verified=True,
            created_by="test",
        )
    _email_login(client, "device.super.reset@corp.example", monkeypatch)
    me = client.get("/api/auth/me").json()["data"]
    assert me["isSuperAdmin"] is True
    assert me["isDeviceAdmin"] is False
    assert me["deviceAdminActive"] is False
    _assert_device_admin_required(client.get("/api/system/reset"))
    _assert_device_admin_required(
        client.post(
            "/api/system/reset",
            json={"confirmName": site_name, "acknowledge": True},
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
    assert teams_before > 0

    rejected = client.post(
        "/api/system/reset", json={"confirmName": site_name, "acknowledge": False}
    )
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["error"]["code"] == "acknowledge_required"
    assert rejected.json()["error"]["message"] == ACKNOWLEDGE_MESSAGE

    missing = client.post("/api/system/reset", json={"confirmName": site_name})
    assert missing.status_code == 422, missing.text
    assert missing.json()["error"]["code"] == "acknowledge_required"

    mismatch = client.post(
        "/api/system/reset", json={"confirmName": "错误名称", "acknowledge": True}
    )
    assert mismatch.status_code == 422, mismatch.text
    error = mismatch.json()["error"]
    assert error["code"] == "confirm_mismatch"
    assert error["message"] == CONFIRM_MISMATCH_MESSAGE
    assert error["details"]["expected"] == site_name

    # Nothing was destroyed and the settings were not touched.
    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM teams", default=0) == teams_before
    assert settings_service.get().site.name == site_name
    preview = client.get("/api/system/reset").json()["data"]
    assert preview["lastResetAt"] is None


# --------------------------------------------------------------------------- full reset


def test_factory_reset_wipes_data_and_stays_empty(client):
    site_name = "自定义站点名称"

    # An extra team (audit-logged) on top of the seeded demo data.
    created = client.post(
        "/api/workspace/teams", json={"name": "临时团队", "shortName": "临时"}
    )
    assert created.status_code == 200, created.text

    # A dummy uploaded avatar that the factory reset must remove.
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    avatar_dir = UPLOAD_DIR / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    (avatar_dir / "dummy-avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n dummy")

    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["site"]["name"] = site_name
    payload["site"]["shortName"] = "自定义"
    settings_service.save(payload)

    preview = client.get("/api/system/reset").json()["data"]
    pre_stats = preview["stats"]
    _assert_stat_shape(pre_stats)
    assert pre_stats["teams"] == 3  # two seeded teams + the temporary one
    assert pre_stats["works"] > 0
    assert pre_stats["todos"] > 0
    assert pre_stats["accounts"] > 0

    response = client.post(
        "/api/system/reset",
        json={"confirmName": "  自定义站点名称  ", "acknowledge": True},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["reset"] is True
    assert datetime.fromisoformat(data["resetAt"]).tzinfo is not None
    # conftest pins TEAMSTUDIO_SESSION_SECRET, so the file-based rotation is skipped.
    assert data["sessionSecretRotated"] is False
    assert data["uploadsRemoved"] == 1
    assert data["cleared"] == pre_stats
    assert data["siteName"] == DEFAULT_SETTINGS.site.name
    assert data["siteShortName"] == DEFAULT_SETTINGS.site.shortName

    # The reset is complete on disk, not just in SQLite's logical view: the compacted
    # database (and its WAL sidecar) must not retain any recoverable demo content.
    markers = ("极光产品团队", "林知夏", "corp.example")
    db_bytes = DB_PATH.read_bytes()
    for marker in markers:
        assert marker.encode("utf-8") not in db_bytes
    wal_path = Path(str(DB_PATH) + "-wal")
    if wal_path.exists():
        wal_bytes = wal_path.read_bytes()
        for marker in markers:
            assert marker.encode("utf-8") not in wal_bytes

    # Workspace and bootstrap are empty; the device Admin is the only account left.
    assert client.get("/api/teams").json()["data"]["teams"] == []
    bootstrap = client.get("/api/bootstrap").json()["data"]
    assert bootstrap["active"]["team"] is None
    assert bootstrap["active"]["group"] is None
    assert bootstrap["stats"]["teams"] == 0
    assert bootstrap["stats"]["groups"] == 0
    assert bootstrap["stats"]["members"] == 0
    users = client.get("/api/users").json()["data"]["users"]
    assert [user["id"] for user in users] == ["device-admin"]

    # Settings are back to the defaults, both in memory and on disk.
    settings_payload = client.get("/api/settings").json()["data"]["settings"]
    assert settings_payload["site"]["name"] == DEFAULT_SETTINGS.site.name
    assert settings_payload["site"]["shortName"] == DEFAULT_SETTINGS.site.shortName
    on_disk = json.loads(Path(settings_service.path).read_text(encoding="utf-8"))
    assert on_disk["site"]["name"] == DEFAULT_SETTINGS.site.name
    assert on_disk["site"]["shortName"] == DEFAULT_SETTINGS.site.shortName

    # Uploaded files are gone but the upload directory itself is kept.
    assert UPLOAD_DIR.is_dir()
    assert [path for path in UPLOAD_DIR.rglob("*") if path.is_file()] == []

    # Every business/account/log table is empty; the reset marker and exactly one audit
    # row document what happened.
    _assert_everything_empty()
    with db() as conn:
        assert get_meta(conn, "factoryResetAt") == data["resetAt"]
        assert get_meta(conn, "factoryResetBy") == "Admin"
        audit = rows(conn, "SELECT * FROM audit_logs")
    assert len(audit) == 1
    assert audit[0]["action"] == "system.factory_reset"
    assert audit[0]["actor"] == "Admin"
    assert audit[0]["entity"] == "system"
    detail = json.loads(audit[0]["detail"])
    assert detail["siteName"] == site_name
    assert detail["cleared"] == pre_stats
    assert detail["removedFiles"] == 1

    # The preview now reports the reset and zero rows in every category (the single
    # factory-reset audit row is the expected exception).
    after = client.get("/api/system/reset").json()["data"]
    assert after["lastResetAt"] == data["resetAt"]
    assert after["lastResetBy"] == "Admin"
    assert after["siteName"] == DEFAULT_SETTINGS.site.name
    assert after["stats"]["auditLogs"] == 1
    assert all(
        value == 0 for key, value in after["stats"].items() if key != "auditLogs"
    )

    # Restart safety: the demo seeder must not refill an intentionally reset deployment.
    assert seed_if_empty() is False
    assert seed_member_tasks_if_empty() == 0
    assert seed_users_if_empty() == 0
    assert client.get("/api/teams").json()["data"]["teams"] == []
    _assert_everything_empty()

    # The built-in device Admin is the recovery path: it can recreate a team.
    recovered = client.post(
        "/api/workspace/teams", json={"name": "重建团队", "shortName": "重建"}
    )
    assert recovered.status_code == 200, recovered.text
    recovered_bootstrap = client.get("/api/bootstrap").json()["data"]
    assert recovered_bootstrap["active"]["team"] is not None
    assert recovered_bootstrap["active"]["team"]["name"] == "重建团队"
    assert recovered_bootstrap["stats"]["teams"] == 1
