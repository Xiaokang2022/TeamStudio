"""Tests for responsibility-matrix multi-backup support (R3 + R4 backend).

One area has exactly one primary owner but any number of backups (capped at 10 in the
write payload). A member may own several areas and back up several others — the schema
must not enforce any member/area uniqueness. The legacy single ``backupMemberId`` API is
kept working as a one-element list, and the legacy DB column stays mirrored to the first
backup.
"""

from __future__ import annotations

import json

from backend.app.db import db, row

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}"
MATRIX_URL = f"{BASE}/matrix"
MEMBERS_URL = f"{BASE}/members"

# Seed members of grp-frontend with their avatar colours.
CHEN = {"id": "m-chen", "name": "陈屿", "color": "#2563eb"}
HE = {"id": "m-he", "name": "何川", "color": "#0891b2"}
SU = {"id": "m-su", "name": "苏晚", "color": "#db2777"}
LIN = {"id": "m-lin", "name": "林知夏", "color": "#7c3aed"}


def _data(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["data"]


def _create_account(
    email: str, *, name: str = "", avatar: str = "", color: str = "#5865f2"
) -> dict:
    """Register an account so members can be created from it by ``userId``."""
    from backend.app.services import accounts

    with db() as conn:
        account = accounts.create_user(
            conn, email=email, name=name, email_verified=True, created_by="test"
        )
        if avatar or color != "#5865f2":
            account = accounts.update_user(
                conn, account["id"], avatar=avatar, avatar_color=color
            )
        return account


def _create_area(client, **payload) -> dict:
    return _data(client.post(MATRIX_URL, json=payload))["area"]


def _list_areas(client, scope: str = "group") -> list[dict]:
    return _data(client.get(MATRIX_URL, params={"scope": scope}))["areas"]


def test_create_area_with_multiple_backups_and_legacy_projection(client):
    area = _create_area(
        client,
        area="多备份职责",
        description="验证多个备份与职责描述同时落库",
        ownerMemberId=LIN["id"],
        backupMemberIds=[CHEN["id"], HE["id"]],
        channel="飞书",
        contact="#multi-backup",
    )

    assert area["description"] == "验证多个备份与职责描述同时落库"
    assert area["backupMemberIds"] == [CHEN["id"], HE["id"]]
    assert area["backups"] == [CHEN, HE]
    # Legacy single-backup projection: the first backup, not a new primary.
    assert area["backupMemberId"] == CHEN["id"]
    assert area["backupName"] == CHEN["name"]
    assert area["backupColor"] == CHEN["color"]

    # Both the array and the legacy mirror column are persisted.
    with db() as conn:
        stored = row(
            conn,
            "SELECT backup_member_id, backup_member_ids FROM matrix_areas WHERE id=?",
            (area["id"],),
        )
    assert stored["backup_member_id"] == CHEN["id"]
    assert json.loads(stored["backup_member_ids"]) == [CHEN["id"], HE["id"]]

    # The list endpoint hydrates every backup name/colour in one pass.
    listed = next(item for item in _list_areas(client) if item["id"] == area["id"])
    assert listed["backups"] == [CHEN, HE]
    assert listed["backupMemberIds"] == [CHEN["id"], HE["id"]]


def test_same_member_may_own_and_back_up_several_areas(client):
    owned_a = _create_area(client, area="领域甲", ownerMemberId=CHEN["id"], backupMemberIds=[LIN["id"]])
    backed = _create_area(
        client, area="领域乙", ownerMemberId=SU["id"], backupMemberIds=[CHEN["id"], LIN["id"]]
    )
    owned_b = _create_area(client, area="领域丙", ownerMemberId=CHEN["id"], backupMemberIds=[])

    areas = _list_areas(client)
    owned_by_chen = {item["id"] for item in areas if item["ownerMemberId"] == CHEN["id"]}
    backed_by_chen = {item["id"] for item in areas if CHEN["id"] in item["backupMemberIds"]}

    # Seeded 协作日历 is owned by m-chen as well; nothing blocks the repetition.
    assert {"matrix-grp-frontend-1", owned_a["id"], owned_b["id"]} <= owned_by_chen
    assert len(owned_by_chen) >= 3
    # Seeded Web 工作台 / 实时通知 already back m-chen up; the new area adds another one.
    assert {"matrix-grp-frontend-0", "matrix-grp-frontend-3", backed["id"]} <= backed_by_chen
    assert len(backed_by_chen) >= 3

    # Aggregate scope still works and hydrates backups across groups (18 seeded areas + the
    # three created above).
    all_areas = _list_areas(client, scope="all")
    assert len(all_areas) == 21
    data_area = next(item for item in all_areas if item["id"] == "matrix-grp-data-0")
    assert [backup["name"] for backup in data_area["backups"]] == ["贾宁", "李沐"]
    for item in all_areas:
        assert isinstance(item["backupMemberIds"], list)
        assert [backup["id"] for backup in item["backups"]] == item["backupMemberIds"]


def test_owner_cannot_be_backup(client):
    response = client.post(
        MATRIX_URL,
        json={
            "area": "冲突职责",
            "ownerMemberId": LIN["id"],
            "backupMemberIds": [CHEN["id"], LIN["id"]],
        },
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "owner_is_backup"
    assert error["message"] == "负责人不能同时担任备份人"

    # The invariant is enforced on PATCH in both directions.
    area = _create_area(
        client, area="可编辑职责", ownerMemberId=LIN["id"], backupMemberIds=[CHEN["id"]]
    )
    response = client.patch(MATRIX_URL + f"/{area['id']}", json={"ownerMemberId": CHEN["id"]})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "owner_is_backup"

    response = client.patch(
        MATRIX_URL + f"/{area['id']}", json={"backupMemberIds": [CHEN["id"], LIN["id"]]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "owner_is_backup"

    # Patching the owner away first makes the same backup list legal.
    updated = _data(
        client.patch(MATRIX_URL + f"/{area['id']}", json={"ownerMemberId": SU["id"]})
    )["area"]
    assert updated["ownerMemberId"] == SU["id"]
    assert updated["backupMemberIds"] == [CHEN["id"]]


def test_unknown_or_cross_group_backup_member_is_rejected(client):
    for member_id in ("m-missing", "m-zhou"):  # m-zhou belongs to grp-platform
        response = client.post(
            MATRIX_URL,
            json={
                "area": "未知备份",
                "ownerMemberId": LIN["id"],
                "backupMemberIds": [member_id],
            },
        )
        assert response.status_code == 422, member_id
        error = response.json()["error"]
        assert error["code"] == "validation_error"
        assert "备份人" in error["message"]

    # A non-list payload is rejected as well.
    response = client.post(
        MATRIX_URL, json={"area": "错误类型", "backupMemberIds": CHEN["id"]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_backup_ids_are_deduped(client):
    area = _create_area(
        client,
        area="去重职责",
        ownerMemberId=LIN["id"],
        backupMemberIds=[CHEN["id"], CHEN["id"], HE["id"], CHEN["id"]],
    )
    assert area["backupMemberIds"] == [CHEN["id"], HE["id"]]
    assert area["backups"] == [CHEN, HE]


def _create_members(client, count: int) -> list[str]:
    ids = []
    for index in range(count):
        account = _create_account(
            f"backup.candidate{index}@corp.example", name=f"备份候选{index}"
        )
        member = _data(
            client.post(MEMBERS_URL, json={"userId": account["id"], "title": "成员"})
        )["member"]
        ids.append(member["id"])
    return ids


def test_backup_count_is_capped_at_ten(client):
    member_ids = _create_members(client, 11)
    response = client.post(
        MATRIX_URL,
        json={"area": "超过上限", "ownerMemberId": LIN["id"], "backupMemberIds": member_ids},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "too_many_backups"

    # Exactly ten (plus a duplicate that dedupes away) is accepted.
    area = _create_area(
        client,
        area="刚好上限",
        ownerMemberId=LIN["id"],
        backupMemberIds=member_ids[:10] + [member_ids[0]],
    )
    assert len(area["backupMemberIds"]) == 10
    assert area["backupMemberIds"] == member_ids[:10]
    assert len(area["backups"]) == 10


def test_patch_replaces_and_clears_backup_list(client):
    area = _create_area(
        client,
        area="替换备份",
        ownerMemberId=LIN["id"],
        backupMemberIds=[CHEN["id"], HE["id"]],
    )

    # Unrelated PATCH keeps the backups untouched.
    untouched = _data(client.patch(MATRIX_URL + f"/{area['id']}", json={"contact": "飞书群"}))[
        "area"
    ]
    assert untouched["backupMemberIds"] == [CHEN["id"], HE["id"]]

    replaced = _data(
        client.patch(MATRIX_URL + f"/{area['id']}", json={"backupMemberIds": [SU["id"]]})
    )["area"]
    assert replaced["backupMemberIds"] == [SU["id"]]
    assert replaced["backups"] == [SU]
    assert replaced["backupMemberId"] == SU["id"]
    assert replaced["backupName"] == SU["name"]

    cleared = _data(
        client.patch(MATRIX_URL + f"/{area['id']}", json={"backupMemberIds": []})
    )["area"]
    assert cleared["backupMemberIds"] == []
    assert cleared["backups"] == []
    assert cleared["backupMemberId"] is None
    assert cleared["backupName"] == ""
    assert cleared["backupColor"] == ""

    with db() as conn:
        stored = row(
            conn,
            "SELECT backup_member_id, backup_member_ids FROM matrix_areas WHERE id=?",
            (area["id"],),
        )
    assert stored["backup_member_id"] is None
    assert json.loads(stored["backup_member_ids"]) == []


def test_legacy_single_backup_payload_still_works(client):
    created = _create_area(
        client, area="旧版单备份", ownerMemberId=LIN["id"], backupMemberId=CHEN["id"]
    )
    assert created["backupMemberIds"] == [CHEN["id"]]
    assert created["backups"] == [CHEN]
    assert created["backupMemberId"] == CHEN["id"]

    # Legacy PATCH replaces the list; an empty legacy value clears it.
    replaced = _data(
        client.patch(MATRIX_URL + f"/{created['id']}", json={"backupMemberId": HE["id"]})
    )["area"]
    assert replaced["backupMemberIds"] == [HE["id"]]

    cleared = _data(
        client.patch(MATRIX_URL + f"/{created['id']}", json={"backupMemberId": ""})
    )["area"]
    assert cleared["backupMemberIds"] == []
    assert cleared["backupMemberId"] is None

    # When both are present the new field wins.
    both = _create_area(
        client,
        area="新旧同传",
        ownerMemberId=LIN["id"],
        backupMemberIds=[CHEN["id"], HE["id"]],
        backupMemberId=SU["id"],
    )
    assert both["backupMemberIds"] == [CHEN["id"], HE["id"]]


def test_member_deletion_prunes_every_backup_array(client):
    # m-chen is a backup of two seeded frontend areas and the owner of one.
    response = client.delete(f"{MEMBERS_URL}/m-chen")
    assert response.status_code == 200

    areas = {item["id"]: item for item in _list_areas(client)}
    web_workbench = areas["matrix-grp-frontend-0"]
    assert web_workbench["backupMemberIds"] == [HE["id"]]
    assert web_workbench["backups"] == [HE]
    assert web_workbench["backupMemberId"] == HE["id"]
    assert web_workbench["backupName"] == HE["name"]

    realtime = areas["matrix-grp-frontend-3"]
    assert realtime["backupMemberIds"] == [LIN["id"]]
    assert realtime["backupMemberId"] == LIN["id"]

    calendar = areas["matrix-grp-frontend-1"]
    assert calendar["ownerMemberId"] is None
    assert "m-chen" not in calendar["backupMemberIds"]

    for item in areas.values():
        assert "m-chen" not in item["backupMemberIds"]

    with db() as conn:
        stored = conn.execute(
            "SELECT backup_member_id, backup_member_ids FROM matrix_areas WHERE group_id=?",
            (GROUP_ID,),
        ).fetchall()
    for found in stored:
        assert found["backup_member_id"] != "m-chen"
        assert "m-chen" not in json.loads(found["backup_member_ids"])


# --------------------------------------------------------------------------- member profile rules


def test_backup_candidate_avatar_payload_and_personal_permissions(client) -> None:
    """Backup candidates are regular members: avatar payload + round-5 edit rules."""
    account = _create_account(
        "backup.candidate@corp.example",
        name="备份候选人",
        avatar="/uploads/avatars/candidate.png",
    )
    created = _data(
        client.post(MEMBERS_URL, json={"userId": account["id"]})
    )["member"]
    assert created["avatar"] == "/uploads/avatars/candidate.png"
    assert created["name"] == "备份候选人"

    area = _create_area(
        client, area="头像备份职责", ownerMemberId=LIN["id"], backupMemberIds=[created["id"]]
    )
    assert area["backupMemberIds"] == [created["id"]]
    assert area["backups"] == [{"id": created["id"], "name": "备份候选人", "color": "#5865f2"}]

    # A group admin can edit organizational fields of a member but not personal ones.
    from backend.app.auth import CurrentUser, get_current_user
    from backend.app.main import app

    group_admin = CurrentUser(
        id="group-admin@corp.example",
        name="组管理员",
        email="group-admin@corp.example",
        authenticated=True,
        source="sso",
        admin_role="group_admin",
        group_ids={GROUP_ID},
    )
    app.dependency_overrides[get_current_user] = lambda: group_admin
    try:
        response = client.patch(f"{MEMBERS_URL}/{LIN['id']}", json={"bio": "越权简介"})
        assert response.status_code == 403
        error = response.json()["error"]
        assert error["code"] == "personal_info_forbidden"
        assert error["message"] == "个人信息仅超级管理员和本人可编辑"

        updated = _data(
            client.patch(f"{MEMBERS_URL}/{LIN['id']}", json={"title": "前端负责人（更新）"})
        )["member"]
        assert updated["title"] == "前端负责人（更新）"
        assert updated["bio"] != "越权简介"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_matrix_backup_migration_backfills_legacy_rows_idempotently(tmp_path, monkeypatch):
    import backend.app.db as db_module

    monkeypatch.setattr(db_module, "DB_PATH", tmp_path / "migration.db")
    db_module.init_db()
    now = "2026-10-20T00:00:00+08:00"
    with db_module.db() as conn:
        conn.execute(
            "INSERT INTO teams (id,name,created_at) VALUES ('team-mig','迁移团队',?)", (now,)
        )
        conn.execute(
            "INSERT INTO groups (id,team_id,name,created_at) "
            "VALUES ('grp-mig','team-mig','迁移组',?)",
            (now,),
        )
        # Simulate a pre-v3 deployment: the array column does not exist yet.
        conn.execute("ALTER TABLE matrix_areas DROP COLUMN backup_member_ids")
        conn.execute(
            "INSERT INTO matrix_areas (id,group_id,area,backup_member_id,created_at,updated_at) "
            "VALUES ('area-legacy','grp-mig','旧职责','m-one',?,?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO matrix_areas (id,group_id,area,created_at,updated_at) "
            "VALUES ('area-none','grp-mig','无备份',?,?)",
            (now, now),
        )

    db_module.init_db()
    db_module.init_db()  # Re-running startup must be a no-op.

    with db_module.db() as conn:
        columns = {info[1] for info in conn.execute("PRAGMA table_info(matrix_areas)")}
        assert "backup_member_ids" in columns
        legacy = db_module.row(conn, "SELECT * FROM matrix_areas WHERE id='area-legacy'")
        assert json.loads(legacy["backup_member_ids"]) == ["m-one"]
        assert legacy["backup_member_id"] == "m-one"
        empty = db_module.row(conn, "SELECT * FROM matrix_areas WHERE id='area-none'")
        assert json.loads(empty["backup_member_ids"]) == []
        assert empty["backup_member_id"] is None

    # An empty-but-present array and an invalid array are both backfilled from the legacy
    # column, while an already-populated array is never overwritten.
    with db_module.db() as conn:
        conn.execute(
            "UPDATE matrix_areas SET backup_member_ids='[]' WHERE id='area-legacy'"
        )
        conn.execute(
            "INSERT INTO matrix_areas (id,group_id,area,backup_member_id,backup_member_ids,"
            "created_at,updated_at) VALUES ('area-bad','grp-mig','坏数据','m-two','not-json',?,?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO matrix_areas (id,group_id,area,backup_member_id,backup_member_ids,"
            "created_at,updated_at) VALUES ('area-multi','grp-mig','多备份','m-three',"
            "'[\"m-four\",\"m-five\"]',?,?)",
            (now, now),
        )
    db_module.init_db()

    with db_module.db() as conn:
        assert json.loads(
            db_module.row(conn, "SELECT * FROM matrix_areas WHERE id='area-legacy'")[
                "backup_member_ids"
            ]
        ) == ["m-one"]
        assert json.loads(
            db_module.row(conn, "SELECT * FROM matrix_areas WHERE id='area-bad'")[
                "backup_member_ids"
            ]
        ) == ["m-two"]
        multi = db_module.row(conn, "SELECT * FROM matrix_areas WHERE id='area-multi'")
        assert json.loads(multi["backup_member_ids"]) == ["m-four", "m-five"]
        assert multi["backup_member_id"] == "m-three"
