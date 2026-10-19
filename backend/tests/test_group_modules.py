"""Tests for the group-scoped feature routers (overview, members, todos, boards).

The application under test is built standalone from our three routers so the tests do not
depend on ``backend/app/main.py`` (owned by another agent). ``get_current_user`` is replaced
through FastAPI dependency overrides and the SQLite database is redirected to ``tmp_path``.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Iterator

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.auth import CurrentUser, get_current_user
from backend.app.config import Settings, settings_service
from backend.app.db import init_db
from backend.app.routers import boards, calendar, workspace
from backend.app.seed import seed_if_empty

TEAM_ID = "team-aurora"
GROUP_ID = "grp-frontend"
MEMBER_ID = "m-chen"


# --------------------------------------------------------------------------- app factory


def _error_body(detail: object) -> dict:
    if isinstance(detail, dict):
        return {
            "code": detail.get("code", "error"),
            "message": detail.get("message", ""),
            "details": detail.get("details"),
        }
    return {"code": "http_error", "message": str(detail), "details": None}


def build_app() -> FastAPI:
    app = FastAPI()
    for module in (workspace, calendar, boards):
        app.include_router(module.router)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request, exc: StarletteHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"ok": False, "error": _error_body(exc.detail)},
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": {
                    "code": "validation_error",
                    "message": "请求参数校验未通过",
                    "details": exc.errors(),
                },
            },
        )

    return app


# --------------------------------------------------------------------------- identities


def admin_user() -> CurrentUser:
    return CurrentUser(
        id="device-admin",
        name="Admin",
        authenticated=True,
        source="local",
        is_device_admin=True,
        admin_role="super",
    )


def member_user(member_id: str = MEMBER_ID, name: str = "陈屿") -> CurrentUser:
    return CurrentUser(
        id=f"{member_id}@corp.example",
        name=name,
        email=f"{member_id}@corp.example",
        authenticated=True,
        source="sso",
        linked_member_id=member_id,
        linked_member_name=name,
    )


def group_admin_user() -> CurrentUser:
    return CurrentUser(
        id="group-admin@corp.example",
        name="组管理员",
        authenticated=True,
        source="sso",
        admin_role="group_admin",
        group_ids={GROUP_ID},
    )


def guest_user() -> CurrentUser:
    return CurrentUser(id="guest", name="访客", authenticated=False, source="guest")


class ApiHarness:
    """Small facade around TestClient plus a switchable current user."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.holder: dict[str, CurrentUser] = {"user": admin_user()}
        app.dependency_overrides[get_current_user] = lambda: self.holder["user"]
        self.client = TestClient(app)

    def as_admin(self) -> "ApiHarness":
        self.holder["user"] = admin_user()
        return self

    def as_group_admin(self) -> "ApiHarness":
        self.holder["user"] = group_admin_user()
        return self

    def as_member(self, member_id: str = MEMBER_ID, name: str = "陈屿") -> "ApiHarness":
        self.holder["user"] = member_user(member_id, name)
        return self

    def as_guest(self) -> "ApiHarness":
        self.holder["user"] = guest_user()
        return self


@pytest.fixture()
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[ApiHarness]:
    import backend.app.db as db_module

    monkeypatch.setattr(db_module, "DB_PATH", tmp_path / "teamstudio-test.db")
    # Keep settings deterministic even if a developer edited data/settings.json.
    monkeypatch.setattr(settings_service, "_settings", Settings())
    init_db()
    seed_if_empty()
    application = build_app()
    test_api = ApiHarness(application)
    yield test_api
    application.dependency_overrides.clear()


def url(path: str = "") -> str:
    return f"/api/teams/{TEAM_ID}/groups/{GROUP_ID}{path}"


