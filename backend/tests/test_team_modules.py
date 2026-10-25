"""Team-scoped feature routers: overview, members, works, todos, boards and permissions.

Replaces the deleted group-scoped ``test_group_modules.py``. Every URL is team based and
identities are created through the real auth paths (device Admin over loopback,
whitelisted ``team_admin`` IP, e-mail login of a seeded member).
"""

from __future__ import annotations

from datetime import date, timedelta

from backend.tests.helpers import (
    TEAM_AURORA,
    TEAM_VOYAGE,
    assert_error,
    create_account,
    create_member,
    data,
    email_login,
    error,
    ip_admin,
    me,
    member_by_email,
    members_of,
    overview,
    remote_client,
)


def _url(path: str, team_id: str = TEAM_AURORA) -> str:
    return f"/api/teams/{team_id}{path}"


def _days(offset: int) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


# --------------------------------------------------------------------------- overview


def test_overview_returns_team_members_works_and_workloads(client):
    payload = overview(client)
    assert payload["team"]["id"] == TEAM_AURORA
    assert payload["team"]["name"] == "极光产品团队"
    assert len(payload["members"]) == 12
    assert payload["works"]
    assert payload["recentActivity"]

    stats = payload["stats"]
    assert stats["members"] == len(payload["members"])
    assert stats["works"] == len(payload["works"])
    assert stats["todos"] >= 0

    member_ids = [member["id"] for member in payload["members"]]
    workload_ids = [item["memberId"] for item in payload["workloads"]]
    assert set(member_ids) == set(workload_ids)
    summary = payload["workloadSummary"]
    assert summary["members"] == len(payload["members"])
    for legacy in ("currentHours", "averageHours", "capacityHours"):
        assert legacy not in summary

    # Round 9 requirement #3: members follow the manual sort_order, not the name.
    ordered = payload["members"]
    assert [member["sortOrder"] for member in ordered] == list(range(1, 13))
    assert [member["id"] for member in ordered] == [
        "m-lin",
        "m-chen",
        "m-su",
        "m-he",
        "m-tang",
        "m-zhou",
        "m-wu",
        "m-xu",
        "m-luo",
        "m-yu",
        "m-qin",
        "m-shen",
    ]
    assert ordered[0]["groupId"] == ""
    assert ordered[0]["groupName"] == ""
    assert payload["memberGroups"] == []
    # Round 9 requirement #8: works expose plannedDate instead of the legacy period.
    assert all("plannedDate" in work and "period" not in work for work in payload["works"])


def test_unknown_team_and_member_return_404(client):
    payload = assert_error(client.get(_url("/overview", "team-missing")), 404, "team_not_found")
    assert payload["message"] == "团队不存在"

    assert_error(
        client.patch(_url("/members/m-missing"), json={"title": "x"}),
        404,
        "member_not_found",
    )
    assert_error(
        client.get(_url("/members/m-missing/works")), 404, "member_not_found"
    )

    # A member of another team is not visible through this team's URL.
    assert_error(
        client.patch(_url(f"/members/{member_by_id_in_voyage(client)}"), json={"title": "x"}),
        404,
        "member_not_found",
    )


def member_by_id_in_voyage(client) -> str:
    return members_of(client, TEAM_VOYAGE)[0]["id"]


# --------------------------------------------------------------------------- member write rules


