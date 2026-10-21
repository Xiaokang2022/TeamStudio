"""Round-8 requirement #6: admins decide which modules guests may read.

``settings.guestModules`` is enforced on the server by ``require_read_module``: a
disabled module answers unauthenticated guests with ``403 guest_module_disabled`` while
authenticated users keep normal read access. The public config exposes the same flags so
the SPA can hide the navigation entries.
"""

from __future__ import annotations

from backend.tests.helpers import (
    TEAM_AURORA,
    bootstrap,
    data,
    email_login,
    error,
    member_by_email,
    remote_client,
)

GUEST_READ_ENDPOINTS = {
    "overview": "/overview",
    "tasks": "/tasks",
    "calendar": "/todos",
    "redblack": "/redblack",
    "links": "/links",
    "matrix": "/matrix",
    "announcements": "/announcements",
    "insights": "/insights",
}


def _save_guest_modules(client, **flags: bool) -> dict:
    payload = data(client.get("/api/settings"))["settings"]
    payload["guestModules"].update(flags)
    saved = data(client.put("/api/settings", json=payload))["settings"]
    assert saved["guestModules"].items() >= flags.items()
    return saved


def _team_url(module: str) -> str:
    return f"/api/teams/{TEAM_AURORA}{GUEST_READ_ENDPOINTS[module]}"


# --------------------------------------------------------------------------- defaults


def test_default_guest_modules_allow_read_only_except_settings(guest_client):
    config = bootstrap(guest_client)["config"]
    guest_modules = config["guestModules"]
    assert guest_modules["settings"] is False
    for module in GUEST_READ_ENDPOINTS:
        assert guest_modules[module] is True, module
        response = guest_client.get(_team_url(module))
        assert response.status_code == 200, (module, response.text)

    # The settings module is super-admin only, so guests never reach it.
    assert guest_client.get("/api/settings").status_code == 403


# --------------------------------------------------------------------------- per-module switch


def test_admin_disables_single_guest_module(client, guest_client):
    _save_guest_modules(client, tasks=False)

    # The public config drives the SPA navigation.
    assert bootstrap(guest_client)["config"]["guestModules"]["tasks"] is False

    denied = guest_client.get(_team_url("tasks"))
    assert denied.status_code == 403, denied.text
    assert error(denied)["code"] == "guest_module_disabled"

    # Task tags belong to the tasks module.
    denied_tags = guest_client.get(f"/api/teams/{TEAM_AURORA}/task-tags")
    assert denied_tags.status_code == 403
    assert error(denied_tags)["code"] == "guest_module_disabled"

    # Other modules stay readable; nothing leaks through the disabled one.
    assert guest_client.get(_team_url("overview")).status_code == 200
    assert guest_client.get(_team_url("calendar")).status_code == 200

    # Re-enabling restores the guest read path immediately.
    _save_guest_modules(client, tasks=True)
    assert guest_client.get(_team_url("tasks")).status_code == 200


def test_each_guest_module_can_be_switched_independently(client, guest_client):
    for module in GUEST_READ_ENDPOINTS:
        _save_guest_modules(client, **{module: False})
        denied = guest_client.get(_team_url(module))
        assert denied.status_code == 403, (module, denied.text)
        assert error(denied)["code"] == "guest_module_disabled", module
        _save_guest_modules(client, **{module: True})
        assert guest_client.get(_team_url(module)).status_code == 200, module


def test_authenticated_members_keep_access_to_disabled_guest_module(client, monkeypatch):
    member = member_by_email(client, "lin.zhixia@corp.example")
    _save_guest_modules(client, tasks=False, calendar=False)

    with remote_client("10.20.30.81", 51301) as browser:
        email_login(browser, member["email"], monkeypatch)
        assert browser.get(f"/api/teams/{TEAM_AURORA}/tasks").status_code == 200
        assert browser.get(f"/api/teams/{TEAM_AURORA}/task-tags").status_code == 200
        assert browser.get(f"/api/teams/{TEAM_AURORA}/todos").status_code == 200


def test_guest_module_settings_cannot_be_edited_by_guest(client, guest_client):
    payload = data(client.get("/api/settings"))["settings"]
    payload["guestModules"]["tasks"] = False
    assert guest_client.put("/api/settings", json=payload).status_code == 403
    # The attempted change did not stick.
    assert bootstrap(guest_client)["config"]["guestModules"]["tasks"] is True


def test_module_flag_off_blocks_everyone_at_the_router(client, guest_client):
    """Turning the global module flag off disables the router for guests as well."""
    payload = data(client.get("/api/settings"))["settings"]
    payload["modules"]["links"] = False
    saved = data(client.put("/api/settings", json=payload))["settings"]
    assert saved["modules"]["links"] is False
    assert bootstrap(guest_client)["config"]["modules"]["links"] is False

    response = guest_client.get(f"/api/teams/{TEAM_AURORA}/links")
    assert response.status_code == 403
    assert error(response)["code"] == "guest_module_disabled"
