"""Deployment-device Admin detection (round-8 requirement #5).

The real client IP decides whether the built-in ``Admin`` identity is available. Loopback,
local IPv4/IPv6 addresses (including ``::ffff:`` mapped forms), ``localhost`` and the
``testclient`` ASGI host count as the deployment device; remote IPs do not. A local peer
whose forwarding headers carry a remote real IP (a local reverse proxy) is *not* the
deployment device either.
"""

from __future__ import annotations

import pytest

from backend.tests.helpers import (
    TEAM_AURORA,
    capture_email_codes,
    data,
    email_login,
    enable_email,
    error,
    me,
    remote_client,
)

LOCAL_CLIENT_IPS = ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1", "testclient"]
REMOTE_CLIENT_IPS = ["203.0.113.9", "10.20.30.40", "198.51.100.77"]


def _browser(ip: str, port: int = 51100):
    return remote_client(ip, port)


# --------------------------------------------------------------------------- device Admin session


def test_device_admin_logout_and_restore(client):
    payload = me(client)
    assert payload["isDeviceAdmin"] is True
    assert payload["deployDevice"] is True
    assert payload["deviceAdminActive"] is True

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert logout.json()["data"]["endSessionUrl"] is None

    guest = me(client)
    assert guest["authenticated"] is False
    assert guest["source"] == "guest"
    assert guest["isDeviceAdmin"] is False
    assert guest["deployDevice"] is True
    assert guest["deviceAdminActive"] is False
    assert client.get("/api/settings").status_code == 403
    assert client.get("/api/users").status_code == 403

    restored = client.post("/api/auth/device/login")
    assert restored.status_code == 200
    assert data(restored)["deviceAdmin"] is True
    admin = me(client)
    assert admin["isDeviceAdmin"] is True
    assert admin["deviceAdminActive"] is True
    assert client.get("/api/settings").status_code == 200


def test_device_logout_then_email_account_has_no_device_privileges(client, monkeypatch):
    enable_email()
    capture_email_codes(monkeypatch)
    client.post("/api/auth/logout")
    email_login(client, "lin.zhixia@corp.example", monkeypatch)

    payload = me(client)
    assert payload["source"] == "email"
    assert payload["authenticated"] is True
    assert payload["id"] == "lin.zhixia"
    assert payload["isDeviceAdmin"] is False
    assert payload["isSuperAdmin"] is False
    assert payload["deviceAdminActive"] is False
    assert payload["deployDevice"] is True
    assert payload["admin"]["role"] is None
    assert payload["linkedMemberId"] == "m-lin"

    # Exactly like any other browser session: no settings/account administration.
    assert client.get("/api/settings").status_code == 403
    assert client.get("/api/users").status_code == 403
    assert client.get(f"/api/teams/{TEAM_AURORA}/overview").status_code == 200

    client.post("/api/auth/logout")
    guest = me(client)
    assert guest["source"] == "guest"
    assert guest["deployDevice"] is True
    client.post("/api/auth/device/login")
    assert me(client)["isDeviceAdmin"] is True


def test_device_logout_then_stored_super_account_keeps_only_its_role(client, monkeypatch):
    enable_email()
    capture_email_codes(monkeypatch)
    client.post("/api/auth/logout")
    created = client.post(
        "/api/users",
        json={"email": "device.super@corp.example", "name": "设备上的超管账号", "role": "super"},
    )
    assert created.status_code == 403  # the device Admin session was signed out
    # Sign the device Admin back in so the account can be created.
    client.post("/api/auth/device/login")
    created = client.post(
        "/api/users",
        json={"email": "device.super@corp.example", "name": "设备上的超管账号", "role": "super"},
    )
    assert created.status_code == 200, created.text
    client.post("/api/auth/logout")

    email_login(client, "device.super@corp.example", monkeypatch)
    payload = me(client)
    assert payload["isDeviceAdmin"] is False
    assert payload["deviceAdminActive"] is False
    # Its own stored super role still applies, exactly as on any other machine.
    assert payload["isSuperAdmin"] is True
    assert payload["userRole"] == "super"
    assert client.get("/api/settings").status_code == 200
    assert client.get("/api/users").status_code == 200


