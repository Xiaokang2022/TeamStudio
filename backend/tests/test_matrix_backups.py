"""Responsibility-matrix multi-backup support (round 8: team scoped, avatars required).

One area has one owner and up to ten backups. The legacy single ``backupMemberId`` payload
still works as a one-element list, the legacy DB column mirrors the first backup, and every
backup element now exposes ``{id, name, color, avatar}``.
"""

from __future__ import annotations

import json

from backend.app.db import db, row
from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    create_account,
    create_member,
    data,
    email_login,
    error,
    member_by_email,
    members_of,
    remote_client,
)

MATRIX_URL = f"/api/teams/{TEAM_AURORA}/matrix"
MEMBERS_URL = f"/api/teams/{TEAM_AURORA}/members"


def _member(client, email: str) -> dict:
    member = member_by_email(client, email)
    return {"id": member["id"], "name": member["name"], "color": member["avatarColor"]}


def _create_area(client, **payload) -> dict:
    return data(client.post(MATRIX_URL, json=payload))["area"]


def _list_areas(client) -> list[dict]:
    return data(client.get(MATRIX_URL))["areas"]


def test_create_area_with_multiple_backups_and_legacy_projection(client):
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    he = _member(client, "he.chuan@corp.example")

    area = _create_area(
        client,
        area="多备份职责",
        description="验证多个备份与职责描述同时落库",
        ownerMemberId=lin["id"],
        backupMemberIds=[chen["id"], he["id"]],
        channel="飞书",
        contact="#multi-backup",
    )

    assert area["description"] == "验证多个备份与职责描述同时落库"
    assert area["backupMemberIds"] == [chen["id"], he["id"]]
    assert [backup["id"] for backup in area["backups"]] == [chen["id"], he["id"]]
    for backup in area["backups"]:
        assert set(backup) == {"id", "name", "color", "avatar"}
    # Legacy single-backup projection: the first backup, not a new primary.
    assert area["backupMemberId"] == chen["id"]
    assert area["backupName"] == chen["name"]
    assert area["backupColor"] == chen["color"]
    assert "backupAvatar" in area
    assert "ownerAvatar" in area
    assert "groupId" not in area

    with db() as conn:
        stored = row(
            conn,
            "SELECT backup_member_id, backup_member_ids FROM matrix_areas WHERE id=?",
            (area["id"],),
        )
    assert stored["backup_member_id"] == chen["id"]
    assert json.loads(stored["backup_member_ids"]) == [chen["id"], he["id"]]

    listed = next(item for item in _list_areas(client) if item["id"] == area["id"])
    assert [backup["id"] for backup in listed["backups"]] == [chen["id"], he["id"]]


def test_same_member_may_own_and_back_up_several_areas(client):
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    su = _member(client, "su.wan@corp.example")

    owned_a = _create_area(client, area="领域甲", ownerMemberId=chen["id"], backupMemberIds=[lin["id"]])
    backed = _create_area(
        client, area="领域乙", ownerMemberId=su["id"], backupMemberIds=[chen["id"], lin["id"]]
    )
    owned_b = _create_area(client, area="领域丙", ownerMemberId=chen["id"], backupMemberIds=[])

    areas = _list_areas(client)
    owned_by_chen = {item["id"] for item in areas if item["ownerMemberId"] == chen["id"]}
    backed_by_chen = {item["id"] for item in areas if chen["id"] in item["backupMemberIds"]}
    assert {owned_a["id"], owned_b["id"]} <= owned_by_chen
    assert {backed["id"]} <= backed_by_chen


def test_owner_cannot_be_backup(client):
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    su = _member(client, "su.wan@corp.example")

    response = client.post(
        MATRIX_URL,
        json={
            "area": "冲突职责",
            "ownerMemberId": lin["id"],
            "backupMemberIds": [chen["id"], lin["id"]],
        },
    )
    assert response.status_code == 422
    assert error(response)["code"] == "owner_is_backup"

    area = _create_area(
        client, area="可编辑职责", ownerMemberId=lin["id"], backupMemberIds=[chen["id"]]
    )
    assert (
        client.patch(
            f"{MATRIX_URL}/{area['id']}", json={"ownerMemberId": chen["id"]}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"{MATRIX_URL}/{area['id']}",
            json={"backupMemberIds": [chen["id"], lin["id"]]},
        ).status_code
        == 422
    )
    updated = data(
        client.patch(f"{MATRIX_URL}/{area['id']}", json={"ownerMemberId": su["id"]})
    )["area"]
    assert updated["ownerMemberId"] == su["id"]


def test_unknown_or_cross_team_backup_member_is_rejected(client):
    lin = _member(client, "lin.zhixia@corp.example")
    voyage_member = members_of(client, TEAM_VOYAGE)[0]
    for member_id in ("m-missing", voyage_member["id"]):
        response = client.post(
            MATRIX_URL,
            json={
                "area": "未知备份",
                "ownerMemberId": lin["id"],
                "backupMemberIds": [member_id],
            },
        )
        assert response.status_code == 422, member_id
        assert error(response)["code"] == "validation_error"

    response = client.post(
        MATRIX_URL, json={"area": "错误类型", "backupMemberIds": lin["id"]}
    )
    assert response.status_code == 422
    assert error(response)["code"] == "validation_error"


