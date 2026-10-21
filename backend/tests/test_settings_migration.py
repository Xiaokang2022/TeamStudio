"""Round-8 settings migration (§1.3): version 2 -> version 3.

Loading an existing ``data/settings.json`` must add ``guestModules``, drop the
development-group whitelist fields (``groupIds`` / ``role='group_admin'``), keep
``site.theme.mode`` only as an unused compatibility field and bump the version. The
migration is also applied when a legacy configuration is submitted to the settings API?
No: API payloads are validated strictly, only file loads sanitize legacy grants.
"""

from __future__ import annotations

import json

from backend.app.config import (
    DEFAULT_SETTINGS,
    GuestModuleFlags,
    Settings,
    SettingsService,
    migrate_legacy_settings,
)

V2_WHITELIST_IP = {
    "ip": "10.80.0.0/16",
    "name": "旧组管理员",
    "role": "group_admin",
    "teamId": "team-aurora",
    "groupIds": [],
}


def _legacy_v2_payload() -> dict:
    raw = DEFAULT_SETTINGS.model_dump(mode="json")
    raw["version"] = 2
    raw.pop("guestModules", None)
    raw["modules"]["email"] = True
    raw["site"]["theme"]["mode"] = "dark"
    raw["auth"]["adminWhitelist"]["ips"] = [dict(V2_WHITELIST_IP)]
    raw["auth"]["adminWhitelist"]["ids"] = [
        {
            "id": "legacy.admin@corp.example",
            "name": "旧组管理员",
            "role": "group_admin",
            "teamId": "team-aurora",
            "groupIds": ["grp-frontend"],
        },
        {
            "id": "noteam.admin@corp.example",
            "name": "无团队管理员",
            "role": "group_admin",
            "teamId": "",
            "groupIds": ["grp-data"],
        },
        {
            "id": "valid.admin@corp.example",
            "name": "团队管理员",
            "role": "team_admin",
            "teamId": "team-voyage",
            "groupIds": [],
        },
    ]
    return raw


# --------------------------------------------------------------------------- pure migration


def test_migrate_legacy_settings_adds_guest_modules_and_cleans_whitelist():
    raw, changed = migrate_legacy_settings(_legacy_v2_payload())
    assert changed is True
    assert raw["version"] == 3

    guest_modules = raw["guestModules"]
    assert guest_modules["settings"] is False
    for module in (
        "overview",
        "calendar",
        "redblack",
        "links",
        "matrix",
        "announcements",
        "tasks",
        "insights",
    ):
        assert guest_modules[module] is True, module

    # Legacy ``modules.email`` is removed.
    assert "email" not in raw["modules"]

    # Whitelist grants become team-admin grants without ``groupIds``.
    ips = raw["auth"]["adminWhitelist"]["ips"]
    assert len(ips) == 1
    assert ips[0]["role"] == "team_admin"
    assert ips[0]["teamId"] == "team-aurora"
    assert "groupIds" not in ips[0]

    ids = raw["auth"]["adminWhitelist"]["ids"]
    assert [entry["id"] for entry in ids] == [
        "legacy.admin@corp.example",
        "valid.admin@corp.example",
    ]
    for entry in ids:
        assert entry["role"] == "team_admin"
        assert "groupIds" not in entry
    # A group grant without a team can never be expressed as a team grant.
    assert all(entry["id"] != "noteam.admin@corp.example" for entry in ids)

    # The cleaned payload validates against the version-3 model.
    validated = Settings.model_validate(raw)
    assert validated.version == 3
    assert isinstance(validated.guestModules, GuestModuleFlags)

    # ``site.theme.mode`` is kept as-is, although it no longer decides light/dark.
    assert raw["site"]["theme"]["mode"] == "dark"


def test_migrate_is_idempotent():
    once, changed = migrate_legacy_settings(_legacy_v2_payload())
    assert changed is True
    twice, changed_again = migrate_legacy_settings(json.loads(json.dumps(once)))
    assert changed_again is False
    assert twice == once


def test_unknown_site_theme_mode_falls_back_to_auto():
    raw = _legacy_v2_payload()
    raw["site"]["theme"]["mode"] = "system"
    clean, changed = migrate_legacy_settings(raw)
    assert changed is True
    assert clean["site"]["theme"]["mode"] == "auto"


def test_invalid_guest_module_values_fall_back_to_defaults():
    raw = _legacy_v2_payload()
    raw["guestModules"] = {"tasks": "yes", "settings": 0}
    clean, _ = migrate_legacy_settings(raw)
    assert clean["guestModules"]["tasks"] is True  # invalid -> default True
    assert clean["guestModules"]["settings"] is False


# --------------------------------------------------------------------------- file based service


def test_settings_service_reload_migrates_and_rewrites_the_file(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(_legacy_v2_payload(), ensure_ascii=False), encoding="utf-8")

    service = SettingsService(path)
    loaded = service.get()
    assert loaded.version == 3
    assert loaded.guestModules.settings is False
    assert loaded.site.theme.mode == "dark"

    # The upgraded file is persisted atomically, so a restart reads version 3 directly.
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["version"] == 3
    assert "guestModules" in on_disk
    assert "email" not in on_disk["modules"]
    assert on_disk["auth"]["adminWhitelist"]["ips"][0]["role"] == "team_admin"
    assert "groupIds" not in on_disk["auth"]["adminWhitelist"]["ips"][0]

    # Reloading the already-migrated file is a no-op.
    before = path.read_text(encoding="utf-8")
    service.reload()
    assert path.read_text(encoding="utf-8") == before


def test_settings_without_guest_modules_gets_public_defaults(tmp_path):
    raw = DEFAULT_SETTINGS.model_dump(mode="json")
    raw.pop("guestModules", None)
    raw["version"] = 2
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    loaded = SettingsService(path).get()
    assert loaded.guestModules.model_dump() == GuestModuleFlags().model_dump()