def test_admin_creates_updates_and_deletes_member(client):
    account = create_account(client, "new.member@corp.example", name="新成员")
    member = create_member(
        client, account["id"], title="测试工程师", role="核心成员"
    )
    assert member["name"] == "新成员"
    assert member["email"] == "new.member@corp.example"
    assert member["title"] == "测试工程师"
    assert "status" not in member
    assert "avatar" in member

    updated = data(
        client.patch(_url(f"/members/{member['id']}"), json={"title": "资深工程师"})
    )["member"]
    assert updated["title"] == "资深工程师"
    assert updated["role"] == "核心成员"

    # Round 8 removed the member availability status: a legacy payload is ignored.
    ignored = data(
        client.patch(_url(f"/members/{member['id']}"), json={"status": "busy"})
    )["member"]
    assert "status" not in ignored
    assert ignored["title"] == "资深工程师"

    # The member card is part of the overview now.
    assert any(item["id"] == member["id"] for item in members_of(client))

    # Deleting removes the member and their works.
    data(client.post(_url(f"/members/{member['id']}/works"), json={"title": "临时工作项"}))
    deleted = data(client.delete(_url(f"/members/{member['id']}")))
    assert deleted == {"deleted": True, "id": member["id"]}
    assert all(item["id"] != member["id"] for item in members_of(client))
    assert client.get(_url(f"/members/{member['id']}/works")).status_code == 404