def test_backup_ids_are_deduped(client):
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    he = _member(client, "he.chuan@corp.example")
    area = _create_area(
        client,
        area="去重职责",
        ownerMemberId=lin["id"],
        backupMemberIds=[chen["id"], chen["id"], he["id"], chen["id"]],
    )
    assert area["backupMemberIds"] == [chen["id"], he["id"]]
    assert [backup["id"] for backup in area["backups"]] == [chen["id"], he["id"]]


def _create_members(client, count: int) -> list[str]:
    ids = []
    for index in range(count):
        account = create_account(
            client, f"backup.candidate{index}@corp.example", name=f"备份候选{index}"
        )
        member = create_member(client, account["id"], title="成员")
        ids.append(member["id"])
    return ids


def test_backup_count_is_capped_at_ten(client):
    lin = _member(client, "lin.zhixia@corp.example")
    member_ids = _create_members(client, 11)
    response = client.post(
        MATRIX_URL,
        json={"area": "超过上限", "ownerMemberId": lin["id"], "backupMemberIds": member_ids},
    )
    assert response.status_code == 422
    assert error(response)["code"] == "too_many_backups"

    area = _create_area(
        client,
        area="刚好上限",
        ownerMemberId=lin["id"],
        backupMemberIds=member_ids[:10] + [member_ids[0]],
    )
    assert area["backupMemberIds"] == member_ids[:10]
    assert len(area["backups"]) == 10


def test_patch_replaces_and_clears_backup_list(client):
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    he = _member(client, "he.chuan@corp.example")
    su = _member(client, "su.wan@corp.example")
    area = _create_area(
        client, area="替换备份", ownerMemberId=lin["id"], backupMemberIds=[chen["id"], he["id"]]
    )

    untouched = data(
        client.patch(f"{MATRIX_URL}/{area['id']}", json={"contact": "飞书群"})
    )["area"]
    assert untouched["backupMemberIds"] == [chen["id"], he["id"]]

    replaced = data(
        client.patch(f"{MATRIX_URL}/{area['id']}", json={"backupMemberIds": [su["id"]]})
    )["area"]
    assert replaced["backupMemberIds"] == [su["id"]]
    assert [backup["id"] for backup in replaced["backups"]] == [su["id"]]
    assert replaced["backupMemberId"] == su["id"]

    cleared = data(
        client.patch(f"{MATRIX_URL}/{area['id']}", json={"backupMemberIds": []})
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
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    he = _member(client, "he.chuan@corp.example")
    su = _member(client, "su.wan@corp.example")

    created = _create_area(
        client, area="旧版单备份", ownerMemberId=lin["id"], backupMemberId=chen["id"]
    )
    assert created["backupMemberIds"] == [chen["id"]]

    replaced = data(
        client.patch(f"{MATRIX_URL}/{created['id']}", json={"backupMemberId": he["id"]})
    )["area"]
    assert replaced["backupMemberIds"] == [he["id"]]

    cleared = data(
        client.patch(f"{MATRIX_URL}/{created['id']}", json={"backupMemberId": ""})
    )["area"]
    assert cleared["backupMemberIds"] == []

    both = _create_area(
        client,
        area="新旧同传",
        ownerMemberId=lin["id"],
        backupMemberIds=[chen["id"], he["id"]],
        backupMemberId=su["id"],
    )
    assert both["backupMemberIds"] == [chen["id"], he["id"]]


def test_member_deletion_prunes_every_backup_array(client):
    lin = _member(client, "lin.zhixia@corp.example")
    chen = _member(client, "chen.yu@corp.example")
    he = _member(client, "he.chuan@corp.example")

    first = _create_area(
        client, area="备份裁剪甲", ownerMemberId=lin["id"], backupMemberIds=[chen["id"], he["id"]]
    )
    second = _create_area(
        client, area="备份裁剪乙", ownerMemberId=chen["id"], backupMemberIds=[lin["id"]]
    )
    assert data(client.delete(f"{MEMBERS_URL}/{chen['id']}"))["deleted"] is True

    areas = {item["id"]: item for item in _list_areas(client)}
    pruned = areas[first["id"]]
    assert pruned["backupMemberIds"] == [he["id"]]
    assert pruned["backupMemberId"] == he["id"]
    # The deleted member was the owner of the second area.
    assert areas[second["id"]]["ownerMemberId"] is None
    for item in areas.values():
        assert chen["id"] not in item["backupMemberIds"]


def test_plain_member_cannot_write_matrix(client, monkeypatch):
    chen = _member(client, "chen.yu@corp.example")
    lin = _member(client, "lin.zhixia@corp.example")
    with remote_client("10.20.30.103", 51603) as browser:
        email_login(browser, "chen.yu@corp.example", monkeypatch)
        response = browser.post(
            MATRIX_URL,
            json={"area": "成员越权", "ownerMemberId": chen["id"], "backupMemberIds": []},
        )
        assert response.status_code == 403
        assert (
            browser.patch(f"{MATRIX_URL}/matrix-missing", json={"ownerMemberId": lin["id"]}).status_code
            in (403, 404)
        )
