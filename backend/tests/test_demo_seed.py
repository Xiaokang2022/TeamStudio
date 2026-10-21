"""Explicit demo-data seeding (round 8: team-only demo workspace).

The application lifespan never creates demo data; only the explicit
``seed_demo_data()`` entrypoint (``python -m backend.app.seed``) does. The fresh seed is
team-only: two teams, 18 members with one archive row each, no ``groups`` table.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.db import DB_PATH, db, init_db, scalar, set_meta
from backend.app.seed import main, seed_demo_data, seed_if_empty

DEMO_TABLES = (
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
)

# ``seed_demo_data()["counts"]`` key -> SQLite table (the summary key names are stable).
SUMMARY_TO_TABLE = {
    "teams": "teams",
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

FRESH_SEED_COUNTS = {
    "teams": 2,
    "members": 18,
    "works": 39,
    "todos": 20,
    "member_tasks": 49,
    "redblack_boards": 4,
    "redblack_entries": 32,
    "links": 16,
    "matrix_areas": 18,
    "announcements": 13,
    "task_tags": 0,
    "users": 18,
}

RESET_AT = "2026-01-01T00:00:00+08:00"


def _wipe_database() -> None:
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
    yield
    _wipe_database()
    seed_demo_data()


def test_app_startup_does_not_create_demo_data():
    from fastapi.testclient import TestClient

    from backend.app.main import app

    _wipe_database()
    with TestClient(
        app, client=("127.0.0.1", 61002), raise_server_exceptions=False
    ) as test_client:
        assert test_client.get("/api/health").status_code == 200

    counts = _table_counts()
    assert counts == {table: 0 for table in DEMO_TABLES}
    assert counts["teams"] == 0
    assert counts["users"] == 0
    assert counts["member_tasks"] == 0


def test_seed_demo_data_populates_an_empty_team_only_workspace():
    _wipe_database()
    init_db()
    summary = seed_demo_data()

    assert summary["seeded"] is True
    assert summary["memberTasks"] > 0
    assert summary["accounts"] > 0
    counts = summary["counts"]
    assert counts["teams"] == 2
    assert counts["members"] == 18
    assert counts["works"] == 39
    assert counts["memberTasks"] == 49
    assert counts["accounts"] == 18
    for legacy in ("groups", "groupTasks", "groupCount"):
        assert legacy not in counts
    # The summary counts describe the database, not just this call's inserts.
    assert _summary_counts_from_db() == {key: counts[key] for key in SUMMARY_TO_TABLE}
    assert _table_counts() == FRESH_SEED_COUNTS

    # The demo workspace is team-only: no group table survives the fresh schema.
    with db() as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert "groups" not in tables


def test_second_seed_demo_data_call_is_idempotent():
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
    assert _table_counts() == FRESH_SEED_COUNTS


def test_factory_reset_marker_only_blocks_guarded_seeding():
    _wipe_database()
    init_db()
    with db() as conn:
        set_meta(conn, "factoryResetAt", RESET_AT)

    assert seed_if_empty() is False
    guarded = seed_demo_data(force=False)
    assert guarded["seeded"] is False
    assert guarded["counts"]["teams"] == 0
    assert all(value == 0 for value in guarded["counts"].values())

    forced = seed_demo_data()
    assert forced["seeded"] is True
    assert forced["counts"]["teams"] == 2
    assert forced["counts"]["members"] == 18
    assert forced["counts"]["accounts"] == 18


def test_cli_writes_demo_data_and_is_idempotent(capsys):
    _wipe_database()

    assert main([]) == 0
    first_output = capsys.readouterr().out
    assert first_output.strip()
    assert "团队" in first_output

    assert main([]) == 0
    second_output = capsys.readouterr().out
    assert "本次新增：成员任务 0 条，演示账号 0 个。" in second_output
    assert _table_counts() == FRESH_SEED_COUNTS


def test_cli_no_force_respects_factory_reset_marker(capsys):
    _wipe_database()
    init_db()
    with db() as conn:
        set_meta(conn, "factoryResetAt", RESET_AT)

    assert main(["--no-force"]) == 0
    output = capsys.readouterr().out
    assert "跳过" in output
    assert all(value == 0 for value in _table_counts().values())
