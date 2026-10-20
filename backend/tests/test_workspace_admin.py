"""Tests for the workspace administration API (team / development-group CRUD).

The ``client`` fixture from ``conftest.py`` connects through loopback, which makes every
request the device Admin. Other identities are simulated with
``app.dependency_overrides[get_current_user]``; the ``as_user`` fixture always removes the
override again. Child-row cascade assertions read the SQLite database directly.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Iterator

import pytest

from backend.app.auth import CurrentUser, get_current_user
from backend.app.db import DB_PATH, db
from backend.app.services import accounts

TEAM_ID = "team-aurora"
OTHER_TEAM_ID = "team-voyage"
GROUP_ID = "grp-frontend"
OTHER_GROUP_ID = "grp-data"
MEMBER_ID = "m-chen"
MEMBERS_BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/members"
MEMBER_URL = f"{MEMBERS_BASE}/{MEMBER_ID}"

CONFIRM_TEAM_MESSAGE = "请输入完整的团队名称以确认删除"
CONFIRM_GROUP_MESSAGE = "请输入完整的开发组名称以确认删除"
PERSONAL_INFO_MESSAGE = "个人信息仅超级管理员和本人可编辑"


# --------------------------------------------------------------------------- identities


def device_admin() -> CurrentUser:
    return CurrentUser(
        id="device-admin",
        name="Admin",
        authenticated=True,
        source="local",
        is_device_admin=True,
        admin_role="super",
    )


def team_admin(team_id: str = TEAM_ID, name: str = "团队管理员") -> CurrentUser:
    return CurrentUser(
        id="team-admin@corp.example",
        name=name,
        email="team-admin@corp.example",
        authenticated=True,
        source="sso",
        admin_role="team_admin",
        team_ids={team_id},
    )


def group_admin() -> CurrentUser:
    return CurrentUser(
        id="group-admin@corp.example",
        name="组管理员",
        email="group-admin@corp.example",
        authenticated=True,
        source="sso",
        admin_role="group_admin",
        group_ids={GROUP_ID},
    )


def linked_member() -> CurrentUser:
    return CurrentUser(
        id=f"{MEMBER_ID}@corp.example",
        name="陈屿",
        email=f"{MEMBER_ID}@corp.example",
        authenticated=True,
        source="sso",
        linked_member_id=MEMBER_ID,
        linked_member_name="陈屿",
    )


def guest() -> CurrentUser:
    return CurrentUser(id="guest", name="访客", authenticated=False, source="guest")


# --------------------------------------------------------------------------- fixtures / helpers


@pytest.fixture()
def as_user() -> Iterator[Any]:
    """Switch the authenticated identity of the shared ``client`` fixture."""
    from backend.app.main import app

    def _switch(user: CurrentUser) -> None:
        app.dependency_overrides[get_current_user] = lambda: user

    yield _switch
    app.dependency_overrides.pop(get_current_user, None)


def _query(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    conn = sqlite3.connect(DB_PATH)
    try:
        return [tuple(item) for item in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _scalar(sql: str, params: tuple[Any, ...] = ()) -> Any:
    found = _query(sql, params)
    return found[0][0] if found else None


def _audit_rows(action: str | None = None) -> list[tuple[Any, ...]]:
    if action is None:
        return _query(
            "SELECT actor, action, entity, entity_id, detail FROM audit_logs "
            "ORDER BY created_at, rowid"
        )
    return _query(
        "SELECT actor, action, entity, entity_id, detail FROM audit_logs "
        "WHERE action=? ORDER BY created_at, rowid",
        (action,),
    )


def _error(response) -> dict[str, Any]:
    body = response.json()
    assert body["ok"] is False, body
    return body["error"]


def _create_account(email: str, *, name: str = "", avatar: str = "") -> dict[str, Any]:
    """Register an account so a member profile can be created from it by ``userId``."""
    with db() as conn:
        account = accounts.create_user(
            conn, email=email, name=name, email_verified=True, created_by="test"
        )
        if avatar:
            account = accounts.update_user(conn, account["id"], avatar=avatar)
        return account


def _delete(client, path: str, confirm_name: str | None = None):
    """DELETE with an optional ``{confirmName}`` JSON body."""
    if confirm_name is None:
        return client.request("DELETE", path)
    return client.request("DELETE", path, json={"confirmName": confirm_name})


def _child_counts(group_ids: list[str]) -> dict[str, int]:
    placeholders = ",".join("?" for _ in group_ids)
    params = tuple(group_ids)
    tables = (
        "works",
        "todos",
        "member_tasks",
        "redblack_boards",
        "links",
        "matrix_areas",
        "announcements",
        "task_tags",
    )
    return {
        table: int(
            _scalar(
                f"SELECT COUNT(*) FROM {table} WHERE group_id IN ({placeholders})", params
            )
            or 0
        )
        for table in tables
    }


# --------------------------------------------------------------------------- GET /manage


def test_manage_payload_for_device_admin(client) -> None:
    response = client.get("/api/workspace/manage")
    assert response.status_code == 200
    data = response.json()["data"]

    assert data["permissions"] == {
        "canCreateTeam": True,
        "canCreateGroup": True,
        "canManageAnyTeam": True,
    }
    teams = data["teams"]
    # Ordered by sort_order, name: the two seeded teams.
    assert [team["id"] for team in teams] == [TEAM_ID, OTHER_TEAM_ID]

    aurora = teams[0]
    assert set(aurora) == {
        "id",
        "name",
        "shortName",
        "description",
        "color",
        "groupCount",
        "memberCount",
        "canDelete",
        "canCreateGroup",
        "groups",
    }
    assert aurora["name"] == "星港产品团队"
    assert aurora["shortName"] == "星港"
    assert aurora["color"] == "#5865f2"
    assert aurora["groupCount"] == 3
    assert aurora["memberCount"] == 12
    assert aurora["canDelete"] is True
    assert aurora["canCreateGroup"] is True
    # Groups ordered by sort_order, name; seeds use sort_order 1..3.
    assert [group["id"] for group in aurora["groups"]] == [
        "grp-frontend",
        "grp-platform",
        "grp-design",
    ]
    frontend = aurora["groups"][0]
    assert set(frontend) == {
        "id",
        "teamId",
        "name",
        "description",
        "color",
        "icon",
        "memberCount",
        "canDelete",
    }
    assert frontend["teamId"] == TEAM_ID
    assert frontend["name"] == "前端体验组"
    assert frontend["icon"] == "code"
    assert frontend["memberCount"] == 5
    assert frontend["canDelete"] is True

    voyage = teams[1]
    assert voyage["groupCount"] == 2
    assert voyage["memberCount"] == 6
    assert [group["id"] for group in voyage["groups"]] == ["grp-data", "grp-infra"]
    assert sum(team["groupCount"] for team in teams) == 5

    # The team-level memberCount is the sum of its groups' member counts.
    for team in teams:
        assert team["memberCount"] == sum(group["memberCount"] for group in team["groups"])


def test_manage_scopes_team_admin_to_own_teams(client, as_user) -> None:
    as_user(team_admin(TEAM_ID))
    response = client.get("/api/workspace/manage")
    assert response.status_code == 200
    data = response.json()["data"]
    assert [team["id"] for team in data["teams"]] == [TEAM_ID]
    team = data["teams"][0]
    assert team["canDelete"] is False  # only the device Admin deletes teams
    assert team["canCreateGroup"] is True
    assert all(group["canDelete"] is True for group in team["groups"])
    assert data["permissions"] == {
        "canCreateTeam": False,
        "canCreateGroup": True,
        "canManageAnyTeam": True,
    }

    as_user(team_admin(OTHER_TEAM_ID))
    data = client.get("/api/workspace/manage").json()["data"]
    assert [team["id"] for team in data["teams"]] == [OTHER_TEAM_ID]


def test_manage_forbidden_for_non_managers(client, as_user) -> None:
    for label, user in (
        ("group_admin", group_admin()),
        ("member", linked_member()),
        ("guest", guest()),
    ):
        as_user(user)
        response = client.get("/api/workspace/manage")
        assert response.status_code == 403, label
        error = _error(response)
        assert error["code"] == "not_admin", label


# --------------------------------------------------------------------------- POST /teams


def test_create_team_as_device_admin(client) -> None:
    max_sort_before = int(_scalar("SELECT COALESCE(MAX(sort_order), 0) FROM teams") or 0)
    response = client.post(
        "/api/workspace/teams",
        json={
            "name": "  云图产品团队  ",
            "shortName": "云图",
            "description": "面向数据可视化的新团队",
            "color": "#ABCDEF",
        },
    )
    assert response.status_code == 200
    team = response.json()["data"]["team"]
    assert team["id"].startswith("team-")
    assert team["name"] == "云图产品团队"  # trimmed
    assert team["shortName"] == "云图"
    assert team["description"] == "面向数据可视化的新团队"
    assert team["color"] == "#abcdef"
    assert team["groupCount"] == 0
    assert team["memberCount"] == 0
    assert team["groups"] == []
    assert team["canDelete"] is True
    assert team["canCreateGroup"] is True
    assert _scalar("SELECT sort_order FROM teams WHERE id=?", (team["id"],)) == max_sort_before + 1

    # Omitted optional fields fall back to the documented defaults.
    response = client.post("/api/workspace/teams", json={"name": "星港实验室"})
    assert response.status_code == 200
    defaulted = response.json()["data"]["team"]
    assert defaulted["shortName"] == "星港实验"  # first 4 characters
    assert defaulted["description"] == ""
    assert defaulted["color"] == "#5865f2"
    assert defaulted["groups"] == []

    # The nested manage payload orders the new teams after the seeded ones (sort_order).
    managed = client.get("/api/workspace/manage").json()["data"]["teams"]
    assert [item["id"] for item in managed][-2:] == [team["id"], defaulted["id"]]


def test_create_team_validation_duplicates_and_permissions(client, as_user) -> None:
    invalid_payloads = [
        {},
        {"name": ""},
        {"name": "   "},
        {"name": "长" * 41},
        {"name": "校验团队", "shortName": "长" * 13},
        {"name": "校验团队", "shortName": 123},
        {"name": "校验团队", "description": "长" * 121},
        {"name": "校验团队", "color": "purple"},
        {"name": "校验团队", "color": "#12345"},
    ]
    for payload in invalid_payloads:
        response = client.post("/api/workspace/teams", json=payload)
        assert response.status_code == 422, payload
        assert response.json()["ok"] is False
    assert _scalar("SELECT COUNT(*) FROM teams") == 2

    # Team names are not unique in the schema; duplicates create separate teams.
    first = client.post("/api/workspace/teams", json={"name": "重复团队"}).json()["data"]["team"]
    second = client.post("/api/workspace/teams", json={"name": "重复团队"}).json()["data"]["team"]
    assert first["id"] != second["id"]
    assert _scalar("SELECT COUNT(*) FROM teams WHERE name='重复团队'") == 2

    # Only the device Admin may create a team.
    for user in (team_admin(), group_admin(), linked_member(), guest()):
        as_user(user)
        response = client.post("/api/workspace/teams", json={"name": "越权创建团队"})
        assert response.status_code == 403
        assert _error(response)["code"] == "not_admin"


# --------------------------------------------------------------------------- DELETE /teams/{id}


def test_delete_team_requires_exact_name_and_cascades(client, as_user) -> None:
    # A team_admin cannot delete even its own team.
    as_user(team_admin(OTHER_TEAM_ID, "远航管理员"))
    response = _delete(client, f"/api/workspace/teams/{OTHER_TEAM_ID}", "远航数据团队")
    assert response.status_code == 403
    assert _error(response)["code"] == "not_admin"
    assert _scalar("SELECT COUNT(*) FROM teams") == 2

    as_user(device_admin())
    voyage_groups = [row[0] for row in _query("SELECT id FROM groups WHERE team_id=?", (OTHER_TEAM_ID,))]
    assert len(voyage_groups) == 2
    before = _child_counts(voyage_groups)
    assert before["works"] > 0 and before["todos"] > 0 and before["links"] > 0
    before_members = int(_scalar("SELECT COUNT(*) FROM members WHERE team_id=?", (OTHER_TEAM_ID,)) or 0)
    assert before_members == 6

    # Wrong typed name: 422 confirm_mismatch with the expected name; nothing deleted.
    response = _delete(client, f"/api/workspace/teams/{OTHER_TEAM_ID}", "远航")
    assert response.status_code == 422
    error = _error(response)
    assert error["code"] == "confirm_mismatch"
    assert error["message"] == CONFIRM_TEAM_MESSAGE
    assert error["details"] == {"expected": "远航数据团队"}
    assert _scalar("SELECT COUNT(*) FROM teams") == 2

    # Missing body behaves like an empty confirmation.
    response = _delete(client, f"/api/workspace/teams/{OTHER_TEAM_ID}")
    assert response.status_code == 422
    assert _error(response)["code"] == "confirm_mismatch"

    # Surrounding whitespace is tolerated; the exact name deletes the team.
    response = _delete(client, f"/api/workspace/teams/{OTHER_TEAM_ID}", "  远航数据团队\n")
    assert response.status_code == 200
    assert response.json()["data"] == {"deleted": True, "id": OTHER_TEAM_ID}

    # ON DELETE CASCADE cleared groups/members and every group-scoped table.
    assert _scalar("SELECT COUNT(*) FROM teams WHERE id=?", (OTHER_TEAM_ID,)) == 0
    assert _scalar("SELECT COUNT(*) FROM groups WHERE team_id=?", (OTHER_TEAM_ID,)) == 0
    assert _scalar("SELECT COUNT(*) FROM members WHERE team_id=?", (OTHER_TEAM_ID,)) == 0
    assert all(count == 0 for count in _child_counts(voyage_groups).values())
    # The untouched team and its data are intact.
    assert _scalar("SELECT COUNT(*) FROM teams") == 1
    assert _scalar("SELECT COUNT(*) FROM groups WHERE team_id=?", (TEAM_ID,)) == 3
    assert _scalar("SELECT COUNT(*) FROM members WHERE team_id=?", (TEAM_ID,)) == 12


def test_delete_unknown_team_returns_404(client, as_user) -> None:
    as_user(device_admin())
    response = _delete(client, "/api/workspace/teams/team-missing", "不存在")
    assert response.status_code == 404
    assert _error(response)["code"] == "team_not_found"


# --------------------------------------------------------------------------- team_admin groups


def test_team_admin_creates_and_deletes_groups_in_own_team(client, as_user) -> None:
    as_user(team_admin(TEAM_ID))
    max_sort_before = int(
        _scalar("SELECT COALESCE(MAX(sort_order), 0) FROM groups WHERE team_id=?", (TEAM_ID,)) or 0
    )
    response = client.post(
        f"/api/workspace/teams/{TEAM_ID}/groups",
        json={
            "name": "体验工程组",
            "description": "端到端体验与性能工程",
            "color": "#22C55E",
            "icon": "sparkles",
        },
    )
    assert response.status_code == 200
    group = response.json()["data"]["group"]
    assert group["id"].startswith("group-")
    assert group["teamId"] == TEAM_ID
    assert group["name"] == "体验工程组"
    assert group["description"] == "端到端体验与性能工程"
    assert group["color"] == "#22c55e"
    assert group["icon"] == "sparkles"
    assert group["memberCount"] == 0
    assert group["canDelete"] is True
    assert _scalar("SELECT sort_order FROM groups WHERE id=?", (group["id"],)) == max_sort_before + 1

    # Optional fields default to color #5865f2 and icon "layers".
    response = client.post(
        f"/api/workspace/teams/{TEAM_ID}/groups", json={"name": "平台工具组"}
    )
    defaulted = response.json()["data"]["group"]
    assert defaulted["color"] == "#5865f2"
    assert defaulted["icon"] == "layers"
    assert defaulted["description"] == ""

    # The new groups appear nested and count towards groupCount.
    managed = client.get("/api/workspace/manage").json()["data"]["teams"][0]
    assert managed["groupCount"] == 5
    assert [item["id"] for item in managed["groups"]][-2:] == [group["id"], defaulted["id"]]

    # Wrong typed name -> 422 confirm_mismatch, the group survives.
    path = f"/api/workspace/teams/{TEAM_ID}/groups/{group['id']}"
    response = _delete(client, path, "体验组")
    assert response.status_code == 422
    error = _error(response)
    assert error["code"] == "confirm_mismatch"
    assert error["message"] == CONFIRM_GROUP_MESSAGE
    assert error["details"] == {"expected": "体验工程组"}
    assert _scalar("SELECT COUNT(*) FROM groups WHERE id=?", (group["id"],)) == 1

    # Exact name deletes the group.
    response = _delete(client, path, "体验工程组")
    assert response.status_code == 200
    assert response.json()["data"] == {"deleted": True, "id": group["id"]}
    assert _scalar("SELECT COUNT(*) FROM groups WHERE id=?", (group["id"],)) == 0
    assert client.get("/api/workspace/manage").json()["data"]["teams"][0]["groupCount"] == 4


def test_team_admin_delete_group_cascades(client, as_user) -> None:
    as_user(team_admin(TEAM_ID))
    group_ids = ["grp-design"]
    before = _child_counts(group_ids)
    assert before["works"] > 0 and before["todos"] > 0 and before["matrix_areas"] > 0
    assert _scalar("SELECT COUNT(*) FROM members WHERE group_id='grp-design'") == 3

    response = _delete(client, f"/api/workspace/teams/{TEAM_ID}/groups/grp-design", "设计增长组")
    assert response.status_code == 200
    assert _scalar("SELECT COUNT(*) FROM groups WHERE id='grp-design'") == 0
    assert _scalar("SELECT COUNT(*) FROM members WHERE group_id='grp-design'") == 0
    assert all(count == 0 for count in _child_counts(group_ids).values())

    managed = client.get("/api/workspace/manage").json()["data"]["teams"][0]
    assert managed["groupCount"] == 2
    assert managed["memberCount"] == 9


def test_team_admin_cannot_manage_other_teams_or_teams(client, as_user) -> None:
    as_user(team_admin(TEAM_ID))
    # Groups of another team.
    response = client.post(
        f"/api/workspace/teams/{OTHER_TEAM_ID}/groups", json={"name": "越权开发组"}
    )
    assert response.status_code == 403
    assert _error(response)["code"] == "not_admin"

    response = _delete(
        client, f"/api/workspace/teams/{OTHER_TEAM_ID}/groups/{OTHER_GROUP_ID}", "数据智能组"
    )
    assert response.status_code == 403
    assert _error(response)["code"] == "not_admin"
    assert _scalar("SELECT COUNT(*) FROM groups WHERE id=?", (OTHER_GROUP_ID,)) == 1

    # Teams themselves.
    assert client.post("/api/workspace/teams", json={"name": "越权团队"}).status_code == 403
    response = _delete(client, f"/api/workspace/teams/{TEAM_ID}", "星港产品团队")
    assert response.status_code == 403


# --------------------------------------------------------------------------- role gates


def test_group_admin_member_and_guest_cannot_restructure_workspace(client, as_user) -> None:
    checks = [
        ("post", "/api/workspace/teams", {"name": "越权团队"}),
        (
            "delete",
            f"/api/workspace/teams/{TEAM_ID}",
            {"confirmName": "星港产品团队"},
        ),
        (
            "post",
            f"/api/workspace/teams/{TEAM_ID}/groups",
            {"name": "越权开发组"},
        ),
        (
            "delete",
            f"/api/workspace/teams/{TEAM_ID}/groups/{GROUP_ID}",
            {"confirmName": "前端体验组"},
        ),
    ]
    for user in (group_admin(), linked_member(), guest()):
        as_user(user)
        for method, path, payload in checks:
            response = client.request(method.upper(), path, json=payload)
            assert response.status_code == 403, (user.name, method, path)
            assert _error(response)["code"] == "not_admin", (user.name, method, path)
        assert client.get("/api/workspace/manage").status_code == 403
    # Nothing was created or deleted.
    assert _scalar("SELECT COUNT(*) FROM teams") == 2
    assert _scalar("SELECT COUNT(*) FROM groups") == 5


def test_unknown_team_and_group_return_404(client, as_user) -> None:
    as_user(device_admin())
    response = client.post("/api/workspace/teams/team-missing/groups", json={"name": "x"})
    assert response.status_code == 404
    assert _error(response)["code"] == "team_not_found"

    response = _delete(client, "/api/workspace/teams/team-missing/groups/grp-x", "x")
    assert response.status_code == 404
    assert _error(response)["code"] == "team_not_found"

    response = _delete(client, f"/api/workspace/teams/{TEAM_ID}/groups/grp-missing", "x")
    assert response.status_code == 404
    assert _error(response)["code"] == "group_not_found"

    # Unknown team raises 404 before the permission gate, even for a team_admin.
    as_user(team_admin())
    response = client.post("/api/workspace/teams/team-missing/groups", json={"name": "x"})
    assert response.status_code == 404
    assert _error(response)["code"] == "team_not_found"


# --------------------------------------------------------------------------- member personal info


def test_member_payload_exposes_avatar(client, as_user) -> None:
    as_user(device_admin())
    overview = client.get(
        f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/overview"
    ).json()["data"]
    assert overview["members"]
    assert all("avatar" in member for member in overview["members"])
    seeded = next(member for member in overview["members"] if member["id"] == MEMBER_ID)
    assert seeded["avatar"] == ""

    account = _create_account(
        "avatar.member@corp.example",
        name="头像成员",
        avatar="/uploads/avatars/member.png",
    )
    created = client.post(
        MEMBERS_BASE,
        json={"userId": account["id"]},
    ).json()["data"]["member"]
    assert created["avatar"] == "/uploads/avatars/member.png"
    assert created["name"] == "头像成员"
    assert (
        _scalar("SELECT avatar_url FROM members WHERE id=?", (created["id"],))
        == "/uploads/avatars/member.png"
    )
    # Reading the overview again shows the stored avatar.
    members = client.get(
        f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/overview"
    ).json()["data"]["members"]
    listed = next(member for member in members if member["id"] == created["id"])
    assert listed["avatar"] == "/uploads/avatars/member.png"


def test_organizational_admin_cannot_edit_member_personal_fields(client, as_user) -> None:
    personal_payloads = [
        {"name": "越权改名"},
        {"email": "hijack@corp.example"},
        {"bio": "越权简介"},
        {"avatarColor": "#123456"},
        {"tags": ["越权标签"]},
        {"skills": ["越权技能"]},
        {"avatar": "/uploads/avatars/hijack.png"},
        {"avatarUrl": "/uploads/avatars/hijack.png"},
    ]
    for user in (team_admin(TEAM_ID), group_admin()):
        as_user(user)
        for payload in personal_payloads:
            response = client.patch(MEMBER_URL, json=payload)
            assert response.status_code == 403, (user.name, payload)
            error = _error(response)
            assert error["code"] == "personal_info_forbidden", (user.name, payload)
            assert error["message"] == PERSONAL_INFO_MESSAGE
    # Rejected requests changed nothing.
    assert _scalar("SELECT name FROM members WHERE id=?", (MEMBER_ID,)) == "陈屿"
    assert _scalar("SELECT avatar_url FROM members WHERE id=?", (MEMBER_ID,)) == ""
    assert _scalar("SELECT email FROM members WHERE id=?", (MEMBER_ID,)) == "chen.yu@corp.example"

    # Organizational fields stay editable for an in-scope admin.
    for user in (team_admin(TEAM_ID), group_admin()):
        as_user(user)
        response = client.patch(
            MEMBER_URL,
            json={"title": "资深前端工程师", "role": "核心成员", "status": "busy"},
        )
        assert response.status_code == 200, user.name
        member = response.json()["data"]["member"]
        assert (member["title"], member["role"], member["status"]) == (
            "资深前端工程师",
            "核心成员",
            "busy",
        )


def test_self_and_super_edit_member_personal_fields_and_sync_account(client, as_user) -> None:
    as_user(linked_member())
    response = client.patch(
        MEMBER_URL,
        json={
            "name": "陈屿（本人）",
            "bio": "本人更新的简介",
            "avatarColor": "#111111",
            "tags": ["TypeScript", "日历"],
            "skills": ["性能优化"],
            "avatar": "/uploads/avatars/self.png",
        },
    )
    assert response.status_code == 200
    member = response.json()["data"]["member"]
    assert member["name"] == "陈屿（本人）"
    assert member["bio"] == "本人更新的简介"
    assert member["avatar"] == "/uploads/avatars/self.png"
    assert member["avatarColor"] == "#111111"
    assert member["skills"] == ["性能优化"]

    # Personal edits mirror onto the linked users row (matched by e-mail).
    account = _query("SELECT name, avatar, bio, skills FROM users WHERE id='chen.yu'")[0]
    assert account[0] == "陈屿（本人）"
    assert account[1] == "/uploads/avatars/self.png"
    assert account[2] == "本人更新的简介"
    assert json.loads(account[3]) == ["性能优化"]

    # An in-scope admin whose account e-mail matches the member counts as the owner.
    matching_admin = CurrentUser(
        id="chen.yu",
        name="陈屿",
        email="chen.yu@corp.example",
        authenticated=True,
        source="sso",
        admin_role="group_admin",
        group_ids={GROUP_ID},
    )
    as_user(matching_admin)
    assert client.patch(MEMBER_URL, json={"bio": "邮箱匹配本人"}).status_code == 200

    # A super administrator may also edit another member's personal fields.
    as_user(device_admin())
    response = client.patch(
        MEMBER_URL,
        json={"bio": "超级管理员更新的简介", "avatarUrl": "/uploads/avatars/super.png"},
    )
    assert response.status_code == 200
    member = response.json()["data"]["member"]
    assert member["bio"] == "超级管理员更新的简介"
    assert member["avatar"] == "/uploads/avatars/super.png"

    # Changing the member e-mail mirrors onto the previously linked account, never onto
    # the account that the new address would point at.
    su_account_before = _query("SELECT bio, avatar FROM users WHERE id='su.wan'")[0]
    as_user(linked_member())
    response = client.patch(
        MEMBER_URL, json={"email": "su.wan@corp.example", "bio": "重链接后的简介"}
    )
    assert response.status_code == 200
    assert response.json()["data"]["member"]["email"] == "su.wan@corp.example"
    assert _scalar("SELECT bio FROM users WHERE id='chen.yu'") == "重链接后的简介"
    assert _query("SELECT bio, avatar FROM users WHERE id='su.wan'")[0] == su_account_before


def test_workspace_scope_all_is_available_to_every_identity(client, as_user) -> None:
    overview_url = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}/overview"
    works_url = f"{MEMBERS_BASE}/{MEMBER_ID}/works"
    for user in (team_admin(TEAM_ID), group_admin(), linked_member()):
        as_user(user)
        for path in (overview_url, works_url):
            response = client.get(path, params={"scope": "all"})
            assert response.status_code == 200, (user.name, path)

    as_user(team_admin(TEAM_ID))
    assert client.get(overview_url, params={"scope": "team"}).status_code == 200
    as_user(device_admin())
    assert client.get(overview_url, params={"scope": "all"}).status_code == 200
    assert client.get(works_url, params={"scope": "all"}).status_code == 200


# --------------------------------------------------------------------------- audit


def test_workspace_writes_are_audited(client, as_user) -> None:
    as_user(device_admin())
    team = client.post("/api/workspace/teams", json={"name": "审计团队"}).json()["data"]["team"]
    group = client.post(
        f"/api/workspace/teams/{team['id']}/groups", json={"name": "审计开发组"}
    ).json()["data"]["group"]
    assert _delete(
        client, f"/api/workspace/teams/{team['id']}/groups/{group['id']}", "审计开发组"
    ).status_code == 200
    assert _delete(client, f"/api/workspace/teams/{team['id']}", "审计团队").status_code == 200

    expected = [
        ("team.create", "team", team["id"]),
        ("group.create", "group", group["id"]),
        ("group.delete", "group", group["id"]),
        ("team.delete", "team", team["id"]),
    ]
    rows = _audit_rows()
    recorded = {(actor, action, entity, entity_id) for actor, action, entity, entity_id, _ in rows}
    for action, entity, entity_id in expected:
        assert ("Admin", action, entity, entity_id) in recorded, action

    # team_admin group writes are audited under the admin's display name.
    as_user(team_admin(TEAM_ID, "星港管理员"))
    group = client.post(
        f"/api/workspace/teams/{TEAM_ID}/groups", json={"name": "审计组管理员创建"}
    ).json()["data"]["group"]
    audit_rows = _audit_rows("group.create")
    assert any(
        actor == "星港管理员" and entity == "group" and entity_id == group["id"]
        for actor, _action, entity, entity_id, _detail in audit_rows
    )
