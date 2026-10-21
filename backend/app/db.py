"""SQLite storage helpers and schema.

Round 8 makes the **team** the only organisation unit
(``docs/ROUND8_CONTRACT.md``): the ``groups`` table is gone and every business table is
isolated by ``team_id``. ``init_db()`` creates the fresh schema for a new database and
migrates an existing development-group database in place (§1.2):

* business tables that carried ``group_id`` are rebuilt with ``team_id`` (values derived
  from the owning group's team), keeping every business row id and reference;
* duplicate red/black boards of the same (team, month) are merged into the earliest one;
* duplicate task tags of the same (team, name) are renamed ``name (2)``, ``name (3)``…
* ``users.role='group_admin'`` becomes ``team_admin`` and ``group_ids`` is folded into
  ``team_ids``;
* the orphan ``groups`` table is dropped;
* the whole migration runs inside one transaction and records ``schema_round8_migrated``
  in ``app_meta`` so a repeated ``init_db()`` never rewrites the data. Any failure rolls
  back and raises, which blocks startup instead of writing half-migrated data.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import DATA_DIR

DB_PATH = Path(os.environ.get("TEAMSTUDIO_DB", DATA_DIR / "teamstudio.db"))
_AUDIT_LOCK = threading.Lock()
ROUND8_META_KEY = "schema_round8_migrated"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, fallback: Any = None) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


# --------------------------------------------------------------------------- schema DDL
#
# The table definitions live in one place so the fresh schema and the round-8 rebuild
# migration can never drift apart. ``_COLUMNS`` holds ``(name, declaration)`` pairs in
# column order; ``_CONSTRAINTS`` holds trailing table constraints.

_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    "teams": (
        ("id", "TEXT PRIMARY KEY"),
        ("name", "TEXT NOT NULL"),
        ("short_name", "TEXT NOT NULL DEFAULT ''"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("color", "TEXT NOT NULL DEFAULT '#5865f2'"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL"),
    ),
    "members": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("external_id", "TEXT NOT NULL DEFAULT ''"),
        ("name", "TEXT NOT NULL"),
        ("email", "TEXT NOT NULL DEFAULT ''"),
        ("avatar_url", "TEXT NOT NULL DEFAULT ''"),
        ("title", "TEXT NOT NULL DEFAULT ''"),
        ("role", "TEXT NOT NULL DEFAULT '成员'"),
        ("avatar_color", "TEXT NOT NULL DEFAULT '#5865f2'"),
        ("bio", "TEXT NOT NULL DEFAULT ''"),
        ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("skills", "TEXT NOT NULL DEFAULT '[]'"),
        ("joined_at", "TEXT NOT NULL DEFAULT ''"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "works": (
        ("id", "TEXT PRIMARY KEY"),
        ("member_id", "TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("title", "TEXT NOT NULL"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("status", "TEXT NOT NULL DEFAULT 'current'"),
        ("period", "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT NOT NULL DEFAULT ''"),
        ("progress", "INTEGER NOT NULL DEFAULT 0"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "todos": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("title", "TEXT NOT NULL"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("due_date", "TEXT NOT NULL"),
        ("due_time", "TEXT NOT NULL DEFAULT '18:00'"),
        ("assignee_member_id", "TEXT REFERENCES members(id) ON DELETE SET NULL"),
        ("priority", "TEXT NOT NULL DEFAULT 'normal'"),
        ("status", "TEXT NOT NULL DEFAULT 'todo'"),
        ("created_by", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
        ("completed_at", "TEXT"),
    ),
    "member_tasks": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("member_id", "TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE"),
        ("title", "TEXT NOT NULL"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        (
            "progress_status",
            "TEXT NOT NULL DEFAULT 'pending' "
            "CHECK(progress_status IN ('pending','in_progress','completed'))",
        ),
        (
            "health_status",
            "TEXT NOT NULL DEFAULT 'normal' "
            "CHECK(health_status IN ('normal','delayed','blocked'))",
        ),
        (
            "priority",
            "TEXT NOT NULL DEFAULT 'normal' "
            "CHECK(priority IN ('low','normal','high','urgent'))",
        ),
        (
            "difficulty",
            "TEXT NOT NULL DEFAULT 'medium' CHECK(difficulty IN ('easy','medium','hard'))",
        ),
        ("expected_date", "TEXT NOT NULL DEFAULT ''"),
        ("effort_hours", "REAL NOT NULL DEFAULT 8"),
        ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("created_by", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
        ("completed_at", "TEXT"),
    ),
    "redblack_boards": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("month", "TEXT NOT NULL"),
        ("theme", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "redblack_entries": (
        ("id", "TEXT PRIMARY KEY"),
        ("board_id", "TEXT NOT NULL REFERENCES redblack_boards(id) ON DELETE CASCADE"),
        ("side", "TEXT NOT NULL CHECK(side IN ('red','black'))"),
        ("member_id", "TEXT"),
        ("member_name", "TEXT NOT NULL DEFAULT ''"),
        ("title", "TEXT NOT NULL"),
        ("reason", "TEXT NOT NULL DEFAULT ''"),
        ("score", "REAL NOT NULL DEFAULT 0"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL"),
    ),
    "links": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("title", "TEXT NOT NULL"),
        ("url", "TEXT NOT NULL"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT NOT NULL DEFAULT '常用'"),
        ("color", "TEXT NOT NULL DEFAULT '#5865f2'"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "matrix_areas": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("area", "TEXT NOT NULL"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("owner_member_id", "TEXT"),
        ("backup_member_id", "TEXT"),
        ("backup_member_ids", "TEXT NOT NULL DEFAULT '[]'"),
        ("channel", "TEXT NOT NULL DEFAULT '企业微信'"),
        ("contact", "TEXT NOT NULL DEFAULT ''"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "announcements": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("title", "TEXT NOT NULL"),
        ("content", "TEXT NOT NULL DEFAULT ''"),
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ("level", "TEXT NOT NULL DEFAULT 'info'"),
        ("author_name", "TEXT NOT NULL DEFAULT ''"),
        ("created_by", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "task_tags": (
        ("id", "TEXT PRIMARY KEY"),
        ("team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
        ("name", "TEXT NOT NULL"),
        ("color", "TEXT NOT NULL DEFAULT '#5865f2'"),
        ("created_by", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "users": (
        ("id", "TEXT PRIMARY KEY"),
        ("email", "TEXT NOT NULL UNIQUE"),
        ("name", "TEXT NOT NULL DEFAULT ''"),
        ("avatar", "TEXT NOT NULL DEFAULT ''"),
        ("avatar_color", "TEXT NOT NULL DEFAULT '#5865f2'"),
        ("bio", "TEXT NOT NULL DEFAULT ''"),
        ("skills", "TEXT NOT NULL DEFAULT '[]'"),
        (
            "role",
            "TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','team_admin','super'))",
        ),
        ("team_ids", "TEXT NOT NULL DEFAULT '[]'"),
        ("email_verified", "INTEGER NOT NULL DEFAULT 0"),
        ("created_by", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
        ("updated_at", "TEXT NOT NULL"),
    ),
    "email_codes": (
        ("id", "TEXT PRIMARY KEY"),
        ("email", "TEXT NOT NULL"),
        ("code_hash", "TEXT NOT NULL"),
        ("purpose", "TEXT NOT NULL DEFAULT 'login'"),
        ("expires_at", "TEXT NOT NULL"),
        ("attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("consumed_at", "TEXT"),
        ("request_ip", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
    ),
    "user_activation_tokens": (
        ("token_hash", "TEXT PRIMARY KEY"),
        ("user_id", "TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE"),
        ("expires_at", "TEXT NOT NULL"),
        ("used_at", "TEXT"),
        ("created_at", "TEXT NOT NULL"),
        ("created_by", "TEXT NOT NULL DEFAULT ''"),
    ),
    # ``group_id`` is a legacy TEXT column kept for compatibility; round-8 code writes "".
    "email_logs": (
        ("id", "TEXT PRIMARY KEY"),
        ("group_id", "TEXT NOT NULL DEFAULT ''"),
        ("todo_id", "TEXT NOT NULL DEFAULT ''"),
        ("kind", "TEXT NOT NULL DEFAULT 'verification'"),
        ("recipient", "TEXT NOT NULL DEFAULT ''"),
        ("subject", "TEXT NOT NULL DEFAULT ''"),
        ("status", "TEXT NOT NULL DEFAULT 'sent'"),
        ("error", "TEXT NOT NULL DEFAULT ''"),
        ("detail", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
    ),
    "audit_logs": (
        ("id", "TEXT PRIMARY KEY"),
        ("actor", "TEXT NOT NULL DEFAULT ''"),
        ("action", "TEXT NOT NULL DEFAULT ''"),
        ("entity", "TEXT NOT NULL DEFAULT ''"),
        ("entity_id", "TEXT NOT NULL DEFAULT ''"),
        ("detail", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL"),
    ),
    "app_meta": (
        ("key", "TEXT PRIMARY KEY"),
        ("value", "TEXT NOT NULL"),
    ),
}

_CONSTRAINTS: dict[str, tuple[str, ...]] = {
    "redblack_boards": ("UNIQUE(team_id, month)",),
    "task_tags": ("UNIQUE(team_id, name)",),
}

_INDEXES: tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_teams_sort ON teams(sort_order, name)",
    "CREATE INDEX IF NOT EXISTS idx_members_team ON members(team_id, sort_order)",
    "CREATE INDEX IF NOT EXISTS idx_members_external ON members(external_id)",
    "CREATE INDEX IF NOT EXISTS idx_works_team ON works(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_works_member ON works(member_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_todos_team_date ON todos(team_id, due_date)",
    "CREATE INDEX IF NOT EXISTS idx_member_tasks_team_member "
    "ON member_tasks(team_id, member_id)",
    "CREATE INDEX IF NOT EXISTS idx_redblack_boards_team_month "
    "ON redblack_boards(team_id, month)",
    "CREATE INDEX IF NOT EXISTS idx_redblack_entries_board "
    "ON redblack_entries(board_id, side, sort_order)",
    "CREATE INDEX IF NOT EXISTS idx_links_team ON links(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_matrix_team ON matrix_areas(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_announcements_team "
    "ON announcements(team_id, pinned DESC, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_task_tags_team ON task_tags(team_id, name)",
    "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)",
    "CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)",
    "CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_activation_tokens_user "
    "ON user_activation_tokens(user_id)",
)

# Business tables that carried a ``group_id`` in the legacy schema. ``redblack_entries``
# has no group column; it keeps its board FK, which resolves against the rebuilt board table.
_LEGACY_BUSINESS_TABLES: tuple[str, ...] = (
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


def _table_column_names(table: str) -> list[str]:
    return [name for name, _declaration in _COLUMNS[table]]


def _create_table_sql(
    table: str, *, table_name: str | None = None, if_not_exists: bool = True
) -> str:
    parts = [f"{name} {declaration}" for name, declaration in _COLUMNS[table]]
    parts.extend(_CONSTRAINTS.get(table, ()))
    body = ",\n".join(f"    {part}" for part in parts)
    prefix = "CREATE TABLE"
    if if_not_exists:
        prefix += " IF NOT EXISTS"
    return f"{prefix} {table_name or table} (\n{body}\n);"


def _build_schema() -> str:
    statements = ["PRAGMA journal_mode=WAL;", "PRAGMA foreign_keys=ON;"]
    statements.extend(_create_table_sql(table) for table in _COLUMNS)
    # ``executescript`` needs a statement separator after every statement, including the
    # index DDL (a single ``execute`` would be lenient, ``executescript`` is not).
    statements.extend(f"{statement.rstrip().rstrip(';')};" for statement in _INDEXES)
    return "\n\n".join(statements) + "\n"


SCHEMA = _build_schema()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row["name"])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [str(info[1]) for info in conn.execute(f'PRAGMA table_info("{table}")')]


# ------------------------------------------------------------------ additive migrations


def _migrate_member_tasks(conn: sqlite3.Connection) -> None:
    """Additive v2 migration: priority/difficulty columns + deterministic backfill.

    Existing deployments created ``member_tasks`` without the scoring columns. ``ALTER
    TABLE ... ADD COLUMN`` is skipped when the column already exists, and the one-time
    backfill only runs for columns added by this call, which keeps restarts idempotent.
    """
    columns = {
        str(info[1]) for info in conn.execute("PRAGMA table_info(member_tasks)").fetchall()
    }
    if not columns:
        return
    added: list[str] = []
    if "priority" not in columns:
        conn.execute(
            "ALTER TABLE member_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' "
            "CHECK(priority IN ('low','normal','high','urgent'))"
        )
        added.append("priority")
    if "difficulty" not in columns:
        conn.execute(
            "ALTER TABLE member_tasks ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium' "
            "CHECK(difficulty IN ('easy','medium','hard'))"
        )
        added.append("difficulty")
    if not added:
        return
    has_effort = "effort_hours" in columns
    if "difficulty" in added:
        # v1 stored only effort hours; map them onto the new difficulty scale.
        if has_effort:
            conn.execute(
                "UPDATE member_tasks SET difficulty = CASE "
                "WHEN effort_hours < 6 THEN 'easy' "
                "WHEN effort_hours < 12 THEN 'medium' ELSE 'hard' END"
            )
        else:  # pragma: no cover - defensive for hand-built databases
            conn.execute("UPDATE member_tasks SET difficulty='medium'")
    if "priority" in added:
        low_effort = "effort_hours < 6" if has_effort else "0"
        conn.execute(
            "UPDATE member_tasks SET priority = CASE "
            "WHEN health_status='blocked' THEN 'urgent' "
            "WHEN health_status='delayed' THEN 'high' "
            "WHEN progress_status<>'completed' AND expected_date<>'' "
            "AND expected_date < date('now','localtime') THEN 'high' "
            f"WHEN {low_effort} THEN 'low' "
            "ELSE 'normal' END"
        )


def _migrate_task_tags(conn: sqlite3.Connection) -> None:
    """Additive migration for the shared task tag library.

    ``member_tasks.tags`` stores a JSON array of ``task_tags.id`` values. Existing
    deployments gain the column with an empty list; the shared library table is created
    by the schema above.
    """
    columns = {
        str(info[1]) for info in conn.execute("PRAGMA table_info(member_tasks)").fetchall()
    }
    if columns and "tags" not in columns:
        conn.execute(
            "ALTER TABLE member_tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"
        )


def _migrate_matrix_backups(conn: sqlite3.Connection) -> None:
    """Additive v3 migration: multiple backups per responsibility area.

    ``matrix_areas`` gained a ``backup_member_ids`` JSON array while the legacy single
    ``backup_member_id`` column is kept for compatibility. Existing deployments get the
    column added and every legacy single backup is folded into the array exactly once, so
    repeated ``init_db()`` calls are safe.
    """
    columns = {
        str(info[1]) for info in conn.execute("PRAGMA table_info(matrix_areas)").fetchall()
    }
    if not columns:
        return
    if "backup_member_ids" not in columns:
        conn.execute(
            "ALTER TABLE matrix_areas ADD COLUMN backup_member_ids TEXT NOT NULL DEFAULT '[]'"
        )
    legacy_rows = conn.execute(
        "SELECT id, backup_member_id, backup_member_ids FROM matrix_areas "
        "WHERE backup_member_id IS NOT NULL AND backup_member_id <> ''"
    ).fetchall()
    for legacy in legacy_rows:
        parsed = json_loads(legacy["backup_member_ids"], None)
        if isinstance(parsed, list) and parsed:
            continue  # Already migrated (or written by the new code path).
        conn.execute(
            "UPDATE matrix_areas SET backup_member_ids=? WHERE id=?",
            (json_dumps([legacy["backup_member_id"]]), legacy["id"]),
        )


def _migrate_member_avatar(conn: sqlite3.Connection) -> None:
    """Additive v5 migration: profile photo URL on member records."""
    columns = {
        str(info[1]) for info in conn.execute("PRAGMA table_info(members)").fetchall()
    }
    if columns and "avatar_url" not in columns:
        conn.execute("ALTER TABLE members ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''")


def _migrate_remove_email_reminders(conn: sqlite3.Connection) -> None:
    """Round-5 cleanup: drop calendar reminder columns and the old mail tables.

    ``email`` now only powers account verification codes, so the legacy reminder
    bookkeeping and the bundled-mailbox storage are no longer needed. Existing
    deployments are upgraded in place; failures are best-effort (older SQLite builds
    may not support ``DROP COLUMN``) and never block startup.
    """
    todo_columns = {
        str(info[1]) for info in conn.execute("PRAGMA table_info(todos)").fetchall()
    }
    for column in ("reminder_offsets_days", "email_enabled"):
        if column in todo_columns:
            try:
                conn.execute(f"ALTER TABLE todos DROP COLUMN {column}")
            except sqlite3.OperationalError:  # pragma: no cover - legacy SQLite
                pass
    conn.execute("DROP TABLE IF EXISTS email_reminders_sent")
    conn.execute("DROP TABLE IF EXISTS mailbox_messages")


def _run_additive_migrations(conn: sqlite3.Connection) -> None:
    _migrate_member_tasks(conn)
    _migrate_task_tags(conn)
    _migrate_matrix_backups(conn)
    _migrate_member_avatar(conn)
    _migrate_remove_email_reminders(conn)


# --------------------------------------------------------------- round-8 team migration


def _is_legacy_groups_schema(conn: sqlite3.Connection) -> bool:
    """Whether this database still uses the pre-round-8 development-group layout."""
    tables = _table_names(conn)
    if "groups" not in tables or "teams" not in tables:
        return False
    for table in _LEGACY_BUSINESS_TABLES:
        if table in tables and "group_id" in _columns(conn, table):
            return True
    return False


def _merge_duplicate_redblack_boards(conn: sqlite3.Connection) -> None:
    """Merge boards that will share one (team, month) into the earliest created one."""
    tables = _table_names(conn)
    if not {"groups", "redblack_boards", "redblack_entries"} <= tables:
        return
    boards = conn.execute(
        "SELECT b.id, b.month, g.team_id, b.created_at FROM redblack_boards b "
        "JOIN groups g ON g.id = b.group_id "
        "ORDER BY g.team_id, b.month, COALESCE(b.created_at, ''), b.rowid"
    ).fetchall()
    grouped: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for board in boards:
        grouped.setdefault((str(board["team_id"]), str(board["month"])), []).append(board)
    for duplicates in grouped.values():
        if len(duplicates) <= 1:
            continue
        keep_id = str(duplicates[0]["id"])
        for duplicate in duplicates[1:]:
            duplicate_id = str(duplicate["id"])
            for side in ("red", "black"):
                current_max = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) FROM redblack_entries "
                    "WHERE board_id=? AND side=?",
                    (keep_id, side),
                ).fetchone()[0]
                entries = conn.execute(
                    "SELECT id FROM redblack_entries WHERE board_id=? AND side=? "
                    "ORDER BY sort_order, rowid",
                    (duplicate_id, side),
                ).fetchall()
                order = int(current_max or 0)
                for entry in entries:
                    order += 1
                    conn.execute(
                        "UPDATE redblack_entries SET board_id=?, sort_order=? WHERE id=?",
                        (keep_id, order, str(entry["id"])),
                    )
            conn.execute("DELETE FROM redblack_boards WHERE id=?", (duplicate_id,))


def _rename_duplicate_task_tags(conn: sqlite3.Connection) -> None:
    """Rename tags that collide inside one team (``name``, ``name (2)``, …).

    The legacy table is unique per ``(group_id, name)`` but round 8 is unique per
    ``(team_id, name)``: the first row of a name keeps its id, every later duplicate is
    renamed to the next free ``name (n)``. All current names of the team are pre-loaded so
    an already existing ``name (2)`` is never reused.
    """
    tables = _table_names(conn)
    if not {"groups", "task_tags"} <= tables:
        return
    tags = conn.execute(
        "SELECT t.id, t.name, g.team_id FROM task_tags t "
        "JOIN groups g ON g.id = t.group_id ORDER BY g.team_id, t.rowid"
    ).fetchall()
    used: dict[str, set[str]] = {}
    for tag in tags:
        used.setdefault(str(tag["team_id"]), set()).add(str(tag["name"] or ""))
    seen: dict[tuple[str, str], int] = {}
    for tag in tags:
        team_id = str(tag["team_id"])
        name = str(tag["name"] or "")
        key = (team_id, name)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] == 1:
            continue
        names = used.setdefault(team_id, set())
        base = name
        suffix = 2
        while f"{base} ({suffix})" in names:
            suffix += 1
        renamed = f"{base} ({suffix})"
        conn.execute("UPDATE task_tags SET name=? WHERE id=?", (renamed, str(tag["id"])))
        names.add(renamed)


def _rebuild_legacy_table(
    conn: sqlite3.Connection, table: str, old_columns: list[str]
) -> None:
    """Rebuild one legacy business table with ``group_id`` replaced by ``team_id``.

    The row ids (and therefore every cross-table reference) are preserved verbatim; only
    the removed ``group_id`` / ``members.status`` columns disappear.
    """
    temporary = f"{table}__round8"
    conn.execute(f'DROP TABLE IF EXISTS "{temporary}"')
    conn.execute(_create_table_sql(table, table_name=f'"{temporary}"', if_not_exists=False))

    orphan = conn.execute(
        f'SELECT COUNT(*) FROM "{table}" s '
        'LEFT JOIN "groups" g ON g.id = s.group_id '
        'LEFT JOIN "teams" t ON t.id = g.team_id '
        "WHERE g.id IS NULL OR t.id IS NULL"
    ).fetchone()[0]
    if orphan:
        raise RuntimeError(
            f"第 8 轮数据库迁移失败：表 {table} 有 {int(orphan)} 行引用了不存在的开发组/团队"
        )

    target_columns = _table_column_names(table)
    copy_columns = [
        column
        for column in target_columns
        if column != "team_id" and column in old_columns
    ]
    insert_columns = ", ".join(["team_id", *(f'"{column}"' for column in copy_columns)])
    select_columns = ", ".join(
        ["g.team_id", *(f's."{column}"' for column in copy_columns)]
    )
    conn.execute(
        f'INSERT INTO "{temporary}" ({insert_columns}) '
        f'SELECT {select_columns} FROM "{table}" s JOIN "groups" g ON g.id = s.group_id'
    )
    conn.execute(f'DROP TABLE "{table}"')
    conn.execute(f'ALTER TABLE "{temporary}" RENAME TO "{table}"')


def _migrate_legacy_users(conn: sqlite3.Connection, tables: set[str]) -> None:
    """Fold legacy ``group_admin`` accounts into ``team_admin`` + ``team_ids``."""
    if "users" not in tables:
        return
    columns = set(_columns(conn, "users"))
    if not columns:
        return
    group_teams: dict[str, str] = {}
    if "groups" in tables:
        group_teams = {
            str(found["id"]): str(found["team_id"])
            for found in conn.execute('SELECT id, team_id FROM "groups"')
        }
    has_group_ids = "group_ids" in columns
    for user in conn.execute('SELECT * FROM "users"').fetchall():
        current_role = str(user["role"] or "member")
        team_ids = {
            str(item)
            for item in (json_loads(user["team_ids"], []) if "team_ids" in columns else [])
            if str(item).strip()
        }
        if has_group_ids:
            for group_id in json_loads(user["group_ids"], []) or []:
                team_id = group_teams.get(str(group_id))
                if team_id:
                    team_ids.add(team_id)
        role = "team_admin" if current_role == "group_admin" else current_role
        if role not in ("member", "team_admin", "super"):
            role = "member"
        sorted_teams = sorted(team_ids)
        previous_teams = sorted(
            str(item)
            for item in (json_loads(user["team_ids"], []) if "team_ids" in columns else [])
        )
        if role != current_role or sorted_teams != previous_teams:
            if "team_ids" in columns:
                conn.execute(
                    'UPDATE "users" SET role=?, team_ids=?, updated_at=? WHERE id=?',
                    (role, json_dumps(sorted_teams), now_iso(), str(user["id"])),
                )
            else:  # pragma: no cover - extremely old schema without team scope
                conn.execute(
                    'UPDATE "users" SET role=?, updated_at=? WHERE id=?',
                    (role, now_iso(), str(user["id"])),
                )


def _migrate_round8(conn: sqlite3.Connection) -> None:
    """Rebuild a legacy groups database into the team-only round-8 layout.

    Runs as a single transaction with foreign keys temporarily disabled; any error rolls
    the whole migration back and re-raises so startup is blocked instead of leaving
    half-migrated data behind.
    """
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("BEGIN")
    try:
        tables = _table_names(conn)
        if "teams" not in tables or "groups" not in tables:
            raise RuntimeError("第 8 轮数据库迁移失败：旧库缺少 teams/groups 表")
        # Backfill the newest additive columns on the legacy tables first so the rebuild
        # copies the computed values instead of falling back to bare defaults.
        _run_additive_migrations(conn)
        conn.execute(_create_table_sql("app_meta"))
        _merge_duplicate_redblack_boards(conn)
        _rename_duplicate_task_tags(conn)
        for table in _LEGACY_BUSINESS_TABLES:
            if table not in tables or "group_id" not in _columns(conn, table):
                continue
            _rebuild_legacy_table(conn, table, _columns(conn, table))
        _migrate_legacy_users(conn, tables)
        # Nothing references ``groups`` any more: drop the orphan table for good.
        conn.execute("DROP TABLE IF EXISTS groups")
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            sample = [tuple(item) for item in violations[:5]]
            raise RuntimeError(f"第 8 轮数据库迁移后外键校验失败：{sample}")
        set_meta(conn, ROUND8_META_KEY, 1)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            conn.execute("PRAGMA foreign_keys=ON")
        except sqlite3.Error:  # pragma: no cover - connection already closing
            pass


def init_db() -> None:
    """Create the fresh schema or migrate a legacy database, then run safe cleanups."""
    conn = connect()
    try:
        if _is_legacy_groups_schema(conn):
            _migrate_round8(conn)
        conn.executescript(SCHEMA)
        _run_additive_migrations(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def row(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    found = conn.execute(sql, params).fetchone()
    return dict(found) if found else None


def scalar(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = (), default: Any = None) -> Any:
    found = conn.execute(sql, params).fetchone()
    if not found:
        return default
    return next(iter(dict(found).values()))


def log_audit(
    conn: sqlite3.Connection,
    actor: str,
    action: str,
    entity: str,
    entity_id: str = "",
    detail: Any = None,
) -> None:
    with _AUDIT_LOCK:
        conn.execute(
            "INSERT INTO audit_logs (id, actor, action, entity, entity_id, detail, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                new_id("audit"),
                actor,
                action,
                entity,
                entity_id,
                json_dumps(detail) if detail is not None else "",
                now_iso(),
            ),
        )


def set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json_dumps(value) if not isinstance(value, str) else value),
    )


def get_meta(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    raw = scalar(conn, "SELECT value FROM app_meta WHERE key=?", (key,))
    if raw is None:
        return default
    return json_loads(raw, raw)
