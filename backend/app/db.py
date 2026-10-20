"""SQLite storage helpers and schema."""

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


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#5865f2',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#5865f2',
    icon TEXT NOT NULL DEFAULT 'layers',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_team ON groups(team_id, sort_order);

CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '成员',
    avatar_color TEXT NOT NULL DEFAULT '#5865f2',
    bio TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'available',
    joined_at TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_members_external ON members(external_id);

CREATE TABLE IF NOT EXISTS works (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'current',
    period TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    progress INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_works_member ON works(member_id, status);

CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL,
    due_time TEXT NOT NULL DEFAULT '18:00',
    assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'todo',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_group_date ON todos(group_id, due_date);

CREATE TABLE IF NOT EXISTS member_tasks (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    progress_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(progress_status IN ('pending','in_progress','completed')),
    health_status TEXT NOT NULL DEFAULT 'normal'
        CHECK(health_status IN ('normal','delayed','blocked')),
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low','normal','high','urgent')),
    difficulty TEXT NOT NULL DEFAULT 'medium'
        CHECK(difficulty IN ('easy','medium','hard')),
    expected_date TEXT NOT NULL DEFAULT '',
    effort_hours REAL NOT NULL DEFAULT 8,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_member_tasks_group_member
    ON member_tasks(group_id, member_id, progress_status);

CREATE TABLE IF NOT EXISTS redblack_boards (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(group_id, month)
);

CREATE TABLE IF NOT EXISTS redblack_entries (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES redblack_boards(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK(side IN ('red','black')),
    member_id TEXT,
    member_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    score REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redblack_entries_board ON redblack_entries(board_id, side, sort_order);

CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '常用',
    color TEXT NOT NULL DEFAULT '#5865f2',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_group ON links(group_id, sort_order);

CREATE TABLE IF NOT EXISTS matrix_areas (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    area TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_member_id TEXT,
    backup_member_id TEXT,
    backup_member_ids TEXT NOT NULL DEFAULT '[]',
    channel TEXT NOT NULL DEFAULT '企业微信',
    contact TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matrix_group ON matrix_areas(group_id, sort_order);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'info',
    author_name TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_group ON announcements(group_id, pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS task_tags (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#5865f2',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(group_id, name)
);
CREATE INDEX IF NOT EXISTS idx_task_tags_group ON task_tags(group_id, name);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL DEFAULT '#5865f2',
    bio TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]',
    role TEXT NOT NULL DEFAULT 'member'
        CHECK(role IN ('member','group_admin','team_admin','super')),
    team_ids TEXT NOT NULL DEFAULT '[]',
    group_ids TEXT NOT NULL DEFAULT '[]',
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS email_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login',
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at TEXT,
    request_ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at DESC);

CREATE TABLE IF NOT EXISTS email_logs (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL DEFAULT '',
    todo_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'verification',
    recipient TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    entity TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


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
    by ``SCHEMA`` above.
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
    """Additive v5 migration: profile photo URL on group-scoped member records."""
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


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        _migrate_member_tasks(conn)
        _migrate_task_tags(conn)
        _migrate_matrix_backups(conn)
        _migrate_member_avatar(conn)
        _migrate_remove_email_reminders(conn)


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
