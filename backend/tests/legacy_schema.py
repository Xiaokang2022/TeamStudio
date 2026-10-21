"""Pre-round-8 (development-group) SQLite schema used by the migration tests.

Copied verbatim from ``backend/app/db.py`` at git HEAD before the round-8 refactor so the
round-8 migration can be exercised against a realistic legacy database. Do not edit to
match the new schema: this *is* the old shape.
"""

from __future__ import annotations

LEGACY_SCHEMA = """
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

CREATE TABLE IF NOT EXISTS user_activation_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
);

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

STAMP = "2026-01-01T00:00:00+08:00"


def create_legacy_database(path) -> None:
    """Create a realistic pre-round-8 database with groups and cross-team data."""
    import sqlite3

    connection = sqlite3.connect(path)
    try:
        connection.executescript(LEGACY_SCHEMA)
        # The last pre-round-8 startup added the avatar column; real deployments have it.
        connection.execute(
            "ALTER TABLE members ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''"
        )
        teams = [
            ("team-a", "旧团队甲", "甲", "#5865f2", 1, STAMP),
            ("team-b", "旧团队乙", "乙", "#0ea5e9", 2, STAMP),
        ]
        connection.executemany(
            "INSERT INTO teams (id,name,short_name,color,sort_order,created_at) "
            "VALUES (?,?,?,?,?,?)",
            teams,
        )
        groups = [
            ("grp-1", "team-a", "甲组一", 1, STAMP),
            ("grp-2", "team-a", "甲组二", 2, STAMP),
            ("grp-3", "team-b", "乙组一", 1, STAMP),
        ]
        connection.executemany(
            "INSERT INTO groups (id,team_id,name,sort_order,created_at) VALUES (?,?,?,?,?)",
            groups,
        )
        members = [
            ("m-one", "team-a", "grp-1", "one@corp.example", "成员一", "前端", "available", 1),
            ("m-two", "team-a", "grp-2", "two@corp.example", "成员二", "后端", "busy", 2),
            ("m-three", "team-b", "grp-3", "three@corp.example", "成员三", "数据", "remote", 1),
        ]
        connection.executemany(
            "INSERT INTO members (id,team_id,group_id,email,name,title,status,sort_order,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(*member, STAMP, STAMP) for member in members],
        )
        connection.execute(
            "INSERT INTO works (id,member_id,group_id,title,status,progress,sort_order,"
            "created_at,updated_at) VALUES ('w-one','m-one','grp-1','旧工作项','current',40,0,?,?)",
            (STAMP, STAMP),
        )
        connection.execute(
            "INSERT INTO todos (id,group_id,title,due_date,assignee_member_id,created_at,"
            "updated_at) VALUES ('t-one','grp-1','旧待办','2026-02-01','m-one',?,?)",
            (STAMP, STAMP),
        )
        connection.execute(
            "INSERT INTO member_tasks (id,group_id,member_id,title,progress_status,"
            "priority,difficulty,created_at,updated_at) VALUES "
            "('mt-one','grp-1','m-one','旧任务','pending','high','hard',?,?)",
            (STAMP, STAMP),
        )
        # Two boards for the same team/month (from two groups) must be merged.
        connection.executemany(
            "INSERT INTO redblack_boards (id,group_id,month,theme,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            [
                ("board-early", "grp-1", "2026-02", "早主题", STAMP, STAMP),
                ("board-late", "grp-2", "2026-02", "晚主题", "2026-01-02T00:00:00+08:00", STAMP),
            ],
        )
        connection.executemany(
            "INSERT INTO redblack_entries (id,board_id,side,member_id,member_name,title,"
            "reason,score,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                ("entry-1", "board-early", "red", "m-one", "成员一", "红榜甲", "", 90, 0, STAMP),
                ("entry-2", "board-late", "red", "m-two", "成员二", "红榜乙", "", 80, 0, STAMP),
            ],
        )
        connection.execute(
            "INSERT INTO links (id,group_id,title,url,created_at,updated_at) "
            "VALUES ('l-one','grp-1','旧链接','https://example.com/legacy',?,?)",
            (STAMP, STAMP),
        )
        connection.execute(
            "INSERT INTO matrix_areas (id,group_id,area,owner_member_id,backup_member_ids,"
            "created_at,updated_at) VALUES ('area-one','grp-1','旧责任田','m-one','[\"m-two\"]',?,?)",
            (STAMP, STAMP),
        )
        connection.execute(
            "INSERT INTO announcements (id,group_id,title,content,pinned,created_at,updated_at) "
            "VALUES ('ann-one','grp-1','旧公告','内容',1,?,?)",
            (STAMP, STAMP),
        )
        # Same tag name in two groups of the same team must be renamed on merge.
        connection.executemany(
            "INSERT INTO task_tags (id,group_id,name,created_at,updated_at) VALUES (?,?,?,?,?)",
            [
                ("tag-one", "grp-1", "前端", STAMP, STAMP),
                ("tag-two", "grp-2", "前端", STAMP, STAMP),
                ("tag-three", "grp-3", "数据", STAMP, STAMP),
            ],
        )
        connection.executemany(
            "INSERT INTO users (id,email,name,role,team_ids,group_ids,email_verified,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            [
                (
                    "old.admin",
                    "old.admin@corp.example",
                    "旧组管理员",
                    "group_admin",
                    "[]",
                    '["grp-1","grp-3"]',
                    1,
                    STAMP,
                    STAMP,
                ),
                (
                    "old.member",
                    "old.member@corp.example",
                    "旧成员",
                    "member",
                    "[]",
                    '["grp-1"]',
                    1,
                    STAMP,
                    STAMP,
                ),
            ],
        )
        connection.commit()
    finally:
        connection.close()
