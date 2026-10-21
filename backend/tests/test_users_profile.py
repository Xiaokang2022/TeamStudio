"""Account administration and the personal profile page (round 8: team only).

``users`` no longer has ``groupIds`` and roles are limited to member / team_admin / super.
Profile memberships carry ``teamId/teamName`` (no group, no status) and the admin scope
payload drops its ``groups`` list.
"""

from __future__ import annotations

import pytest

from backend.app.db import db
from backend.tests.helpers import (
    PNG_BYTES,
    TEAM_AURORA,
    TEAM_VOYAGE,
    assert_error,
    create_account,
    data,
    email_login,
    error,
    member_by_email,
    me,
    remote_client,
)

GIF_BYTES = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04"
    b"\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D"
    b"\x01\x00;"
)
JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
WEBP_BYTES = (
    b"RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00"
    b"\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00"
)
MAX_AVATAR_BYTES = 2 * 1024 * 1024


def _upload_avatar(client, data_bytes: bytes, *, filename: str = "avatar.png", content_type: str = "image/png"):
    return client.post(
        "/api/profile/avatar",
        files={"file": (filename, data_bytes, content_type)},
    )


# --------------------------------------------------------------------------- users admin


def test_user_administration_requires_super_admin(client):
    listed = data(client.get("/api/users"))
    assert listed["users"][0]["isDeviceAdmin"] is True
    assert listed["users"][0]["name"] == "Admin"
    assert client.patch("/api/users/device-admin", json={"name": "x"}).status_code == 403
    assert client.delete("/api/users/device-admin").status_code == 403

    created = data(
        client.post("/api/users", json={"email": "New.Member@Corp.Example", "role": "member"})
    )["user"]
    assert created["id"] == "new.member"
    assert created["email"] == "new.member@corp.example"
    assert created["name"] == "new.member"
    assert created["emailVerified"] is False
    assert "groupIds" not in created
    assert created["teamIds"] == []

    assert client.post("/api/users", json={"email": "new.member@corp.example"}).status_code == 409
    conflict = client.post("/api/users", json={"email": "new.member@other.example"})
    assert conflict.status_code == 409
    assert error(conflict)["code"] == "user_id_conflict"

    # ``group_admin`` is gone from the role vocabulary.
    assert (
        client.post(
            "/api/users", json={"email": "group.admin@corp.example", "role": "group_admin"}
        ).status_code
        == 422
    )
    # ``groupIds`` is ignored (never stored / returned).
    with_group_ids = client.post(
        "/api/users",
        json={
            "email": "ignored.groups@corp.example",
            "role": "member",
            "groupIds": ["grp-frontend"],
        },
    )
    assert with_group_ids.status_code == 200, with_group_ids.text
    assert "groupIds" not in data(with_group_ids)["user"]

    scoped = data(
        client.post(
            "/api/users",
            json={
                "email": "team.admin@corp.example",
                "role": "team_admin",
                "teamIds": [TEAM_AURORA],
            },
        )
    )["user"]
    assert scoped["role"] == "team_admin"
    assert scoped["teamIds"] == [TEAM_AURORA]

    promoted = data(
        client.patch(
            "/api/users/new.member",
            json={"name": "新成员", "role": "team_admin", "teamIds": [TEAM_AURORA]},
        )
    )["user"]
    assert promoted["role"] == "team_admin"
    assert promoted["teamIds"] == [TEAM_AURORA]
    assert "groupIds" not in promoted

    # ``groupIds`` on update is ignored as well (round 8 removed the concept).
    ignored = client.patch(
        "/api/users/new.member", json={"groupIds": ["grp-frontend"]}
    )
    assert ignored.status_code == 200, ignored.text
    assert "groupIds" not in data(ignored)["user"]

    assert data(client.delete("/api/users/new.member"))["deleted"] is True
    assert client.delete("/api/users/new.member").status_code == 404


