"""Member candidates and account-derived member creation (round 8: team scoped).

``GET /api/teams/{team_id}/member-candidates`` lists accounts that have no member profile
in *that team*. ``POST /members`` only selects a person by ``userId``; identity fields
(name/e-mail/id/avatar/bio/skills) are derived from the account row and payload overrides
are ignored.
"""

from __future__ import annotations

import json

from backend.app.db import db, row
from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    assert_error,
    create_account,
    data,
    data as _data,
    email_login,
    error,
    ip_admin,
    member_by_email,
    remote_client,
    upload_avatar,
)

CANDIDATES_URL = f"/api/teams/{TEAM_AURORA}/member-candidates"
MEMBERS_URL = f"/api/teams/{TEAM_AURORA}/members"

# Seeded demo accounts that already own an archive row in team-aurora.
AURORA_ACCOUNT_IDS = {
    "lin.zhixia",
    "chen.yu",
    "su.wan",
    "he.chuan",
    "tang.li",
    "zhou.ye",
    "wu.qi",
    "xu.cheng",
    "luo.yi",
    "yu.an",
    "qin.ke",
    "shen.mo",
}
VOYAGE_ACCOUNT_IDS = {"gu.xing", "li.mu", "fang.jue", "jia.ning", "pei.ran", "han.xiao"}


# --------------------------------------------------------------------------- candidates


def test_candidates_list_accounts_outside_the_team(client):
    payload = data(client.get(CANDIDATES_URL))
    ids = [item["id"] for item in payload["candidates"]]
    assert payload["total"] == len(ids)
    assert len(ids) == len(set(ids))
    assert AURORA_ACCOUNT_IDS.isdisjoint(ids)
    assert VOYAGE_ACCOUNT_IDS <= set(ids)
    # The built-in device Admin is not a users row and can never be selected.
    assert "device-admin" not in ids

    other = next(item for item in payload["candidates"] if item["id"] == "gu.xing")
    for key in (
        "id",
        "name",
        "email",
        "avatar",
        "avatarColor",
        "role",
        "roleLabel",
        "emailVerified",
        "skills",
    ):
        assert key in other, key
    assert other["name"] == "顾行"
    assert other["email"] == "gu.xing@corp.example"
    assert other["role"] == "member"
    assert other["roleLabel"] == "成员"
    assert other["emailVerified"] is True
    assert "groupId" not in other
    assert "groupIds" not in other


def test_candidates_include_precreated_unverified_accounts(client):
    created = create_account(client, "pending.user@corp.example", name="待激活成员")
    assert created["emailVerified"] is False

    payload = data(client.get(CANDIDATES_URL))
    entry = next(item for item in payload["candidates"] if item["id"] == "pending.user")
    assert entry["name"] == "待激活成员"
    assert entry["emailVerified"] is False


def test_candidates_search_matches_name_email_and_id_case_insensitively(client):
    create_account(client, "search.target@corp.example", name="搜索目标")

    by_name = data(client.get(CANDIDATES_URL, params={"search": "搜索"}))
    assert [item["id"] for item in by_name["candidates"]] == ["search.target"]

    by_email = data(client.get(CANDIDATES_URL, params={"search": "SEARCH.TARGET@CORP"}))
    assert [item["id"] for item in by_email["candidates"]] == ["search.target"]

    by_id = data(client.get(CANDIDATES_URL, params={"search": "search.TARGET"}))
    assert [item["id"] for item in by_id["candidates"]] == ["search.target"]

    empty = data(client.get(CANDIDATES_URL, params={"search": "不存在的账号"}))
    assert empty == {"candidates": [], "total": 0}


def test_candidates_exclude_account_linked_by_external_id(client):
    account = create_account(client, "linked.by.id@corp.example", name="外部关联")
    with db() as conn:
        conn.execute(
            "INSERT INTO members (id,team_id,external_id,name,email,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                "m-external-link",
                TEAM_AURORA,
                account["id"],
                "外部关联",
                "legacy.link@corp.example",
                "2026-01-01T00:00:00+08:00",
                "2026-01-01T00:00:00+08:00",
            ),
        )
    ids = [item["id"] for item in data(client.get(CANDIDATES_URL))["candidates"]]
    assert account["id"] not in ids


