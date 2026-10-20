"""Member candidates and account-derived member creation (round 6 §1).

``GET /member-candidates`` lists registered accounts (pre-created but unverified ones
included) that have no member profile in the group yet. ``POST /members`` only selects
a person by ``userId``; every identity field is derived from the ``users`` row so custom
name / e-mail / id / avatar values in the payload are ignored.
"""

from __future__ import annotations

import json

import pytest

from backend.app.auth import CurrentUser, get_current_user
from backend.app.db import db, row
from backend.app.main import app
from backend.app.services import accounts

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}"
CANDIDATES_URL = f"{BASE}/member-candidates"
MEMBERS_URL = f"{BASE}/members"

# Seeded demo accounts that already own a member profile in grp-frontend.
GROUP_ACCOUNT_IDS = {"lin.zhixia", "chen.yu", "su.wan", "he.chuan", "tang.li"}


# --------------------------------------------------------------------------- helpers


def _data(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True, body
    return body["data"]


def _error(response) -> dict:
    body = response.json()
    assert body["ok"] is False, body
    return body["error"]


@pytest.fixture()
def as_user():
    """Switch the authenticated identity of the shared ``client`` fixture."""

    def _switch(user: CurrentUser) -> None:
        app.dependency_overrides[get_current_user] = lambda: user

    yield _switch
    app.dependency_overrides.pop(get_current_user, None)


def _guest() -> CurrentUser:
    return CurrentUser(id="guest", name="访客", authenticated=False, source="guest")


def _member() -> CurrentUser:
    return CurrentUser(
        id="lin.zhixia",
        name="林知夏",
        email="lin.zhixia@corp.example",
        authenticated=True,
        source="email",
        linked_member_id="m-lin",
    )


def _group_admin() -> CurrentUser:
    return CurrentUser(
        id="group-admin@corp.example",
        name="组管理员",
        email="group-admin@corp.example",
        authenticated=True,
        source="sso",
        admin_role="group_admin",
        group_ids={GROUP_ID},
    )


def _team_admin(team_id: str = TEAM_ID) -> CurrentUser:
    return CurrentUser(
        id="team-admin@corp.example",
        name="团队管理员",
        email="team-admin@corp.example",
        authenticated=True,
        source="sso",
        admin_role="team_admin",
        team_ids={team_id},
    )


def _create_account(
    email: str,
    *,
    name: str = "",
    role: str = "member",
    team_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
    email_verified: bool = True,
) -> dict:
    with db() as conn:
        return accounts.create_user(
            conn,
            email=email,
            name=name,
            role=role,
            team_ids=team_ids,
            group_ids=group_ids,
            email_verified=email_verified,
            created_by="test",
        )


# --------------------------------------------------------------------------- candidates


def test_member_candidates_lists_registered_accounts_outside_the_group(client):
    data = _data(client.get(CANDIDATES_URL))
    ids = [item["id"] for item in data["candidates"]]

    assert data["total"] == len(ids)
    assert len(ids) == len(set(ids))
    # Accounts that already own a member profile in this group are excluded.
    assert GROUP_ACCOUNT_IDS.isdisjoint(ids)
    # Verified accounts of other groups are valid candidates.
    assert "zhou.ye" in ids
    # The built-in device Admin is not a users row and can never be selected.
    assert "device-admin" not in ids

    payload = next(item for item in data["candidates"] if item["id"] == "zhou.ye")
    assert set(payload) == {
        "id",
        "name",
        "email",
        "avatar",
        "avatarColor",
        "role",
        "roleLabel",
        "emailVerified",
        "skills",
    }
    assert payload["name"] == "周野"
    assert payload["email"] == "zhou.ye@corp.example"
    assert payload["role"] == "member"
    assert payload["roleLabel"] == "成员"
    assert payload["emailVerified"] is True


def test_member_candidates_include_precreated_unverified_accounts(client):
    created = _data(
        client.post(
            "/api/users",
            json={"email": "pending.user@corp.example", "name": "待激活成员"},
        )
    )
    assert created["user"]["emailVerified"] is False

    data = _data(client.get(CANDIDATES_URL))
    entry = next(item for item in data["candidates"] if item["id"] == "pending.user")
    assert entry["name"] == "待激活成员"
    assert entry["emailVerified"] is False


def test_member_candidates_search_matches_name_email_and_id_case_insensitively(client):
    _create_account("search.target@corp.example", name="搜索目标")

    by_name = _data(client.get(CANDIDATES_URL, params={"search": "搜索"}))
    assert [item["id"] for item in by_name["candidates"]] == ["search.target"]

    by_email = _data(client.get(CANDIDATES_URL, params={"search": "SEARCH.TARGET@CORP"}))
    assert [item["id"] for item in by_email["candidates"]] == ["search.target"]

    by_id = _data(client.get(CANDIDATES_URL, params={"search": "search.TARGET"}))
    assert [item["id"] for item in by_id["candidates"]] == ["search.target"]

    empty = _data(client.get(CANDIDATES_URL, params={"search": "不存在的账号"}))
    assert empty == {"candidates": [], "total": 0}


def test_member_candidates_exclude_account_linked_by_external_id(client):
    account = _create_account("linked.by.id@corp.example", name="外部关联")
    # A legacy member row links the account by external_id only (its e-mail differs).
    with db() as conn:
        conn.execute(
            "INSERT INTO members (id,team_id,group_id,external_id,name,email,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                "m-external-link",
                TEAM_ID,
                GROUP_ID,
                account["id"],
                "外部关联",
                "legacy.link@corp.example",
                "2026-01-01T00:00:00+08:00",
                "2026-01-01T00:00:00+08:00",
            ),
        )

    ids = [item["id"] for item in _data(client.get(CANDIDATES_URL))["candidates"]]
    assert account["id"] not in ids