def test_non_super_cannot_manage_users(client, monkeypatch):
    create_account(client, "member.user@corp.example")
    chen = member_by_email(client, "chen.yu@corp.example")
    super_account = create_account(client, "stored.super@corp.example", role="super")
    with remote_client("10.20.30.120", 51901) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert browser.get("/api/users").status_code == 403
        assert browser.post("/api/users", json={"email": "x@corp.example"}).status_code == 403

    with remote_client("10.20.30.121", 51902) as browser:
        email_login(browser, "stored.super@corp.example", monkeypatch)
        assert browser.get("/api/users").status_code == 200
        ids = [item["id"] for item in data(browser.get("/api/users"))["users"]]
        assert "device-admin" not in ids
        assert "stored.super" in ids
        assert all(item["isDeviceAdmin"] is False for item in data(browser.get("/api/users"))["users"])


# --------------------------------------------------------------------------- profile


def test_profile_self_edit_syncs_linked_member(client, monkeypatch):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    with remote_client("10.20.30.122", 51903) as browser:
        email_login(browser, "lin.zhixia@corp.example", monkeypatch)
        profile = data(browser.get("/api/profile"))
        assert profile["isSelf"] is True
        assert profile["canEdit"] is True
        assert profile["user"]["name"] == "林知夏"
        assert profile["user"]["isDeviceAdmin"] is False
        assert any(member["id"] == lin["id"] for member in profile["members"])
        assert profile["stats"]["duties"] >= 1
        assert profile["stats"]["currentTasks"] >= 1

        # Memberships and member cards carry team identity, never group/status.
        for membership in profile["memberships"]:
            assert "teamId" in membership and "teamName" in membership
            assert "groupId" not in membership
            assert "groupName" not in membership
            assert "status" not in membership
        for member in profile["members"]:
            assert member["teamId"] == TEAM_AURORA
            assert "groupId" not in member
            assert "status" not in member

        updated = data(
            browser.patch(
                "/api/profile",
                json={
                    "name": "林知夏（个人主页）",
                    "bio": "专注前端体验与设计系统。",
                    "skills": ["TypeScript", "React", "可访问性"],
                    "avatarColor": "#0a59f7",
                },
            )
        )
        assert updated["user"]["name"] == "林知夏（个人主页）"
        assert updated["user"]["skills"] == ["TypeScript", "React", "可访问性"]

        members = data(browser.get(f"/api/teams/{TEAM_AURORA}/overview"))["members"]
        listed = next(item for item in members if item["id"] == lin["id"])
        assert listed["name"] == "林知夏（个人主页）"
        assert listed["bio"] == "专注前端体验与设计系统。"


def test_profile_view_permissions_and_unlinked_account(client, monkeypatch):
    create_account(client, "lonely.user@corp.example")
    with remote_client("10.20.30.123", 51904) as browser:
        email_login(browser, "lin.zhixia@corp.example", monkeypatch)
        assert data(browser.get("/api/profile"))["canEdit"] is True
        browser.post("/api/auth/logout")
        other = data(browser.get("/api/users/lin.zhixia/profile"))
        assert other["isSelf"] is False
        assert other["canEdit"] is False

    with remote_client("10.20.30.124", 51905) as browser:
        email_login(browser, "lonely.user@corp.example", monkeypatch)
        lonely = data(browser.get("/api/profile"))
        assert lonely["isSelf"] is True
        assert lonely["canEdit"] is True
        assert lonely["members"] == []
        assert lonely["duties"] == []
        assert browser.get("/api/users/does-not-exist/profile").status_code == 404


def test_device_admin_profile_is_read_only(client):
    profile = data(client.get("/api/profile"))
    assert profile["user"]["isDeviceAdmin"] is True
    assert profile["canEdit"] is False
    assert client.patch("/api/profile", json={"name": "x"}).status_code == 403


