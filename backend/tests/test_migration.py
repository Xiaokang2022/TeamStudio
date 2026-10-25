"""Round-8 database migration (§1.2): development groups fold into teams.

A realistic pre-round-8 database (``legacy_schema.py``) is rebuilt in place: every
business table swaps ``group_id`` for ``team_id`` (value taken from its group's team),
``members.status`` is dropped, red/black boards of one team+month merge, duplicate task
tags are renamed and ``group_admin`` accounts become ``team_admin``. The migration must be
idempotent and a brand-new database must use the new team-only schema directly.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

from backend.tests.legacy_schema import create_legacy_database

GROUP_SCOPED_TABLES = (
    "members",
    "works",
    "todos",
    "member_tasks",
    "redblack_boards",
    "links",
    "matrix_areas",
    "announcements",
    "task_tags",
)

# Round 9 re-introduces group_id on these two tables, but as a team_groups reference
# ("" = ungrouped), never as the retired development-group id.
ROUND9_GROUPED_TABLES = ("members", "member_tasks")


def _use_database(tmp_path, monkeypatch):
    import backend.app.db as db_module

    path = tmp_path / "legacy-teamstudio.db"
    monkeypatch.setattr(db_module, "DB_PATH", path)
    return path, db_module


@contextmanager
def _connect(path):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _fetchall(connection: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in connection.execute(sql, params).fetchall()]


def test_fresh_database_uses_team_only_schema(tmp_path, monkeypatch):
    path, db_module = _use_database(tmp_path, monkeypatch)
    db_module.init_db()

    with _connect(path) as connection:
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "groups" not in tables
        assert "team-aurora" not in str(tables)  # no accidental demo seed
        for table in GROUP_SCOPED_TABLES:
            columns = _columns(connection, table)
            assert "team_id" in columns, table
            if table in ROUND9_GROUPED_TABLES:
                assert "group_id" in columns, table
            else:
                assert "group_id" not in columns, table
        assert {"team_groups", "team_settings"} <= tables
        assert "planned_date" in _columns(connection, "works")
        assert "status" not in _columns(connection, "members")
        assert "avatar_url" in _columns(connection, "members")
        assert "group_ids" not in _columns(connection, "users")
        assert "backup_member_ids" in _columns(connection, "matrix_areas")


def test_legacy_database_migrates_to_teams(tmp_path, monkeypatch):
    path, db_module = _use_database(tmp_path, monkeypatch)
    create_legacy_database(path)

    db_module.init_db()

    with _connect(path) as connection:
        # 1. The legacy group structure is gone from every business table; the round-9
        #    team-group columns exist but stay empty (legacy ids are never carried over).
        for table in GROUP_SCOPED_TABLES:
            columns = _columns(connection, table)
            assert "team_id" in columns, table
            if table in ROUND9_GROUPED_TABLES:
                assert "group_id" in columns, table
            else:
                assert "group_id" not in columns, table
        for table in ROUND9_GROUPED_TABLES:
            assert (
                connection.execute(
                    f'SELECT COUNT(*) FROM "{table}" WHERE group_id<>\'\''
                ).fetchone()[0]
                == 0
            ), table
        assert "planned_date" in _columns(connection, "works")
        assert "status" not in _columns(connection, "members")

        # 2. Business rows are preserved with their ids and mapped to the group's team.
        member = dict(
            connection.execute("SELECT * FROM members WHERE id='m-one'").fetchone()
        )
        assert member["team_id"] == "team-a"
        assert member["name"] == "成员一"
        assert member["title"] == "前端"
        assert "status" not in member

        work = dict(connection.execute("SELECT * FROM works WHERE id='w-one'").fetchone())
        assert work["team_id"] == "team-a"
        assert work["status"] == "current"

        todo = dict(connection.execute("SELECT * FROM todos WHERE id='t-one'").fetchone())
        assert todo["team_id"] == "team-a"

        task = dict(
            connection.execute("SELECT * FROM member_tasks WHERE id='mt-one'").fetchone()
        )
        assert task["team_id"] == "team-a"

        link = dict(connection.execute("SELECT * FROM links WHERE id='l-one'").fetchone())
        assert link["team_id"] == "team-a"

        area = dict(
            connection.execute("SELECT * FROM matrix_areas WHERE id='area-one'").fetchone()
        )
        assert area["team_id"] == "team-a"
        assert json.loads(area["backup_member_ids"]) == ["m-two"]

        announcement = dict(
            connection.execute("SELECT * FROM announcements WHERE id='ann-one'").fetchone()
        )
        assert announcement["team_id"] == "team-a"

        # 3. Two boards of the same team+month merge into the earliest board.
        boards = _fetchall(
            connection,
            "SELECT * FROM redblack_boards WHERE team_id='team-a' AND month='2026-02'",
        )
        assert len(boards) == 1
        assert boards[0]["id"] == "board-early"
        entries = _fetchall(
            connection,
            "SELECT * FROM redblack_entries WHERE board_id=? ORDER BY sort_order",
            (boards[0]["id"],),
        )
        assert {entry["id"] for entry in entries} == {"entry-1", "entry-2"}
        assert all(entry["side"] == "red" for entry in entries)

        # 4. Duplicate tag names in one team are renamed, ids stay stable.
        tags = _fetchall(
            connection, "SELECT * FROM task_tags WHERE team_id='team-a' ORDER BY id"
        )
        names = {tag["id"]: tag["name"] for tag in tags}
        assert names["tag-one"] == "前端"
        assert names["tag-two"] == "前端 (2)"

        # 5. ``group_admin`` becomes ``team_admin`` with the groups' teams merged in.
        admin = dict(
            connection.execute("SELECT * FROM users WHERE id='old.admin'").fetchone()
        )
        assert admin["role"] == "team_admin"
        assert sorted(json.loads(admin["team_ids"])) == ["team-a", "team-b"]

        # 6. New writes use the new column name.
        connection.execute(
            "INSERT INTO links (id,team_id,title,url,created_at,updated_at) "
            "VALUES ('l-new','team-b','新链接','https://example.com/new','2026-02-01','2026-02-01')"
        )
        connection.commit()

    # 7. Migration is idempotent: another startup changes nothing and does not raise.
    db_module.init_db()
    with _connect(path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM members").fetchone()[0] == 3
        )
        # Both legacy boards belong to team-a and month 2026-02 -> one merged board.
        assert (
            connection.execute("SELECT COUNT(*) FROM redblack_boards").fetchone()[0] == 1
        )
        tags = _fetchall(connection, "SELECT name FROM task_tags ORDER BY name")
        assert sorted(tag["name"] for tag in tags) == ["前端", "前端 (2)", "数据"]
        admin = dict(
            connection.execute("SELECT * FROM users WHERE id='old.admin'").fetchone()
        )
        assert admin["role"] == "team_admin"
        assert sorted(json.loads(admin["team_ids"])) == ["team-a", "team-b"]


def test_legacy_migration_keeps_redblack_side_and_orders_entries(tmp_path, monkeypatch):
    path, db_module = _use_database(tmp_path, monkeypatch)
    create_legacy_database(path)
    with _connect(path) as connection:
        # A black-board entry on the late board must survive with its side intact.
        connection.execute(
            "INSERT INTO redblack_entries (id,board_id,side,member_name,title,score,"
            "sort_order,created_at) VALUES "
            "('entry-3','board-late','black','成员二','黑榜乙',40,0,'2026-01-01')"
        )
        connection.commit()

    db_module.init_db()
    with _connect(path) as connection:
        board = connection.execute(
            "SELECT id FROM redblack_boards WHERE team_id='team-a' AND month='2026-02'"
        ).fetchone()
        entries = _fetchall(
            connection,
            "SELECT * FROM redblack_entries WHERE board_id=? ORDER BY sort_order",
            (board["id"],),
        )
    assert {entry["id"] for entry in entries} == {"entry-1", "entry-2", "entry-3"}
    sides = {entry["id"]: entry["side"] for entry in entries}
    assert sides["entry-1"] == "red"
    assert sides["entry-2"] == "red"
    assert sides["entry-3"] == "black"
    orders = [entry["sort_order"] for entry in entries]
    assert orders == sorted(orders)