def test_candidates_require_in_scope_admin(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.104", 51604) as guest:
        assert guest.get(CANDIDATES_URL).status_code == 401

    with remote_client("10.20.30.105", 51605) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert browser.get(CANDIDATES_URL).status_code == 403

    with ip_admin(TEAM_VOYAGE, ip="10.91.2.10", port=51606) as voyage_admin:
        assert voyage_admin.get(CANDIDATES_URL).status_code == 403

    with ip_admin(TEAM_AURORA, ip="10.91.2.11", port=51607) as aurora_admin:
        assert aurora_admin.get(CANDIDATES_URL).status_code == 200


def test_candidates_unknown_team_returns_404(client):
    response = client.get("/api/teams/team-missing/member-candidates")
    assert_error(response, 404, "team_not_found")


# --------------------------------------------------------------------------- create member


def test_create_member_derives_identity_from_account(client, monkeypatch):
    account = create_account(client, "derived.user@corp.example", name="派生成员")
    avatar_url = ""
    with remote_client("10.20.30.106", 51608) as browser:
        email_login(browser, "derived.user@corp.example", monkeypatch)
        avatar_url = upload_avatar(browser)

    response = client.post(
        MEMBERS_URL,
        json={
            "userId": account["id"],
            # Every custom identity field below must be ignored.
            "name": "自定义姓名",
            "email": "hijack@corp.example",
            "id": "m-hijack",
            "avatar": "/uploads/avatars/hijack.png",
            "avatarColor": "#000000",
            "bio": "自定义简介",
            "skills": ["Python"],
            "tags": ["自定义"],
            "title": "测试工程师",
            "role": "核心成员",
            "sortOrder": 42,
        },
    )
    assert response.status_code == 200, response.text
    member = _data(response)["member"]

    assert member["id"] != "m-hijack"
    assert member["name"] == "派生成员"
    assert member["email"] == "derived.user@corp.example"
    assert member["avatar"] == avatar_url
    assert member["avatarColor"] != "#000000"
    assert member["bio"] != "自定义简介"
    assert member["skills"] != ["Python"]
    assert member["tags"] == []
    assert "status" not in member
    # Organizational fields stay settable.
    assert member["title"] == "测试工程师"
    assert member["role"] == "核心成员"

    with db() as conn:
        stored = row(
            conn,
            "SELECT external_id, sort_order, tags FROM members WHERE id=?",
            (member["id"],),
        )
        audit = row(
            conn,
            "SELECT detail FROM audit_logs WHERE action='member.create' AND entity_id=?",
            (member["id"],),
        )
    assert stored["external_id"] == "derived.user"
    assert stored["sort_order"] == 42
    assert json.loads(stored["tags"]) == []
    assert audit is not None
    assert json.loads(audit["detail"])["userId"] == "derived.user"


def test_create_member_accepts_email_and_rejects_duplicates(client):
    account = create_account(client, "email.lookup@corp.example", name="邮箱定位")

    created = data(client.post(MEMBERS_URL, json={"userId": "EMAIL.LOOKUP@corp.example"}))[
        "member"
    ]
    assert created["name"] == "邮箱定位"
    assert created["email"] == "email.lookup@corp.example"

    by_id = client.post(MEMBERS_URL, json={"userId": account["id"]})
    assert_error(by_id, 409, "member_exists")
    assert "开发组" not in error(by_id)["message"]

    by_email = client.post(MEMBERS_URL, json={"userId": "email.lookup@corp.example"})
    assert_error(by_email, 409, "member_exists")


def test_create_member_validation_and_missing_account_errors(client):
    missing = client.post(MEMBERS_URL, json={})
    assert_error(missing, 422, "validation_error")
    empty = client.post(MEMBERS_URL, json={"userId": "   "})
    assert_error(empty, 422, "validation_error")
    unknown = client.post(MEMBERS_URL, json={"userId": "ghost.account"})
    assert_error(unknown, 404, "user_not_found")

    device_admin = client.post(MEMBERS_URL, json={"userId": "device-admin"})
    assert_error(device_admin, 404, "user_not_found")

    # A seeded account already owns an archive row in this team.
    existing = client.post(MEMBERS_URL, json={"userId": "lin.zhixia"})
    assert_error(existing, 409, "member_exists")


def test_create_member_requires_in_scope_admin(client, monkeypatch):
    account = create_account(client, "permission.target@corp.example", name="权限目标")
    chen = member_by_email(client, "chen.yu@corp.example")

    with remote_client("10.20.30.107", 51609) as guest:
        assert guest.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 401

    with remote_client("10.20.30.108", 51610) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert browser.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 403

    with ip_admin(TEAM_VOYAGE, ip="10.91.3.10", port=51611) as voyage_admin:
        assert voyage_admin.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 403

    with ip_admin(TEAM_AURORA, ip="10.91.3.11", port=51612) as aurora_admin:
        assert aurora_admin.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 200