def test_avatar_upload_and_removal(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.125", 51906) as browser:
        email_login(browser, "chen.yu@corp.example", monkeypatch)
        uploaded = _upload_avatar(browser, PNG_BYTES)
        assert uploaded.status_code == 200
        avatar = data(uploaded)["avatar"]
        assert avatar.startswith("/uploads/avatars/")

        served = browser.get(avatar)
        assert served.status_code == 200
        assert served.content == PNG_BYTES

        profile = data(browser.get("/api/profile"))
        assert profile["user"]["avatar"] == avatar
        member = next(item for item in profile["members"] if item["id"] == chen["id"])
        assert member["avatar"] == avatar

        removed = data(browser.delete("/api/profile/avatar"))
        assert removed["user"]["avatar"] == ""
        assert browser.get(avatar).status_code == 404

        bad = _upload_avatar(browser, b"not an image", filename="notes.txt", content_type="text/plain")
        assert bad.status_code == 422


def test_avatar_upload_trusts_content_not_declared_mime(client, monkeypatch):
    create_account(client, "avatar.uploader@corp.example")
    with remote_client("10.20.30.126", 51907) as browser:
        email_login(browser, "avatar.uploader@corp.example", monkeypatch)
        for declared in ("image/x-png", "application/octet-stream", "", "image/gif"):
            uploaded = _upload_avatar(browser, PNG_BYTES, content_type=declared)
            assert uploaded.status_code == 200, declared
            avatar = data(uploaded)["avatar"]
            assert avatar.endswith(".png"), declared
            assert browser.get(avatar).content == PNG_BYTES

        for data_bytes, extension in ((GIF_BYTES, ".gif"), (JPEG_BYTES, ".jpg"), (WEBP_BYTES, ".webp")):
            uploaded = _upload_avatar(
                browser, data_bytes, filename="payload.bin", content_type="application/octet-stream"
            )
            assert uploaded.status_code == 200, extension
            assert data(uploaded)["avatar"].endswith(extension)

        spoofed = _upload_avatar(browser, b"this is not an image", content_type="image/png")
        assert spoofed.status_code == 422
        assert error(spoofed)["code"] == "avatar_type_unsupported"

        empty = _upload_avatar(browser, b"", content_type="image/png")
        assert empty.status_code == 422
        assert error(empty)["code"] == "avatar_empty"

        oversized = _upload_avatar(
            browser, b"\x89PNG\r\n\x1a\n" + b"0" * MAX_AVATAR_BYTES, content_type="image/png"
        )
        assert oversized.status_code == 413
        assert error(oversized)["code"] == "avatar_too_large"


# --------------------------------------------------------------------------- admin scope


def test_profile_admin_scope_super_and_member(client):
    own = data(client.get("/api/profile"))
    assert own["adminScope"] == {
        "role": "super",
        "roleLabel": "超级管理员",
        "summary": "超级管理员",
        "teams": [],
        "isDeviceAdmin": True,
    }
    assert "groups" not in own["adminScope"]

    other = data(client.get("/api/users/lin.zhixia/profile"))
    assert other["adminScope"] == {
        "role": "member",
        "roleLabel": "成员",
        "summary": "",
        "teams": [],
        "isDeviceAdmin": False,
    }


def test_profile_admin_scope_team_admin_resolves_team_names(client, monkeypatch):
    create_account(
        client,
        "multi.team@corp.example",
        name="多团队管理员",
        role="team_admin",
        team_ids=[TEAM_AURORA, TEAM_VOYAGE],
    )
    with remote_client("10.20.30.127", 51908) as browser:
        email_login(browser, "multi.team@corp.example", monkeypatch)
        scope = data(browser.get("/api/profile"))["adminScope"]
        assert scope["role"] == "team_admin"
        assert scope["roleLabel"] == "团队管理员"
        assert scope["teams"] == [
            {"id": TEAM_AURORA, "name": "极光产品团队"},
            {"id": TEAM_VOYAGE, "name": "远航数据团队"},
        ]
        assert "groups" not in scope
        assert scope["summary"] == "极光产品团队 团队管理员、远航数据团队 团队管理员"
        assert scope["isDeviceAdmin"] is False


def test_profile_admin_scope_is_public_and_device_admin_hidden(client, monkeypatch):
    create_account(client, "public.team.admin@corp.example", role="team_admin", team_ids=[TEAM_AURORA])
    with remote_client("10.20.30.128", 51909) as browser:
        response = browser.get("/api/users/public.team.admin/profile")
        assert response.status_code == 200
        scope = data(response)["adminScope"]
        assert scope["summary"] == "极光产品团队 团队管理员"
        # The synthetic device Admin is not a public account.
        hidden = browser.get("/api/users/device-admin/profile")
        assert hidden.status_code == 404
        assert error(hidden)["code"] == "user_not_found"