def test_member_candidates_require_in_scope_admin(client, as_user):
    as_user(_guest())
    response = client.get(CANDIDATES_URL)
    assert response.status_code == 401
    assert _error(response)["code"] == "authentication_required"

    as_user(_member())
    assert client.get(CANDIDATES_URL).status_code == 403

    as_user(_team_admin("team-voyage"))
    assert client.get(CANDIDATES_URL).status_code == 403

    as_user(_group_admin())
    assert client.get(CANDIDATES_URL).status_code == 200

    as_user(_team_admin())
    assert client.get(CANDIDATES_URL).status_code == 200


def test_member_candidates_unknown_group_returns_404(client):
    response = client.get(f"/api/teams/{TEAM_ID}/groups/grp-missing/member-candidates")
    assert response.status_code == 404
    assert _error(response)["code"] == "group_not_found"


# --------------------------------------------------------------------------- create member


def test_create_member_derives_identity_from_account(client):
    account = _create_account("derived.user@corp.example", name="派生成员")
    with db() as conn:
        account = accounts.update_user(
            conn,
            account["id"],
            avatar="/uploads/avatars/derived.png",
            avatar_color="#123456",
            bio="账号简介",
            skills=["Rust", "测试"],
        )

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
            "status": "busy",
            "sortOrder": 42,
        },
    )
    assert response.status_code == 200, response.text
    member = response.json()["data"]["member"]

    assert member["id"].startswith("member-")
    assert member["id"] != "m-hijack"
    assert member["name"] == "派生成员"
    assert member["email"] == "derived.user@corp.example"
    assert member["avatar"] == "/uploads/avatars/derived.png"
    assert member["avatarColor"] == "#123456"
    assert member["bio"] == "账号简介"
    assert member["skills"] == ["Rust", "测试"]
    assert member["tags"] == []
    # Organizational fields stay settable.
    assert member["title"] == "测试工程师"
    assert member["role"] == "核心成员"
    assert member["status"] == "busy"

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
    account = _create_account("email.lookup@corp.example", name="邮箱定位")

    created = _data(
        client.post(MEMBERS_URL, json={"userId": "EMAIL.LOOKUP@corp.example"})
    )["member"]
    assert created["name"] == "邮箱定位"
    assert created["email"] == "email.lookup@corp.example"

    by_id = client.post(MEMBERS_URL, json={"userId": account["id"]})
    assert by_id.status_code == 409
    assert _error(by_id)["code"] == "member_exists"
    assert "当前开发组" in _error(by_id)["message"]

    by_email = client.post(MEMBERS_URL, json={"userId": "email.lookup@corp.example"})
    assert by_email.status_code == 409
    assert _error(by_email)["code"] == "member_exists"


def test_create_member_validation_and_missing_account_errors(client):
    missing = client.post(MEMBERS_URL, json={})
    assert missing.status_code == 422
    assert _error(missing)["code"] == "validation_error"

    empty = client.post(MEMBERS_URL, json={"userId": "   "})
    assert empty.status_code == 422
    assert _error(empty)["code"] == "validation_error"

    unknown = client.post(MEMBERS_URL, json={"userId": "ghost.account"})
    assert unknown.status_code == 404
    assert _error(unknown)["code"] == "user_not_found"

    # The built-in device Admin is not a users row: it can never join a group.
    device_admin = client.post(MEMBERS_URL, json={"userId": "device-admin"})
    assert device_admin.status_code == 404
    assert _error(device_admin)["code"] == "user_not_found"

    # Seeded account that already owns a member profile in this group.
    existing = client.post(MEMBERS_URL, json={"userId": "lin.zhixia"})
    assert existing.status_code == 409
    assert _error(existing)["code"] == "member_exists"


def test_create_member_requires_in_scope_admin(client, as_user):
    account = _create_account("permission.target@corp.example", name="权限目标")

    as_user(_guest())
    assert client.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 401

    as_user(_member())
    assert client.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 403

    as_user(_team_admin("team-voyage"))
    assert client.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 403

    as_user(_group_admin())
    assert client.post(MEMBERS_URL, json={"userId": account["id"]}).status_code == 200