def test_member_self_edit_only_linked_member(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    lin = member_by_email(client, "lin.zhixia@corp.example")
    with remote_client("10.20.30.92", 51402) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert me(browser)["linkedMemberId"] == chen["id"]

        updated = browser.patch(_url(f"/members/{chen['id']}"), json={"bio": "本人更新"})
        assert updated.status_code == 200, updated.text

        denied = browser.patch(_url(f"/members/{lin['id']}"), json={"bio": "越权"})
        assert_error(denied, 403, "personal_info_forbidden")

        # Organizational fields of another member stay admin-only.
        denied = browser.patch(_url(f"/members/{lin['id']}"), json={"title": "越权"})
        assert denied.status_code == 403


def test_member_cannot_create_or_delete_members(client, monkeypatch):
    account = create_account(client, "untouchable@corp.example", name="不可动成员")
    member = create_member(client, account["id"])
    chen = member_by_email(client, "chen.yu@corp.example")
    with remote_client("10.20.30.93", 51403) as browser:
        email_login(browser, chen["email"], monkeypatch)
        assert browser.post(_url("/members"), json={"userId": account["id"]}).status_code == 403
        assert browser.delete(_url(f"/members/{member['id']}")).status_code == 403


# --------------------------------------------------------------------------- works


def test_member_work_crud_and_permissions(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    lin = member_by_email(client, "lin.zhixia@corp.example")
    with remote_client("10.20.30.94", 51404) as browser:
        email_login(browser, chen["email"], monkeypatch)

        created = data(
            browser.post(
                _url(f"/members/{chen['id']}/works"),
                json={
                    "title": "本人工作项",
                    "description": "自编辑",
                    "status": "current",
                    "plannedDate": "2026-12-31",
                    "category": "体验",
                    "progress": 30,
                },
            )
        )["work"]
        assert created["memberId"] == chen["id"]
        assert created["teamId"] == TEAM_AURORA
        assert created["status"] == "current"
        assert created["plannedDate"] == "2026-12-31"
        assert "period" not in created
        assert "groupId" not in created

        updated = data(
            browser.patch(
                _url(f"/members/{chen['id']}/works/{created['id']}"),
                json={"progress": 80, "status": "done"},
            )
        )["work"]
        assert updated["progress"] == 80

        # Another member's works are not editable by a plain member.
        denied = browser.post(
            _url(f"/members/{lin['id']}/works"), json={"title": "越权工作项"}
        )
        assert denied.status_code == 403

        works = data(browser.get(_url(f"/members/{chen['id']}/works")))["works"]
        assert any(item["id"] == created["id"] for item in works)

        deleted = data(browser.delete(_url(f"/members/{chen['id']}/works/{created['id']}")))
        assert deleted["deleted"] is True


def test_admin_creates_work_for_any_member(client):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    work = data(
        client.post(_url(f"/members/{lin['id']}/works"), json={"title": "管理员创建的工作"})
    )["work"]
    assert work["title"] == "管理员创建的工作"
    assert work["teamName"] == "极光产品团队"


# --------------------------------------------------------------------------- todos


def test_todo_lifecycle_for_member_self(client, monkeypatch):
    chen = member_by_email(client, "chen.yu@corp.example")
    lin = member_by_email(client, "lin.zhixia@corp.example")
    with remote_client("10.20.30.95", 51405) as browser:
        email_login(browser, chen["email"], monkeypatch)

        created = data(
            browser.post(
                _url("/todos"),
                json={"title": "本人待办", "dueDate": _days(3), "priority": "high"},
            )
        )["todo"]
        assert created["assigneeMemberId"] == chen["id"]
        assert created["teamId"] == TEAM_AURORA
        assert "groupId" not in created

        completed = data(
            browser.patch(_url(f"/todos/{created['id']}"), json={"status": "done"})
        )["todo"]
        assert completed["status"] == "done"

        # Another member's todo cannot be modified.
        other = data(
            client.post(
                _url("/todos"),
                json={
                    "title": "别人的待办",
                    "dueDate": _days(4),
                    "assigneeMemberId": lin["id"],
                },
            )
        )["todo"]
        denied = browser.patch(_url(f"/todos/{other['id']}"), json={"title": "越权"})
        assert denied.status_code == 403

        # Only admins may create todos assigned to someone else.
        denied = browser.post(
            _url("/todos"),
            json={"title": "指派他人", "dueDate": _days(5), "assigneeMemberId": lin["id"]},
        )
        assert denied.status_code == 403


def test_todo_validation_and_admin_reassign(client):
    invalid = [
        {},
        {"title": ""},
        {"title": "x", "dueDate": "2026/10/01"},
        {"title": "x", "dueDate": _days(2), "priority": "critical"},
        {"title": "x" * 121, "dueDate": _days(2)},
    ]
    for body in invalid:
        response = client.post(_url("/todos"), json=body)
        assert response.status_code == 422, (body, response.text)

    lin = member_by_email(client, "lin.zhixia@corp.example")
    chen = member_by_email(client, "chen.yu@corp.example")
    todo = data(
        client.post(
            _url("/todos"),
            json={"title": "可重新指派", "dueDate": _days(2), "assigneeMemberId": lin["id"]},
        )
    )["todo"]
    reassigned = data(
        client.patch(
            _url(f"/todos/{todo['id']}"), json={"assigneeMemberId": chen["id"]}
        )
    )["todo"]
    assert reassigned["assigneeMemberId"] == chen["id"]
    assert "assigneeAvatar" in reassigned


# --------------------------------------------------------------------------- red / black board


def test_redblack_put_roundtrip_rollover_and_permissions(client):
    month = "2030-03"
    lin = member_by_email(client, "lin.zhixia@corp.example")
    chen = member_by_email(client, "chen.yu@corp.example")
    body = {
        "month": month,
        "theme": "三月主题",
        "red": [
            {"memberId": lin["id"], "title": "高光时刻", "reason": "表现突出", "score": 96},
            {"memberName": "外部成员", "title": "协作之星", "reason": "支持到位", "score": 88},
        ],
        "black": [
            {"memberId": chen["id"], "title": "进度延期", "reason": "联调不足", "score": 60}
        ],
    }
    response = data(client.put(_url("/redblack"), json=body))
    board = response["board"]
    assert board["month"] == month
    assert board["theme"] == "三月主题"
    assert len(board["red"]) == 2 and len(board["black"]) == 1
    assert board["red"][0]["memberName"] == "林知夏"
    assert board["red"][0]["memberAvatar"] is not None
    assert "groupId" not in board["red"][0]
    assert month in response["availableMonths"]

    # The board is readable from the same team-scoped URL (team perspective only).
    listed = data(client.get(_url("/redblack"), params={"month": month}))
    assert "boards" not in listed
    assert listed["board"]["month"] == month

    # PUT replaces both sides.
    replacement = {"month": month, "theme": "修订主题", "red": [body["red"][1]], "black": []}
    replaced = data(client.put(_url("/redblack"), json=replacement))["board"]
    assert len(replaced["red"]) == 1
    assert replaced["black"] == []

    # Rollover copies the theme into the next month.
    rolled = data(
        client.post(_url("/redblack/rollover"), json={"fromMonth": month, "toMonth": "2030-04"})
    )
    assert rolled["month"] == "2030-04"
    assert "2030-04" in rolled["availableMonths"]


def test_member_writes_links_but_not_admin_boards(client, monkeypatch):
    """Round 9 requirement #6: any team member may maintain the link board."""
    lin = member_by_email(client, "lin.zhixia@corp.example")
    body = {"month": "2030-05", "theme": "", "red": [], "black": []}
    with remote_client("10.20.30.96", 51406) as browser:
        email_login(browser, lin["email"], monkeypatch)
        assert browser.put(_url("/redblack"), json=body).status_code == 403
        created = browser.post(
            _url("/links"),
            json={"title": "成员链接", "url": "https://example.com/member"},
        )
        assert created.status_code == 200, created.text
        link = data(created)["link"]
        assert link["teamId"] == TEAM_AURORA
        assert (
            browser.patch(_url(f"/links/{link['id']}"), json={"title": "成员链接 2"}).status_code
            == 200
        )
        assert browser.delete(_url(f"/links/{link['id']}")).status_code == 200
        assert browser.post(_url("/announcements"), json={"title": "x", "content": "y"}).status_code == 403
        assert browser.post(_url("/matrix"), json={"area": "x"}).status_code == 403
        # The tag library is intentionally member-editable (only guests are rejected).
        tag = browser.post(_url("/task-tags"), json={"name": "成员标签"}).status_code
        assert tag == 200


def test_in_scope_team_admin_can_write():
    with ip_admin(TEAM_AURORA, ip="10.91.1.10", port=51410) as admin:
        created = admin.post(
            _url("/links"), json={"title": "团队管理员链接", "url": "https://example.com/ok"}
        )
        assert created.status_code == 200, created.text
        assert data(created)["link"]["teamId"] == TEAM_AURORA

        body = {"month": "2031-01", "theme": "团队主题", "red": [], "black": []}
        assert admin.put(_url("/redblack"), json=body).status_code == 200
        assert (
            admin.post(_url("/announcements"), json={"title": "团队公告", "content": "内容"}).status_code
            == 200
        )

        denied = admin.post(
            _url("/links", TEAM_VOYAGE),
            json={"title": "越权链接", "url": "https://example.com/no"},
        )
        assert_error(denied, 403, "not_admin")


# --------------------------------------------------------------------------- links / matrix / announcements


def test_links_matrix_and_announcements_crud(client):
    link = data(
        client.post(
            _url("/links"),
            json={"title": "文档中心", "url": "https://example.com/docs", "category": "资源"},
        )
    )["link"]
    assert link["teamId"] == TEAM_AURORA
    assert "groupId" not in link
    updated = data(
        client.patch(_url(f"/links/{link['id']}"), json={"title": "文档中心 2"})
    )["link"]
    assert updated["title"] == "文档中心 2"
    assert data(client.delete(_url(f"/links/{link['id']}")))["deleted"] is True

    lin = member_by_email(client, "lin.zhixia@corp.example")
    chen = member_by_email(client, "chen.yu@corp.example")
    area = data(
        client.post(
            _url("/matrix"),
            json={
                "area": "职责矩阵项",
                "description": "说明",
                "ownerMemberId": lin["id"],
                "backupMemberIds": [chen["id"]],
                "channel": "飞书",
                "contact": "#channel",
            },
        )
    )["area"]
    assert area["ownerMemberId"] == lin["id"]
    assert area["backupMemberIds"] == [chen["id"]]
    assert "ownerAvatar" in area
    assert "avatar" in area["backups"][0]
    assert "groupId" not in area
    patched = data(
        client.patch(_url(f"/matrix/{area['id']}"), json={"description": "更新说明"})
    )["area"]
    assert patched["description"] == "更新说明"
    assert data(client.delete(_url(f"/matrix/{area['id']}")))["deleted"] is True

    announcement = data(
        client.post(
            _url("/announcements"),
            json={"title": "新公告", "content": "公告内容", "level": "important"},
        )
    )["announcement"]
    assert announcement["teamId"] == TEAM_AURORA
    assert "authorAvatar" in announcement
    assert "groupId" not in announcement
    patched = data(
        client.patch(
            _url(f"/announcements/{announcement['id']}"), json={"title": "公告标题更新"}
        )
    )["announcement"]
    assert patched["title"] == "公告标题更新"
    assert data(client.delete(_url(f"/announcements/{announcement['id']}")))["deleted"] is True

    # The collections stay readable.
    assert data(client.get(_url("/links")))["links"] is not None
    assert data(client.get(_url("/matrix")))["areas"] is not None
    assert data(client.get(_url("/announcements")))["announcements"] is not None


def test_missing_resources_return_404(client):
    assert_error(client.patch(_url("/links/link-missing"), json={"title": "x"}), 404, "link_not_found")
    assert_error(client.delete(_url("/links/link-missing")), 404, "link_not_found")
    assert_error(client.patch(_url("/matrix/area-missing"), json={"area": "x"}), 404, "matrix_not_found")
    assert_error(client.delete(_url("/matrix/area-missing")), 404, "matrix_not_found")
    assert_error(
        client.patch(_url("/announcements/ann-missing"), json={"title": "x"}),
        404,
        "announcement_not_found",
    )
    assert_error(client.delete(_url("/announcements/ann-missing")), 404, "announcement_not_found")
    assert_error(client.patch(_url("/tasks/task-missing"), json={"title": "x"}), 404, "task_not_found")
    assert_error(client.delete(_url("/todos/todo-missing")), 404, "todo_not_found")


def test_guest_writes_are_unauthorized(guest_client):
    endpoints = [
        ("post", _url("/todos"), {"title": "访客", "dueDate": _days(2)}),
        ("post", _url("/links"), {"title": "访客", "url": "https://example.com"}),
        ("post", _url("/matrix"), {"area": "访客"}),
        ("post", _url("/announcements"), {"title": "访客", "content": "x"}),
        ("put", _url("/redblack"), {"month": "2032-01", "red": [], "black": []}),
    ]
    for method, path, payload in endpoints:
        response = guest_client.request(method.upper(), path, json=payload)
        assert response.status_code in (401, 403), (method, path, response.text)
        assert error(response)["code"] in {"authentication_required", "not_admin"}


def test_cross_team_content_is_isolated(client):
    voyage_member = members_of(client, TEAM_VOYAGE)[0]
    voyage_link = data(
        client.post(
            _url("/links", TEAM_VOYAGE),
            json={"title": "远航链接", "url": "https://example.com/voyage"},
        )
    )["link"]
    aurora_links = data(client.get(_url("/links")))["links"]
    assert all(item["id"] != voyage_link["id"] for item in aurora_links)
    voyage_links = data(client.get(_url("/links", TEAM_VOYAGE)))["links"]
    assert any(item["id"] == voyage_link["id"] for item in voyage_links)

    # A voyage member is invisible from the aurora URL.
    assert_error(
        client.patch(_url(f"/members/{voyage_member['id']}"), json={"title": "x"}),
        404,
        "member_not_found",
    )


# ------------------------------------------------------- member order / groups (round 9)


def test_work_planned_date_validation(client):
    """Round 9 requirement #8: plannedDate replaces the free-form period label."""
    chen = member_by_email(client, "chen.yu@corp.example")
    for bad in ("2026 Q4", "2026-13-01", "2026-02-30", "31/12/2026"):
        assert_error(
            client.post(
                _url(f"/members/{chen['id']}/works"),
                json={"title": "校验工作", "plannedDate": bad},
            ),
            400,
            "invalid_planned_date",
        )
    work = data(
        client.post(
            _url(f"/members/{chen['id']}/works"),
            json={"title": "日期工作", "plannedDate": "2027-01-05"},
        )
    )["work"]
    assert work["plannedDate"] == "2027-01-05"
    cleared = data(
        client.patch(_url(f"/members/{chen['id']}/works/{work['id']}"), json={"plannedDate": ""})
    )["work"]
    assert cleared["plannedDate"] == ""


def test_team_admin_reorders_members(client):
    """Round 9 requirement #3: the manual member order is persisted and honoured."""
    payload = overview(client)
    member_ids = [member["id"] for member in payload["members"]]
    reversed_ids = list(reversed(member_ids))

    reordered = data(client.patch(_url("/members/order"), json={"memberIds": reversed_ids}))
    assert [member["id"] for member in reordered["members"]] == reversed_ids
    assert [member["sortOrder"] for member in reordered["members"]] == list(range(12))

    refreshed = overview(client)
    assert [member["id"] for member in refreshed["members"]] == reversed_ids

    # Restore the seeded order so later tests keep a stable fixture baseline.
    data(client.patch(_url("/members/order"), json={"memberIds": member_ids}))
    assert [member["id"] for member in overview(client)["members"]] == member_ids


def test_member_order_validation(client):
    member_ids = [member["id"] for member in overview(client)["members"]]
    invalid_bodies = (
        {},
        {"memberIds": "m-lin"},
        {"memberIds": []},
        {"memberIds": member_ids[:-1]},
        {"memberIds": member_ids[:-1] + ["m-gu"]},
        {"memberIds": member_ids + [member_ids[0]]},
        {"memberIds": member_ids[:-1] + [""]},
        {"memberIds": member_ids[:-1] + [123]},
    )
    for body in invalid_bodies:
        assert_error(
            client.patch(_url("/members/order"), json=body), 400, "validation_error"
        )
    # A rejected request must not have altered any order.
    assert [member["id"] for member in overview(client)["members"]] == member_ids


def test_plain_member_cannot_reorder_or_regroup(client, monkeypatch):
    lin = member_by_email(client, "lin.zhixia@corp.example")
    member_ids = [member["id"] for member in overview(client)["members"]]
    with remote_client("10.20.30.97", 51407) as browser:
        email_login(browser, lin["email"], monkeypatch)
        assert (
            browser.patch(_url("/members/order"), json={"memberIds": member_ids}).status_code
            == 403
        )
        assert (
            browser.patch(_url(f"/members/{lin['id']}"), json={"groupId": ""}).status_code
            == 403
        )


def test_members_can_be_grouped(client):
    """Round 9 requirement #8: member groups live on the member profile."""
    group = data(
        client.post(
            _url("/groups"),
            json={"kind": "member", "name": "前端小组", "color": "#2563eb"},
        )
    )["group"]
    assert group["kind"] == "member"
    assert group["name"] == "前端小组"

    chen = member_by_email(client, "chen.yu@corp.example")
    updated = data(
        client.patch(_url(f"/members/{chen['id']}"), json={"groupId": group["id"]})
    )["member"]
    assert updated["groupId"] == group["id"]
    assert updated["groupName"] == "前端小组"

    refreshed = overview(client)
    listed = next(item for item in refreshed["memberGroups"] if item["id"] == group["id"])
    assert listed["memberCount"] == 1
    card = next(item for item in refreshed["members"] if item["id"] == chen["id"])
    assert card["groupId"] == group["id"]
    assert card["groupName"] == "前端小组"

    # Unknown groups and groups of the wrong kind are rejected.
    assert_error(
        client.patch(_url(f"/members/{chen['id']}"), json={"groupId": "g-missing"}),
        400,
        "group_not_found",
    )
    task_group = data(
        client.post(_url("/groups"), json={"kind": "task", "name": "任务小组"})
    )["group"]
    assert_error(
        client.patch(_url(f"/members/{chen['id']}"), json={"groupId": task_group["id"]}),
        400,
        "group_not_found",
    )

    cleared = data(
        client.patch(_url(f"/members/{chen['id']}"), json={"groupId": ""})
    )["member"]
    assert cleared["groupId"] == ""
    assert cleared["groupName"] == ""