def test_device_admin_login_is_rejected_off_device(guest_client):
    response = guest_client.post("/api/auth/device/login")
    assert response.status_code == 403
    assert error(response)["code"] == "device_admin_unavailable"
    guest_client.post("/api/auth/logout")
    payload = me(guest_client)
    assert payload["deployDevice"] is False
    assert payload["deviceAdminActive"] is False


# --------------------------------------------------------------------------- local address matrix


@pytest.mark.parametrize("ip", LOCAL_CLIENT_IPS)
def test_local_client_ips_are_device_admins(ip):
    with _browser(ip) as browser:
        payload = me(browser)
        assert payload["isDeviceAdmin"] is True, ip
        assert payload["source"] == "local", ip
        assert payload["deployDevice"] is True, ip
        assert payload["admin"]["role"] == "super", ip


@pytest.mark.parametrize("ip", REMOTE_CLIENT_IPS)
def test_remote_client_ips_are_not_device_admins(ip):
    with _browser(ip) as browser:
        payload = me(browser)
        assert payload["isDeviceAdmin"] is False, ip
        assert payload["source"] == "guest", ip
        assert payload["deployDevice"] is False, ip
        assert browser.post("/api/auth/device/login").status_code == 403


def test_ipv4_mapped_ipv6_is_normalised():
    with _browser("::ffff:192.168.1.5") as browser:
        # A LAN address that is *not* this machine stays remote even in mapped form.
        assert me(browser)["isDeviceAdmin"] is False
    with _browser("::ffff:127.0.0.1") as browser:
        assert me(browser)["isDeviceAdmin"] is True


# --------------------------------------------------------------------------- forwarding headers


def test_local_peer_with_local_forwarded_ip_is_device_admin(client):
    payload = me(
        client,
    )  # baseline: plain loopback
    assert payload["isDeviceAdmin"] is True

    local = client.get(
        "/api/auth/me",
        headers={"X-Forwarded-For": "203.0.113.9, 127.0.0.1"},
    ).json()["data"]
    assert local["isDeviceAdmin"] is True
    assert local["source"] == "local"

    real_ip = client.get(
        "/api/auth/me", headers={"X-Real-IP": "127.0.0.1"}
    ).json()["data"]
    assert real_ip["isDeviceAdmin"] is True

    forwarded = client.get(
        "/api/auth/me", headers={"Forwarded": "for=::1;proto=http"}
    ).json()["data"]
    assert forwarded["isDeviceAdmin"] is True


def test_local_peer_with_remote_forwarded_ip_is_not_device_admin(client):
    # A local reverse proxy on the deployment device forwards a remote real IP.
    for headers in (
        {"X-Forwarded-For": "203.0.113.50"},
        {"X-Forwarded-For": "203.0.113.50, 198.51.100.4"},
        {"X-Real-IP": "203.0.113.50"},
        {"Forwarded": "for=203.0.113.50"},
    ):
        payload = client.get("/api/auth/me", headers=headers).json()["data"]
        assert payload["isDeviceAdmin"] is False, headers
        assert payload["source"] == "guest", headers
        assert payload["deviceAdminActive"] is False, headers


def test_remote_peer_cannot_spoof_forwarded_local_ip():
    with _browser("203.0.113.60") as browser:
        payload = browser.get(
            "/api/auth/me",
            headers={"X-Forwarded-For": "127.0.0.1"},
        ).json()["data"]
        assert payload["isDeviceAdmin"] is False
        assert payload["source"] == "guest"


# --------------------------------------------------------------------------- deploy device flags


def test_auth_config_exposes_deploy_device_flags(client):
    device = data(client.get("/api/auth/config"))
    assert device["deployDevice"] is True
    assert device["deviceAdminActive"] is True

    with _browser("203.0.113.70") as browser:
        remote = data(browser.get("/api/auth/config"))
        assert remote["deployDevice"] is False
        assert remote["deviceAdminActive"] is False
