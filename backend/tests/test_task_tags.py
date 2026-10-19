"""Tests for the shared task tag library (``#10``) and task tag hydration."""

from __future__ import annotations

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
BASE = f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}"
TAGS_URL = f"{BASE}/task-tags"
TASKS_URL = f"{BASE}/tasks"


def _data(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["data"]


def _create_tag(client, name: str, color: str = "#123456") -> dict:
    return _data(client.post(TAGS_URL, json={"name": name, "color": color}))["tag"]


def test_default_tags_are_lazily_seeded(client):
    from backend.app.db import db, scalar

    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM task_tags") == 0

    data = _data(client.get(TAGS_URL))
    assert {tag["name"] for tag in data["tags"]} == {
        "后端",
        "前端",
        "体验",
        "协作",
        "数据",
    }
    assert data["scope"]["kind"] == "group"
    for tag in data["tags"]:
        assert set(tag) >= {
            "id",
            "groupId",
            "groupName",
            "name",
            "color",
            "usage",
            "createdBy",
            "createdAt",
            "updatedAt",
        }
        assert tag["groupId"] == GROUP_ID
        assert tag["groupName"] == "前端体验组"
        assert tag["usage"] == 0
        assert tag["color"].startswith("#")

    # Visiting twice must not duplicate the defaults.
    again = _data(client.get(TAGS_URL))
    assert len(again["tags"]) == 5
    with db() as conn:
        assert scalar(conn, "SELECT COUNT(*) FROM task_tags") == 5


def test_tag_crud_and_validation(client):
    # Reading the library first lazily seeds the five defaults.
    defaults = _data(client.get(TAGS_URL))["tags"]
    assert len(defaults) == 5

    tag = _create_tag(client, "性能", "#ABCDEF")
    assert tag["name"] == "性能"
    assert tag["color"] == "#abcdef"
    assert tag["usage"] == 0
    assert tag["createdBy"] == "Admin"

    # Duplicate names are rejected per group.
    duplicate = client.post(TAGS_URL, json={"name": "性能"})
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "tag_exists"

    # Name/colour validation.
    for body in (
        {"name": ""},
        {"name": "x" * 21},
        {"name": "合法", "color": "red"},
        {"name": "合法", "color": "#12345"},
    ):
        assert client.post(TAGS_URL, json=body).status_code == 422, body

    updated = _data(
        client.patch(f"{TAGS_URL}/{tag['id']}", json={"name": "性能优化", "color": "#00AA00"})
    )["tag"]
    assert updated["name"] == "性能优化"
    assert updated["color"] == "#00aa00"

    # Renaming onto another existing name conflicts.
    assert client.patch(f"{TAGS_URL}/{tag['id']}", json={"name": "前端"}).status_code == 409

    assert client.patch(f"{TAGS_URL}/tag-missing", json={"name": "x"}).status_code == 404
    assert client.delete(f"{TAGS_URL}/tag-missing").status_code == 404

    deleted = _data(client.delete(f"{TAGS_URL}/{tag['id']}"))
    assert deleted["deleted"] is True
    assert all(item["id"] != tag["id"] for item in _data(client.get(TAGS_URL))["tags"])


def test_guest_cannot_manage_tags(guest_client):
    assert guest_client.get(TAGS_URL).status_code == 200
    assert guest_client.post(TAGS_URL, json={"name": "访客标签"}).status_code == 401
    tags = _data(guest_client.get(TAGS_URL))["tags"]
    assert guest_client.patch(f"{TAGS_URL}/{tags[0]['id']}", json={"name": "x"}).status_code == 401
    assert guest_client.delete(f"{TAGS_URL}/{tags[0]['id']}").status_code == 401


def test_task_tag_ids_are_validated_and_hydrated(client):
    backend = next(
        tag for tag in _data(client.get(TAGS_URL))["tags"] if tag["name"] == "后端"
    )
    created = _data(
        client.post(
            TASKS_URL,
            json={
                "memberId": "m-lin",
                "title": "带标签的任务",
                "tagIds": [backend["id"], backend["id"]],
            },
        )
    )["task"]
    assert created["tagIds"] == [backend["id"]]
    assert [tag["name"] for tag in created["tags"]] == ["后端"]
    assert created["tags"][0]["groupId"] == GROUP_ID

    # The ledger list (and aggregate scopes) hydrate the same tags.
    listed = _data(client.get(TASKS_URL))["tasks"]
    listed_task = next(item for item in listed if item["id"] == created["id"])
    assert listed_task["tagIds"] == [backend["id"]]
    assert listed_task["tags"][0]["name"] == "后端"
    all_tasks = _data(client.get(f"{TASKS_URL}?scope=all"))["tasks"]
    assert next(item for item in all_tasks if item["id"] == created["id"])["tagIds"] == [
        backend["id"]
    ]

    # Replacing with an empty list clears the tags.
    cleared = _data(client.patch(f"{TASKS_URL}/{created['id']}", json={"tagIds": []}))["task"]
    assert cleared["tagIds"] == []
    assert cleared["tags"] == []

    # Unknown tag ids, foreign-group tags and more than 8 tags are rejected.
    assert (
        client.patch(
            f"{TASKS_URL}/{created['id']}", json={"tagIds": ["tag-missing"]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            TASKS_URL,
            json={"memberId": "m-lin", "title": "越组标签", "tagIds": ["tag-missing"]},
        ).status_code
        == 422
    )
    too_many = [f"tag-{index}" for index in range(9)]
    assert (
        client.post(
            TASKS_URL,
            json={"memberId": "m-lin", "title": "太多标签", "tagIds": too_many},
        ).status_code
        == 422
    )


def test_deleting_tag_removes_it_from_every_task(client):
    tag = _create_tag(client, "临时")
    task = _data(
        client.post(
            TASKS_URL,
            json={"memberId": "m-chen", "title": "待清理标签", "tagIds": [tag["id"]]},
        )
    )["task"]
    usage = next(
        item for item in _data(client.get(TAGS_URL))["tags"] if item["id"] == tag["id"]
    )
    assert usage["usage"] == 1

    _data(client.delete(f"{TAGS_URL}/{tag['id']}"))
    tasks = _data(client.get(TASKS_URL))["tasks"]
    cleaned = next(item for item in tasks if item["id"] == task["id"])
    assert cleaned["tagIds"] == []
    assert cleaned["tags"] == []


def test_scope_returns_tag_libraries_with_group_names(client):
    team = _data(client.get(f"{TAGS_URL}?scope=team"))
    assert team["scope"]["kind"] == "team"
    assert len(team["tags"]) == 15  # 5 default tags per group x 3 groups
    assert {tag["groupId"] for tag in team["tags"]} == {
        "grp-frontend",
        "grp-platform",
        "grp-design",
    }
    assert all(tag["groupName"] for tag in team["tags"])

    all_tags = _data(client.get(f"{TAGS_URL}?scope=all"))["tags"]
    assert len(all_tags) == 25

    # A tag created in one group cannot be attached to a task of another group.
    tag = _create_tag(client, "跨组测试")
    denied = client.post(
        f"/api/teams/{TEAM_ID}/groups/grp-platform/tasks",
        json={"memberId": "m-zhou", "title": "跨组引用", "tagIds": [tag["id"]]},
    )
    assert denied.status_code == 422
    assert denied.json()["error"]["code"] == "invalid_tag"
