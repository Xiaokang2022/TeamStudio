"""Team task tag library (round 8: one library per team, no group/scope)."""

from __future__ import annotations

from backend.tests.helpers import TEAM_AURORA, TEAM_VOYAGE, assert_error, data, error, member_by_email

TAGS_URL = f"/api/teams/{TEAM_AURORA}/task-tags"
TASKS_URL = f"/api/teams/{TEAM_AURORA}/tasks"
DEFAULT_TAG_NAMES = {"后端", "前端", "体验", "协作", "数据"}


def _create_tag(client, name: str, color: str = "#123456") -> dict:
    return data(client.post(TAGS_URL, json={"name": name, "color": color}))["tag"]


def test_default_tags_are_lazily_seeded_per_team(client):
    from backend.app.db import db, scalar

    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM task_tags") == 0

    payload = data(client.get(TAGS_URL))
    assert {tag["name"] for tag in payload["tags"]} == DEFAULT_TAG_NAMES
    for tag in payload["tags"]:
        assert set(tag) >= {
            "id",
            "teamId",
            "name",
            "color",
            "usage",
            "createdBy",
            "createdAt",
            "updatedAt",
        }
        assert tag["teamId"] == TEAM_AURORA
        assert "groupId" not in tag
        assert tag["usage"] == 0
        assert tag["color"].startswith("#")

    # Visiting twice must not duplicate the defaults.
    again = data(client.get(TAGS_URL))["tags"]
    assert len(again) == 5
    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM task_tags") == 5

    # The second team lazily gets its own library.
    voyage = data(client.get(f"/api/teams/{TEAM_VOYAGE}/task-tags"))["tags"]
    assert len(voyage) == 5
    assert {tag["teamId"] for tag in voyage} == {TEAM_VOYAGE}


def test_tag_crud_and_validation(client):
    defaults = data(client.get(TAGS_URL))["tags"]
    assert len(defaults) == 5

    tag = _create_tag(client, "性能", "#ABCDEF")
    assert tag["name"] == "性能"
    assert tag["color"] == "#abcdef"
    assert tag["usage"] == 0
    assert tag["createdBy"] == "Admin"

    duplicate = client.post(TAGS_URL, json={"name": "性能"})
    assert duplicate.status_code == 409
    assert error(duplicate)["code"] == "tag_exists"

    for body in (
        {"name": ""},
        {"name": "x" * 21},
        {"name": "合法", "color": "red"},
        {"name": "合法", "color": "#12345"},
    ):
        assert client.post(TAGS_URL, json=body).status_code == 422, body

    updated = data(
        client.patch(f"{TAGS_URL}/{tag['id']}", json={"name": "性能优化", "color": "#00AA00"})
    )["tag"]
    assert updated["name"] == "性能优化"
    assert updated["color"] == "#00aa00"

    assert client.patch(f"{TAGS_URL}/{tag['id']}", json={"name": "前端"}).status_code == 409
    assert_error(client.patch(f"{TAGS_URL}/tag-missing", json={"name": "x"}), 404, "tag_not_found")
    assert_error(client.delete(f"{TAGS_URL}/tag-missing"), 404, "tag_not_found")

    deleted = data(client.delete(f"{TAGS_URL}/{tag['id']}"))
    assert deleted["deleted"] is True
    assert all(item["id"] != tag["id"] for item in data(client.get(TAGS_URL))["tags"])


def test_guest_cannot_manage_tags(guest_client):
    assert guest_client.get(TAGS_URL).status_code == 200
    assert guest_client.post(TAGS_URL, json={"name": "访客标签"}).status_code == 401
    tags = data(guest_client.get(TAGS_URL))["tags"]
    assert guest_client.patch(f"{TAGS_URL}/{tags[0]['id']}", json={"name": "x"}).status_code == 401
    assert guest_client.delete(f"{TAGS_URL}/{tags[0]['id']}").status_code == 401


def test_authenticated_member_can_manage_the_tag_library(client, monkeypatch):
    """The tag library is member-editable (only guests are rejected) in the old and new API."""
    chen = member_by_email(client, "chen.yu@corp.example")
    from backend.tests.helpers import email_login, remote_client

    with remote_client("10.20.30.102", 51602) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert browser.get(TAGS_URL).status_code == 200
        created = data(browser.post(TAGS_URL, json={"name": "成员标签"}))["tag"]
        assert created["createdBy"] == "陈屿"
        updated = data(
            browser.patch(f"{TAGS_URL}/{created['id']}", json={"name": "成员标签 2"})
        )["tag"]
        assert updated["name"] == "成员标签 2"
        assert data(browser.delete(f"{TAGS_URL}/{created['id']}"))["deleted"] is True


def test_task_tag_ids_are_validated_and_hydrated(client):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    backend = next(
        tag for tag in data(client.get(TAGS_URL))["tags"] if tag["name"] == "后端"
    )
    created = data(
        client.post(
            TASKS_URL,
            json={
                "memberId": lin["id"],
                "title": "带标签的任务",
                "tagIds": [backend["id"], backend["id"]],
            },
        )
    )["task"]
    assert created["tagIds"] == [backend["id"]]
    assert [tag["name"] for tag in created["tags"]] == ["后端"]
    assert created["tags"][0]["teamId"] == TEAM_AURORA
    assert "groupId" not in created["tags"][0]

    listed = data(client.get(TASKS_URL))["tasks"]
    listed_task = next(item for item in listed if item["id"] == created["id"])
    assert listed_task["tagIds"] == [backend["id"]]

    cleared = data(
        client.patch(f"{TASKS_URL}/{created['id']}", json={"tagIds": []})
    )["task"]
    assert cleared["tagIds"] == []
    assert cleared["tags"] == []

    # Unknown tag ids and too many tags are rejected.
    assert (
        client.patch(
            f"{TASKS_URL}/{created['id']}", json={"tagIds": ["tag-missing"]}
        ).status_code
        == 422
    )
    too_many = ["tag-missing"] * 9
    assert (
        client.post(
            TASKS_URL,
            json={"memberId": lin["id"], "title": "太多标签", "tagIds": too_many},
        ).status_code
        == 422
    )


def test_tag_from_another_team_cannot_be_attached(client):
    voyage_tag = data(client.post(f"/api/teams/{TEAM_VOYAGE}/task-tags", json={"name": "远航标签"}))[
        "tag"
    ]
    lin = member_by_email(client, "lin.zhixia@corp.example")
    denied = client.post(
        TASKS_URL,
        json={"memberId": lin["id"], "title": "跨团队引用", "tagIds": [voyage_tag["id"]]},
    )
    assert denied.status_code == 422
    assert error(denied)["code"] == "invalid_tag"


def test_deleting_tag_removes_it_from_every_task(client):
    chen = member_by_email(client, "chen.yu@corp.example")
    tag = _create_tag(client, "临时")
    task = data(
        client.post(
            TASKS_URL,
            json={"memberId": chen["id"], "title": "待清理标签", "tagIds": [tag["id"]]},
        )
    )["task"]
    usage = next(
        item for item in data(client.get(TAGS_URL))["tags"] if item["id"] == tag["id"]
    )
    assert usage["usage"] == 1

    data(client.delete(f"{TAGS_URL}/{tag['id']}"))
    tasks = data(client.get(TASKS_URL))["tasks"]
    cleaned = next(item for item in tasks if item["id"] == task["id"])
    assert cleaned["tagIds"] == []
    assert cleaned["tags"] == []
