"""Tests for explicit demo-data seeding.

The FastAPI lifespan must never create demo data, so a fresh or factory-reset
deployment stays empty across restarts. Demo content is only created by the explicit
``seed_demo_data()`` entrypoint behind ``scripts/seed-demo.ps1``
(``python -m backend.app.seed``).

Every test starts from a wiped SQLite database. The ``client`` / ``guest_client``
fixtures in ``backend/tests/conftest.py`` wipe and re-seed the shared test database
themselves, so nothing here may rely on previous module state; an autouse module
fixture additionally restores a valid seeded database once this module finishes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.db import DB_PATH, db, init_db, scalar, set_meta
from backend.app.seed import main, seed_demo_data, seed_if_empty

# Business tables that demo seeding touches; a booted app on an empty database must
# leave every one of them empty.
DEMO_TABLES = (
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
)

RESET_AT = "2026-01-01T00:00:00+08:00"

# ``seed_demo_data()["counts"]`` key -> SQLite table.
SUMMARY_TO_TABLE = {
    "teams": "teams",
    "groups": "groups",
    "members": "members",
    "works": "works",
    "todos": "todos",
    "memberTasks": "member_tasks",
    "boards": "redblack_boards",
    "links": "links",
    "matrix": "matrix_areas",
    "announcements": "announcements",
    "accounts": "users",
}


def _wipe_database() -> None:
    """Remove the shared test database file and its WAL sidecars."""
    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        if sidecar.exists():
            sidecar.unlink()
    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))


def _table_counts() -> dict[str, int]:
    with db() as conn:
        return {
            table: int(scalar(conn, f"SELECT COUNT(*) FROM {table}", default=0) or 0)
            for table in DEMO_TABLES
        }


def _summary_counts_from_db() -> dict[str, int]:
    counts = _table_counts()
    return {key: counts[table] for key, table in SUMMARY_TO_TABLE.items()}


@pytest.fixture(scope="module", autouse=True)
def _restore_shared_database():
    """Leave a normal, fully seeded test database behind for later test modules."""
    yield
    _wipe_database()
    seed_demo_data()


def test_app_startup_does_not_create_demo_data():
    """Booting the real app lifespan on an empty database creates zero demo rows."""
    from fastapi.testclient import TestClient

    from backend.app.main import app

    _wipe_database()
    with TestClient(
        app, client=("127.0.0.1", 51002), raise_server_exceptions=False
    ) as test_client:
        health = test_client.get("/api/health")
        assert health.status_code == 200, health.text

    # The lifespan ran init_db() (schema exists) but no seeder was called.
    counts = _table_counts()
    assert counts == {table: 0 for table in DEMO_TABLES}
    assert counts["teams"] == 0
    assert counts["users"] == 0
    assert counts["member_tasks"] == 0


def test_seed_demo_data_populates_an_empty_database():
    """The explicit script path creates teams, members, accounts and member tasks."""
    _wipe_database()
    # Mirror the conftest fixtures: init_db() already ran, then the demo seed happens.
    init_db()
    summary = seed_demo_data()

    assert summary["seeded"] is True
    assert summary["memberTasks"] > 0
    assert summary["accounts"] > 0
    counts = summary["counts"]
    assert counts["teams"] > 0
    assert counts["groups"] > 0
    assert counts["members"] > 0
    assert counts["works"] > 0
    assert counts["memberTasks"] > 0
    assert counts["accounts"] > 0
    # The summary counts must describe the database, not just this call's inserts.
    assert _summary_counts_from_db() == counts


def test_second_seed_demo_data_call_is_idempotent():
    """Running the script twice inserts nothing and reports a no-op."""
    _wipe_database()
    first = seed_demo_data()
    assert first["seeded"] is True
    counts_before = dict(first["counts"])

    second = seed_demo_data()
    assert second["seeded"] is False
    assert second["memberTasks"] == 0
    assert second["accounts"] == 0
    assert second["counts"] == counts_before
    assert _summary_counts_from_db() == counts_before


def test_factory_reset_marker_only_blocks_guarded_seeding():
    """After a factory reset only the explicit forced seed may restore demo data."""
    _wipe_database()
    init_db()
    with db() as conn:
        set_meta(conn, "factoryResetAt", RESET_AT)

    # Guarded/default seeding refuses to refill an intentionally reset deployment.
    assert seed_if_empty() is False
    guarded = seed_demo_data(force=False)
    assert guarded["seeded"] is False
    assert guarded["memberTasks"] == 0
    assert guarded["accounts"] == 0
    assert guarded["counts"]["teams"] == 0
    assert all(value == 0 for value in guarded["counts"].values())

    # Explicit operator action (the script runs with force by default) restores it.
    forced = seed_demo_data()
    assert forced["seeded"] is True
    assert forced["counts"]["teams"] > 0
    assert forced["counts"]["members"] > 0
    assert forced["counts"]["accounts"] > 0
    assert forced["counts"]["memberTasks"] > 0


def test_cli_writes_demo_data_and_is_idempotent(capsys):
    """`python -m backend.app.seed` exits 0, prints a summary and can run twice."""
    _wipe_database()

    assert main([]) == 0
    first_output = capsys.readouterr().out
    assert "已写入" in first_output
    assert "团队" in first_output
    assert "本次新增" in first_output

    assert main([]) == 0
    second_output = capsys.readouterr().out
    assert "没有做任何变更" in second_output or "已存在" in second_output
    assert "本次新增：成员任务 0 条，演示账号 0 个。" in second_output


def test_cli_no_force_respects_factory_reset_marker(capsys):
    """`--no-force` prints the skip notice and writes nothing after a reset."""
    _wipe_database()
    init_db()
    with db() as conn:
        set_meta(conn, "factoryResetAt", RESET_AT)

    assert main(["--no-force"]) == 0
    output = capsys.readouterr().out
    assert "跳过" in output
    assert "factoryResetAt" in output
    assert all(value == 0 for value in _table_counts().values())
