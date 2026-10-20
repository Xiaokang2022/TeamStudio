"""User administration API and personal home page (profile)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.auth import SessionIdentity, create_session_token
from backend.app.db import db
from backend.app.main import app
from backend.app.services import accounts

PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _create_account(
    email: str,
    *,
    name: str = "",
    role: str = "member",
    team_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
) -> dict:
    with db() as conn:
        return accounts.create_user(
            conn,
            email=email,
            name=name,
            role=role,
            team_ids=team_ids,
            group_ids=group_ids,
            email_verified=True,
            created_by="test",
        )


def _sign_in(client: TestClient, user_id: str, email: str, provider: str = "email") -> None:
    token = create_session_token(
        SessionIdentity(id=user_id, name=user_id, email=email, provider=provider), 7
    )
    client.cookies.set("teamstudio_session", token)


def test_user_administration_requires_super_admin(client):
    assert client.get("/api/users").status_code == 200
    listed = client.get("/api/users").json()["data"]
    assert listed["users"][0]["isDeviceAdmin"] is True
    assert listed["users"][0]["name"] == "Admin"
    # The device Admin is synthetic and can never be edited/deleted.
    assert client.patch("/api/users/device-admin", json={"name": "x"}).status_code == 403
    assert client.delete("/api/users/device-admin").status_code == 403

    created = client.post(
        "/api/users",
        json={"email": "New.Member@Corp.Example", "role": "member"},
    )
    assert created.status_code == 200
    user = created.json()["data"]["user"]
    assert user["id"] == "new.member"
    assert user["email"] == "new.member@corp.example"
    assert user["name"] == "new.member"
    assert user["emailVerified"] is False

    duplicate = client.post("/api/users", json={"email": "new.member@corp.example"})
    assert duplicate.status_code == 409

    # Immutable id: another domain with the same local part is rejected.
    conflict = client.post("/api/users", json={"email": "new.member@other.example"})
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "user_id_conflict"

    team_admin_without_team = client.post(
        "/api/users", json={"email": "tm@corp.example", "role": "team_admin"}
    )
    assert team_admin_without_team.status_code == 422
    scoped = client.post(
        "/api/users",
        json={
            "email": "frontend.admin@corp.example",
            "role": "group_admin",
            "groupIds": ["grp-frontend"],
        },
    )
    assert scoped.status_code == 200
    assert scoped.json()["data"]["user"]["groupIds"] == ["grp-frontend"]

    promoted = client.patch(
        "/api/users/new.member",
        json={"name": "新成员", "role": "team_admin", "teamIds": ["team-aurora"]},
    )
    assert promoted.status_code == 200
    assert promoted.json()["data"]["user"]["role"] == "team_admin"
    assert promoted.json()["data"]["user"]["teamIds"] == ["team-aurora"]

    removed = client.delete("/api/users/new.member")
    assert removed.status_code == 200
    assert client.delete("/api/users/new.member").status_code == 404


def test_non_super_cannot_manage_users(client):
    _create_account("member.user@corp.example")
    _create_account(
        "team.admin@corp.example",
        role="team_admin",
        team_ids=["team-aurora"],
    )
    with TestClient(app, client=("10.20.30.77", 51020), raise_server_exceptions=False) as remote:
        _sign_in(remote, "member.user", "member.user@corp.example")
        assert remote.get("/api/users").status_code == 403
        assert remote.post("/api/users", json={"email": "x@corp.example"}).status_code == 403
        assert remote.patch("/api/users/member.user", json={"name": "x"}).status_code == 403
        remote.cookies.clear()
        _sign_in(remote, "team.admin", "team.admin@corp.example")
        assert remote.get("/api/users").status_code == 403


def test_profile_self_edit_syncs_linked_member(guest_client):
    _sign_in(guest_client, "lin.zhixia", "lin.zhixia@corp.example")
    profile = guest_client.get("/api/profile")
    assert profile.status_code == 200
    data = profile.json()["data"]
    assert data["isSelf"] is True
    assert data["canEdit"] is True
    assert data["user"]["name"] == "林知夏"
    assert data["user"]["isDeviceAdmin"] is False
    assert any(member["id"] == "m-lin" for member in data["members"])
    assert data["stats"]["duties"] >= 1
    assert data["stats"]["currentTasks"] >= 1
    assert data["stats"]["redEntries"] + data["stats"]["blackEntries"] >= 1
    assert data["redblack"]["black"] or data["redblack"]["red"]

    updated = guest_client.patch(
        "/api/profile",
        json={
            "name": "林知夏（个人主页）",
            "bio": "专注前端体验与设计系统。",
            "skills": ["TypeScript", "React", "可访问性"],
            "avatarColor": "#0a59f7",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["user"]["name"] == "林知夏（个人主页）"
    assert updated.json()["data"]["user"]["skills"] == ["TypeScript", "React", "可访问性"]

    # Personal edits mirror onto the linked group member row.
    overview = guest_client.get("/api/teams/team-aurora/groups/grp-frontend/overview")
    assert overview.status_code == 200
    member = next(item for item in overview.json()["data"]["members"] if item["id"] == "m-lin")
    assert member["name"] == "林知夏（个人主页）"
    assert member["bio"] == "专注前端体验与设计系统。"
    assert member["skills"] == ["TypeScript", "React", "可访问性"]


def test_profile_view_permissions_and_unlinked_account(guest_client):
    _sign_in(guest_client, "lin.zhixia", "lin.zhixia@corp.example")
    own = guest_client.get("/api/profile").json()["data"]
    assert own["canEdit"] is True

    guest_client.cookies.clear()
    other = guest_client.get("/api/users/lin.zhixia/profile")
    assert other.status_code == 200
    other_data = other.json()["data"]
    assert other_data["isSelf"] is False
    assert other_data["canEdit"] is False

    _create_account("lonely.user@corp.example")
    _sign_in(guest_client, "lonely.user", "lonely.user@corp.example")
    lonely = guest_client.get("/api/profile").json()["data"]
    assert lonely["isSelf"] is True
    assert lonely["canEdit"] is True
    assert lonely["members"] == []
    assert lonely["duties"] == []
    assert lonely["currentTasks"] == []
    assert guest_client.get("/api/users/does-not-exist/profile").status_code == 404


def test_device_admin_profile_is_read_only(client):
    profile = client.get("/api/profile")
    assert profile.status_code == 200
    data = profile.json()["data"]
    assert data["user"]["isDeviceAdmin"] is True
    assert data["canEdit"] is False
    assert client.patch("/api/profile", json={"name": "x"}).status_code == 403


def test_avatar_upload_and_removal(guest_client):
    _sign_in(guest_client, "chen.yu", "chen.yu@corp.example")
    uploaded = guest_client.post(
        "/api/profile/avatar",
        files={"file": ("avatar.png", PNG_BYTES, "image/png")},
    )
    assert uploaded.status_code == 200
    avatar = uploaded.json()["data"]["avatar"]
    assert avatar.startswith("/uploads/avatars/")

    served = guest_client.get(avatar)
    assert served.status_code == 200
    assert served.content == PNG_BYTES

    profile = guest_client.get("/api/profile").json()["data"]
    assert profile["user"]["avatar"] == avatar
    member = next(item for item in profile["members"] if item["id"] == "m-chen")
    assert member["avatar"] == avatar

    removed = guest_client.delete("/api/profile/avatar")
    assert removed.status_code == 200
    assert removed.json()["data"]["user"]["avatar"] == ""
    assert guest_client.get(avatar).status_code == 404

    bad = guest_client.post(
        "/api/profile/avatar",
        files={"file": ("notes.txt", b"not an image", "text/plain")},
    )
    assert bad.status_code == 422


# --------------------------------------------------------------------------- admin scope


def test_profile_admin_scope_super_and_member(client):
    own = client.get("/api/profile").json()["data"]
    assert own["adminScope"] == {
        "role": "super",
        "roleLabel": "超级管理员",
        "summary": "超级管理员",
        "teams": [],
        "groups": [],
        "isDeviceAdmin": True,
    }

    # A plain member's public page carries the empty member scope.
    other = client.get("/api/users/lin.zhixia/profile")
    assert other.status_code == 200
    assert other.json()["data"]["adminScope"] == {
        "role": "member",
        "roleLabel": "成员",
        "summary": "",
        "teams": [],
        "groups": [],
        "isDeviceAdmin": False,
    }


def test_profile_admin_scope_team_admin_resolves_team_names(guest_client):
    _create_account(
        "multi.team@corp.example",
        name="多团队管理员",
        role="team_admin",
        team_ids=["team-aurora", "team-voyage"],
    )
    _sign_in(guest_client, "multi.team", "multi.team@corp.example")

    scope = guest_client.get("/api/profile").json()["data"]["adminScope"]
    assert scope["role"] == "team_admin"
    assert scope["roleLabel"] == "团队管理员"
    assert scope["teams"] == [
        {"id": "team-aurora", "name": "极光产品团队"},
        {"id": "team-voyage", "name": "远航数据团队"},
    ]
    assert scope["groups"] == []
    assert scope["summary"] == "极光产品团队 团队管理员、远航数据团队 团队管理员"
    assert scope["isDeviceAdmin"] is False


def test_profile_admin_scope_group_admin_resolves_group_and_team(guest_client):
    _create_account(
        "multi.group@corp.example",
        name="多开发组管理员",
        role="group_admin",
        group_ids=["grp-frontend", "grp-data"],
    )
    _sign_in(guest_client, "multi.group", "multi.group@corp.example")

    scope = guest_client.get("/api/profile").json()["data"]["adminScope"]
    assert scope["role"] == "group_admin"
    assert scope["roleLabel"] == "开发组管理员"
    # ``users.group_ids`` is stored sorted, so the scope follows that order.
    assert scope["groups"] == [
        {
            "id": "grp-data",
            "name": "数据智能组",
            "teamId": "team-voyage",
            "teamName": "远航数据团队",
        },
        {
            "id": "grp-frontend",
            "name": "前端体验组",
            "teamId": "team-aurora",
            "teamName": "极光产品团队",
        },
    ]
    assert scope["teams"] == []
    assert scope["summary"] == "数据智能组 开发组管理员、前端体验组 开发组管理员"


def test_profile_admin_scope_stored_super_is_summary_only(guest_client):
    _create_account(
        "stored.super@corp.example",
        name="存储超管",
        role="super",
        team_ids=["team-aurora"],
    )
    _sign_in(guest_client, "stored.super", "stored.super@corp.example")

    scope = guest_client.get("/api/profile").json()["data"]["adminScope"]
    assert scope == {
        "role": "super",
        "roleLabel": "超级管理员",
        "summary": "超级管理员",
        "teams": [],
        "groups": [],
        "isDeviceAdmin": False,
    }


def test_profile_admin_scope_ignores_deleted_team_and_group_ids(guest_client):
    _create_account(
        "stale.scope@corp.example",
        name="失效范围",
        role="group_admin",
        group_ids=["grp-frontend"],
    )
    with db() as conn:
        accounts.update_user(
            conn, "stale.scope", group_ids=["grp-frontend", "grp-deleted"]
        )
    _sign_in(guest_client, "stale.scope", "stale.scope@corp.example")

    scope = guest_client.get("/api/profile").json()["data"]["adminScope"]
    assert [group["id"] for group in scope["groups"]] == ["grp-frontend"]
    assert scope["summary"] == "前端体验组 开发组管理员"

    # A stale team id leaves the team list (and summary) empty instead of failing.
    with db() as conn:
        accounts.update_user(
            conn,
            "stale.scope",
            role="team_admin",
            team_ids=["team-deleted"],
            group_ids=[],
        )
    stale = guest_client.get("/api/profile").json()["data"]["adminScope"]
    assert stale["role"] == "team_admin"
    assert stale["teams"] == []
    assert stale["summary"] == ""


def test_profile_admin_scope_is_public(guest_client):
    _create_account(
        "public.team.admin@corp.example",
        name="公开团队管理员",
        role="team_admin",
        team_ids=["team-aurora"],
    )
    guest_client.cookies.clear()
    response = guest_client.get("/api/users/public.team.admin/profile")
    assert response.status_code == 200
    assert response.json()["data"]["adminScope"]["summary"] == "极光产品团队 团队管理员"


def test_profile_admin_scope_for_ip_whitelist_identity(client):
    from backend.app.config import DEFAULT_SETTINGS, settings_service

    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["auth"]["adminWhitelist"]["ips"] = [
        {
            "ip": "10.20.30.0/24",
            "name": "楼层管理员",
            "role": "team_admin",
            "teamId": "team-aurora",
            "groupIds": [],
        }
    ]
    settings_service.save(payload)

    with TestClient(app, client=("10.20.30.41", 51041), raise_server_exceptions=False) as remote:
        response = remote.get("/api/profile")
        assert response.status_code == 200
        scope = response.json()["data"]["adminScope"]
        assert scope["role"] == "team_admin"
        assert scope["roleLabel"] == "团队管理员"
        assert scope["teams"] == [{"id": "team-aurora", "name": "极光产品团队"}]
        assert scope["summary"] == "极光产品团队 团队管理员"
        assert scope["isDeviceAdmin"] is False


# --------------------------------------------------------------------------- device-admin visibility


def test_user_list_shows_device_admin_row_only_to_device_admin(client):
    _create_account("stored.super@corp.example", name="存储超管", role="super")

    own = client.get("/api/users").json()["data"]
    assert own["users"][0]["id"] == "device-admin"
    assert own["users"][0]["isDeviceAdmin"] is True
    assert own["users"][0]["isSelf"] is True
    assert [item["id"] for item in own["users"]].count("device-admin") == 1

    with TestClient(app, client=("10.20.30.88", 51030), raise_server_exceptions=False) as remote:
        _sign_in(remote, "stored.super", "stored.super@corp.example")
        listed = remote.get("/api/users")
        assert listed.status_code == 200
        data = listed.json()["data"]
        ids = [item["id"] for item in data["users"]]
        assert "device-admin" not in ids
        assert "stored.super" in ids
        assert all(item["isDeviceAdmin"] is False for item in data["users"])
        assert data["deviceAdminName"] == "Admin"

        # The device Admin's own profile stays hidden from everybody else.
        hidden = remote.get("/api/users/device-admin/profile")
        assert hidden.status_code == 404
        assert hidden.json()["error"]["code"] == "user_not_found"