def _iso(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------- overview / members


def test_overview_returns_group_members_works_activity_and_stats(api: TestApi) -> None:
    api.as_guest()
    response = api.client.get(url("/overview"))
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    data = body["data"]
    assert data["group"]["id"] == GROUP_ID
    assert data["group"]["teamId"] == TEAM_ID
    assert data["group"]["teamName"]
    assert data["group"]["memberCount"] == len(data["members"])
    assert len(data["members"]) >= 5
    assert isinstance(data["works"], list) and data["works"]
    assert isinstance(data["recentActivity"], list) and data["recentActivity"]
    assert "memberName" in data["recentActivity"][0]
    assert data["stats"]["members"] == len(data["members"])
    assert data["stats"]["works"] == len(data["works"])
    for key in (
        "id",
        "name",
        "email",
        "title",
        "role",
        "avatarColor",
        "bio",
        "tags",
        "status",
        "currentWorks",
        "historyWorks",
        "stats",
    ):
        assert key in data["members"][0]
    assert isinstance(data["members"][0]["stats"]["todos"], int)


def test_unknown_group_or_member_returns_404(api: TestApi) -> None:
    response = api.client.get(f"/api/teams/{TEAM_ID}/groups/grp-missing/overview")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "group_not_found"

    response = api.client.get(url("/members/m-missing/works"))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "member_not_found"


def test_member_self_edit_only_linked_member(api: TestApi) -> None:
    api.as_member(MEMBER_ID, "陈屿")
    response = api.client.patch(
        url(f"/members/{MEMBER_ID}"),
        json={"title": "资深前端工程师", "tags": ["TypeScript", "性能优化"], "email": "chen.yu@corp.example"},
    )
    assert response.status_code == 200
    member = response.json()["data"]["member"]
    assert member["title"] == "资深前端工程师"
    assert member["tags"] == ["TypeScript", "性能优化"]

    # Editing another member's profile is forbidden for a plain member.
    response = api.client.patch(url("/members/m-lin"), json={"title": "越权修改"})
    assert response.status_code == 403

    # Guests cannot write at all.
    api.as_guest()
    response = api.client.patch(url(f"/members/{MEMBER_ID}"), json={"title": "访客修改"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "authentication_required"


def test_admin_creates_updates_and_deletes_member(api: TestApi) -> None:
    api.as_admin()
    response = api.client.post(
        url("/members"),
        json={
            "name": "测试成员",
            "email": "tester@corp.example",
            "title": "测试工程师",
            "tags": ["测试", "质量"],
            "status": "available",
        },
    )
    assert response.status_code == 200
    member = response.json()["data"]["member"]
    member_id = member["id"]
    assert member_id.startswith("member-")
    assert member["tags"] == ["测试", "质量"]

    response = api.client.patch(url(f"/members/{member_id}"), json={"role": "核心成员"})
    assert response.status_code == 200
    assert response.json()["data"]["member"]["role"] == "核心成员"

    # Duplicate id is a conflict.
    response = api.client.post(url("/members"), json={"id": member_id, "name": "重复"})
    assert response.status_code == 409

    response = api.client.delete(url(f"/members/{member_id}"))
    assert response.status_code == 200
    assert response.json()["data"]["deleted"] is True
    assert api.client.delete(url(f"/members/{member_id}")).status_code == 404


def test_member_cannot_delete_or_create_members(api: TestApi) -> None:
    api.as_member(MEMBER_ID)
    assert api.client.delete(url("/members/m-su")).status_code == 403
    assert api.client.post(url("/members"), json={"name": "越权创建"}).status_code == 403


def test_member_work_crud_permissions(api: TestApi) -> None:
    api.as_member(MEMBER_ID)
    response = api.client.post(
        url(f"/members/{MEMBER_ID}/works"),
        json={"title": "新的工作项", "status": "current", "progress": 10, "category": "测试"},
    )
    assert response.status_code == 200
    work = response.json()["data"]["work"]
    work_id = work["id"]
    assert work["memberId"] == MEMBER_ID
    assert work["progress"] == 10

    response = api.client.patch(
        url(f"/members/{MEMBER_ID}/works/{work_id}"),
        json={"status": "done", "description": "已完成"},
    )
    assert response.status_code == 200
    updated = response.json()["data"]["work"]
    assert updated["status"] == "done"
    assert updated["progress"] == 100  # done implies 100 when progress is omitted

    # Another member cannot edit this work item.
    api.as_member("m-su", "苏晚")
    assert (
        api.client.patch(
            url(f"/members/{MEMBER_ID}/works/{work_id}"), json={"title": "越权"}
        ).status_code
        == 403
    )
    assert (
        api.client.get(url(f"/members/{MEMBER_ID}/works")).status_code
        == 200
    )

    # Admin can delete it.
    api.as_admin()
    response = api.client.delete(url(f"/members/{MEMBER_ID}/works/{work_id}"))
    assert response.status_code == 200
    assert api.client.patch(url(f"/members/{MEMBER_ID}/works/{work_id}"), json={}).status_code == 404


# --------------------------------------------------------------------------- calendar todos


def test_todo_lifecycle_for_member_self(api: TestApi) -> None:
    tomorrow = _iso(2)
    api.as_member(MEMBER_ID)
    response = api.client.post(
        url("/todos"),
        json={
            "title": "联调日历提醒",
            "description": "验证三档提醒",
            "dueDate": tomorrow,
            "dueTime": "10:30",
            "priority": "high",
        },
    )
    assert response.status_code == 200
    todo = response.json()["data"]["todo"]
    assert todo["assigneeMemberId"] == MEMBER_ID
    assert todo["reminderOffsetsDays"] == [3, 1, 0]
    assert todo["emailEnabled"] is True
    assert todo["assigneeName"] == "陈屿"
    todo_id = todo["id"]

    response = api.client.get(url("/todos"), params={"month": tomorrow[:7]})
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["month"] == tomorrow[:7]
    assert any(item["id"] == todo_id for item in data["todos"])

    response = api.client.patch(
        url(f"/todos/{todo_id}"),
        json={"title": "联调完成", "status": "done", "reminderOffsetsDays": [7, 1]},
    )
    assert response.status_code == 200
    updated = response.json()["data"]["todo"]
    assert updated["title"] == "联调完成"
    assert updated["status"] == "done"
    assert updated["completedAt"]
    assert updated["reminderOffsetsDays"] == [7, 1]

    response = api.client.delete(url(f"/todos/{todo_id}"))
    assert response.status_code == 200
    assert api.client.patch(url(f"/todos/{todo_id}"), json={"title": "x"}).status_code == 404


def test_todo_permission_rules(api: TestApi) -> None:
    tomorrow = _iso(3)
    api.as_admin()
    response = api.client.post(
        url("/todos"),
        json={"title": "管理员指派待办", "dueDate": tomorrow, "assigneeMemberId": MEMBER_ID},
    )
    assert response.status_code == 200
    todo_id = response.json()["data"]["todo"]["id"]
    assert response.json()["data"]["todo"]["assigneeMemberId"] == MEMBER_ID

    # Unrelated member cannot edit or delete it.
    api.as_member("m-su", "苏晚")
    assert api.client.patch(url(f"/todos/{todo_id}"), json={"priority": "low"}).status_code == 403
    assert api.client.delete(url(f"/todos/{todo_id}")).status_code == 403

    # A member cannot create a todo assigned to somebody else.
    response = api.client.post(
        url("/todos"),
        json={"title": "越权指派", "dueDate": tomorrow, "assigneeMemberId": "m-lin"},
    )
    assert response.status_code == 403

    # The assigned member may update and delete it.
    api.as_member(MEMBER_ID, "陈屿")
    response = api.client.patch(url(f"/todos/{todo_id}"), json={"priority": "low"})
    assert response.status_code == 200
    assert response.json()["data"]["todo"]["priority"] == "low"
    assert api.client.delete(url(f"/todos/{todo_id}")).status_code == 200

    # Guests cannot create todos when features.allowGuestTodoCreate is off (default).
    api.as_guest()
    response = api.client.post(url("/todos"), json={"title": "访客待办", "dueDate": tomorrow})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "authentication_required"


def test_todo_validation_errors(api: TestApi) -> None:
    api.as_member(MEMBER_ID)
    base = {"title": "校验测试", "dueDate": _iso(1)}
    invalid_payloads = [
        {**base, "dueDate": "2026-02-30"},
        {**base, "dueTime": "25:00"},
        {**base, "priority": "critical"},
        {**base, "reminderOffsetsDays": [61]},
        {**base, "reminderOffsetsDays": "3,1"},
        {**base, "reminderOffsetsDays": [-1]},
        {"dueDate": _iso(1)},
        {**base, "emailEnabled": "yes"},
    ]
    for payload in invalid_payloads:
        response = api.client.post(url("/todos"), json=payload)
        assert response.status_code == 422, payload
        assert response.json()["ok"] is False

    response = api.client.get(url("/todos"), params={"month": "2026-13"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_month"

    response = api.client.post(
        url("/todos"),
        json={"title": "月份查询", "dueDate": _iso(1), "assigneeMemberId": "m-missing"},
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------- red / black board


def test_redblack_put_roundtrip_and_rollover(api: TestApi) -> None:
    month = "2027-03"
    api.as_admin()
    body = {
        "month": month,
        "theme": "三月主题",
        "red": [
            {"memberId": "m-lin", "title": "高光时刻", "reason": "表现突出", "score": 96},
            {"memberName": "外部伙伴", "title": "协作之星", "reason": "支持到位", "score": 88},
        ],
        "black": [{"memberId": "m-chen", "title": "进度延期", "reason": "联调不足", "score": 60}],
    }
    response = api.client.put(url("/redblack"), json=body)
    assert response.status_code == 200
    board = response.json()["data"]["board"]
    assert board["month"] == month
    assert board["theme"] == "三月主题"
    assert len(board["red"]) == 2 and len(board["black"]) == 1
    assert board["red"][0]["memberName"] == "林知夏"  # derived from memberId
    assert board["red"][0]["score"] == 96

    # Guest can read the same board.
    api.as_guest()
    response = api.client.get(url("/redblack"), params={"month": month})
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["month"] == month
    assert len(data["board"]["red"]) == 2
    assert month in data["availableMonths"]

    # PUT replaces both sides transactionally.
    api.as_admin()
    replacement = {"month": month, "theme": "三月主题 · 修订", "red": [body["red"][1]], "black": []}
    response = api.client.put(url("/redblack"), json=replacement)
    assert response.status_code == 200
    assert len(response.json()["data"]["board"]["red"]) == 1
    assert response.json()["data"]["board"]["black"] == []

    # A non-admin member cannot write the board.
    api.as_member(MEMBER_ID)
    assert api.client.put(url("/redblack"), json=body).status_code == 403

    # Rollover creates the next month as an empty skeleton (theme carried over).
    api.as_admin()
    response = api.client.post(url("/redblack/rollover"), json={"fromMonth": month})
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["created"] is True
    assert data["month"] == "2027-04"
    assert data["board"]["red"] == [] and data["board"]["black"] == []
    assert data["board"]["theme"] == "三月主题 · 修订"

    # Rolling over again is idempotent.
    response = api.client.post(url("/redblack/rollover"), json={"fromMonth": month})
    assert response.status_code == 200
    assert response.json()["data"]["created"] is False

    # A month without a board returns null instead of 404.
    api.as_guest()
    response = api.client.get(url("/redblack"), params={"month": "2030-01"})
    assert response.status_code == 200
    assert response.json()["data"]["board"] is None
    assert response.json()["data"]["month"] == "2030-01"


# --------------------------------------------------------------------------- announcements


def test_pinned_announcement_limit_and_self_exclusion(api: TestApi) -> None:
    api.as_admin()
    # The seed already pins three announcements for grp-frontend.
    response = api.client.post(
        url("/announcements"),
        json={"title": "第四条置顶", "content": "超出上限", "pinned": True},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "pinned_limit_reached"

    # Free one slot.
    response = api.client.patch(url("/announcements/ann-grp-frontend-0"), json={"pinned": False})
    assert response.status_code == 200
    assert response.json()["data"]["announcement"]["pinned"] is False

    response = api.client.post(
        url("/announcements"),
        json={"title": "新的置顶公告", "content": "内容", "pinned": True, "level": "important"},
    )
    assert response.status_code == 200
    new_id = response.json()["data"]["announcement"]["id"]

    response = api.client.get(url("/announcements"))
    data = response.json()["data"]
    pinned = [item for item in data["announcements"] if item["pinned"]]
    assert len(pinned) == 3
    assert data["maxPinned"] == 3
    assert data["pinnedCount"] == 3
    assert pinned[0]["id"] == new_id  # pinned rows sort first; newest first inside pins
    assert pinned[0]["groupId"] == GROUP_ID

    # A fourth pin is still rejected.
    response = api.client.patch(url("/announcements/ann-grp-frontend-3"), json={"pinned": True})
    assert response.status_code == 409

    # Patching an already pinned row must exclude itself from the count.
    response = api.client.patch(
        url(f"/announcements/{new_id}"), json={"title": "改名后的置顶", "pinned": True}
    )
    assert response.status_code == 200
    assert response.json()["data"]["announcement"]["title"] == "改名后的置顶"

    assert api.client.delete(url(f"/announcements/{new_id}")).status_code == 200


# --------------------------------------------------------------------------- links / matrix / announcements CRUD


def test_links_matrix_and_announcements_crud(api: TestApi) -> None:
    api.as_admin()

    # Links
    response = api.client.post(
        url("/links"),
        json={"title": "新链接", "url": "https://example.com/new", "category": "工程"},
    )
    assert response.status_code == 200
    link = response.json()["data"]["link"]
    link_id = link["id"]
    assert link["groupId"] == GROUP_ID
    assert link["sortOrder"] >= 0
    response = api.client.patch(url(f"/links/{link_id}"), json={"title": "改名链接"})
    assert response.status_code == 200
    assert response.json()["data"]["link"]["title"] == "改名链接"
    assert api.client.post(url("/links"), json={"title": "坏链接", "url": "ftp://x"}).status_code == 422

    # Matrix
    response = api.client.post(
        url("/matrix"),
        json={
            "area": "新职责领域",
            "description": "职责说明",
            "ownerMemberId": "m-lin",
            "backupMemberId": MEMBER_ID,
            "channel": "飞书",
        },
    )
    assert response.status_code == 200
    area = response.json()["data"]["area"]
    area_id = area["id"]
    assert area["groupId"] == GROUP_ID
    assert area["ownerName"] == "林知夏"
    assert area["ownerColor"]
    assert area["backupName"] == "陈屿"
    response = api.client.patch(url(f"/matrix/{area_id}"), json={"contact": "#new-channel"})
    assert response.status_code == 200
    assert response.json()["data"]["area"]["contact"] == "#new-channel"

    # Announcements (non-pinned)
    response = api.client.post(
        url("/announcements"), json={"title": "普通公告", "content": "公告内容", "level": "info"}
    )
    assert response.status_code == 200
    announcement = response.json()["data"]["announcement"]
    announcement_id = announcement["id"]
    assert announcement["groupId"] == GROUP_ID
    assert announcement["pinned"] is False
    response = api.client.patch(
        url(f"/announcements/{announcement_id}"), json={"content": "更新后的内容"}
    )
    assert response.status_code == 200
    assert response.json()["data"]["announcement"]["content"] == "更新后的内容"

    # Guests may read all three collections.
    api.as_guest()
    assert api.client.get(url("/links")).status_code == 200
    assert api.client.get(url("/matrix")).status_code == 200
    assert api.client.get(url("/announcements")).status_code == 200

    # Admin cleanup.
    api.as_admin()
    assert api.client.delete(url(f"/links/{link_id}")).status_code == 200
    assert api.client.delete(url(f"/matrix/{area_id}")).status_code == 200
    assert api.client.delete(url(f"/announcements/{announcement_id}")).status_code == 200


# --------------------------------------------------------------------------- write gates / 404s


def test_guest_writes_are_unauthorized(api: TestApi) -> None:
    api.as_guest()
    tomorrow = _iso(1)
    requests = [
        ("post", url("/members"), {"name": "访客成员"}),
        ("patch", url("/members/m-chen"), {"title": "访客修改"}),
        ("delete", url("/members/m-chen"), None),
        ("post", url(f"/members/m-chen/works"), {"title": "访客工作"}),
        ("patch", url("/members/m-chen/works/work-chen-1"), {"title": "访客修改"}),
        ("delete", url("/members/m-chen/works/work-chen-1"), None),
        ("post", url("/todos"), {"title": "访客待办", "dueDate": tomorrow}),
        ("patch", url("/todos/todo-seed-01"), {"title": "访客修改"}),
        ("delete", url("/todos/todo-seed-01"), None),
        ("put", url("/redblack"), {"month": "2027-05"}),
        ("post", url("/redblack/rollover"), {}),
        ("post", url("/links"), {"title": "访客链接", "url": "https://example.com"}),
        ("patch", url("/links/link-grp-frontend-0"), {"title": "访客修改"}),
        ("delete", url("/links/link-grp-frontend-0"), None),
        ("post", url("/matrix"), {"area": "访客领域"}),
        ("patch", url("/matrix/matrix-grp-frontend-0"), {"area": "访客修改"}),
        ("delete", url("/matrix/matrix-grp-frontend-0"), None),
        ("post", url("/announcements"), {"title": "访客公告"}),
        ("patch", url("/announcements/ann-grp-frontend-0"), {"title": "访客修改"}),
        ("delete", url("/announcements/ann-grp-frontend-0"), None),
    ]
    for method, path, payload in requests:
        response = getattr(api.client, method)(path, json=payload) if payload is not None else getattr(
            api.client, method
        )(path)
        assert response.status_code == 401, (method, path, response.status_code)


def test_member_cannot_write_admin_boards(api: TestApi) -> None:
    api.as_member(MEMBER_ID)
    checks = [
        ("post", url("/members"), {"name": "越权成员"}),
        ("post", url("/links"), {"title": "越权链接", "url": "https://example.com"}),
        ("post", url("/matrix"), {"area": "越权领域"}),
        ("post", url("/announcements"), {"title": "越权公告"}),
        ("put", url("/redblack"), {"month": "2027-05"}),
        ("post", url("/redblack/rollover"), {}),
    ]
    for method, path, payload in checks:
        response = getattr(api.client, method)(path, json=payload)
        assert response.status_code == 403, (method, path, response.status_code)


def test_in_scope_group_admin_can_write(api: TestApi) -> None:
    api.as_group_admin()
    response = api.client.put(
        url("/redblack"),
        json={"month": "2027-06", "theme": "分组管理员写入", "red": [], "black": []},
    )
    assert response.status_code == 200
    assert response.json()["data"]["board"]["theme"] == "分组管理员写入"


def test_missing_resources_return_404(api: TestApi) -> None:
    api.as_admin()
    checks = [
        ("patch", url("/members/m-lin/works/work-missing"), {"title": "x"}),
        ("delete", url("/members/m-lin/works/work-missing"), None),
        ("patch", url("/todos/todo-missing"), {"title": "x"}),
        ("delete", url("/todos/todo-missing"), None),
        ("patch", url("/links/link-missing"), {"title": "x"}),
        ("delete", url("/links/link-missing"), None),
        ("patch", url("/matrix/matrix-missing"), {"area": "x"}),
        ("delete", url("/matrix/matrix-missing"), None),
        ("patch", url("/announcements/ann-missing"), {"title": "x"}),
        ("delete", url("/announcements/ann-missing"), None),
    ]
    for method, path, payload in checks:
        response = getattr(api.client, method)(path, json=payload) if payload is not None else getattr(
            api.client, method
        )(path)
        assert response.status_code == 404, (method, path, response.status_code)
        assert response.json()["ok"] is False
