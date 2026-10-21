"""Super-administrator user account management (round 8, team-only).

Only super administrators (the deployment device Admin or a stored ``super`` role) may
list, pre-create, promote, re-scope or delete accounts. Roles are ``member`` /
``team_admin`` / ``super`` — development-group administrators (``group_admin``) and
``groupIds`` no longer exist; a ``team_admin`` is scoped by ``teamIds`` only.

The deployment device's built-in ``Admin`` is shown as a non-editable row to that device
Admin only; stored super administrators never see it and none of its endpoints can manage
or delete it.
"""

from __future__ import annotations

import sqlite3
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, Request

from ..auth import CurrentUser, require_super
from ..config import settings_service
from ..db import db, json_loads, log_audit, rows
from ..http import fail, ok
from ..services import accounts

router = APIRouter(prefix="/api/users", tags=["users"])


def _id_list(value: Any) -> list[str]:
    """Parse a JSON / list column into a deduplicated id list."""
    parsed = json_loads(value, []) if isinstance(value, str) else value
    if not isinstance(parsed, list):
        return []
    result: list[str] = []
    for item in parsed:
        cleaned = str(item).strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def _activation_url(request: Request, token: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/auth/activate?token={quote(token)}"


def _issue_activation(conn, request: Request, user: dict[str, Any], created_by: str) -> dict[str, Any]:
    minutes = settings_service.get().auth.emailLogin.precreatedActivationMinutes
    token, expires_at = accounts.create_activation_token(
        conn, user["id"], minutes=minutes, created_by=created_by
    )
    return {
        "url": _activation_url(request, token),
        "expiresAt": expires_at,
        "expiresInMinutes": minutes,
    }


def _validate_teams(
    conn: sqlite3.Connection,
    team_ids: list[str],
    role: str,
) -> list[str]:
    """Validate ``teamIds`` against the teams table; ``team_admin`` needs at least one."""
    known_teams = {item["id"] for item in rows(conn, "SELECT id FROM teams")}
    cleaned = sorted({str(item).strip() for item in team_ids if str(item or "").strip()})
    unknown = [item for item in cleaned if item not in known_teams]
    if unknown:
        raise fail(422, f"团队不存在：{', '.join(unknown)}", "invalid_team_scope")
    if role == "team_admin" and not cleaned:
        raise fail(422, "团队管理员至少需要指定一个团队", "team_scope_required")
    return cleaned


def _user_list(conn: sqlite3.Connection, user: CurrentUser) -> list[dict[str, Any]]:
    """List accounts visible to the caller.

    The synthetic device Admin row is only rendered for the deployment device's own
    Admin identity; stored super administrators never see it.
    """
    items: list[dict[str, Any]] = []
    if user.is_device_admin:
        items.append(
            {
                "id": "device-admin",
                "email": "",
                "name": "Admin",
                "avatar": "",
                "avatarColor": "#0ea5e9",
                "bio": "系统内置管理员",
                "skills": [],
                "role": "super",
                "roleLabel": "超级管理员",
                "teamIds": [],
                "emailVerified": True,
                "createdBy": "system",
                "createdAt": "",
                "updatedAt": "",
                "isDeviceAdmin": True,
                "canManage": False,
                "isSelf": True,
            }
        )
    for account in rows(conn, "SELECT * FROM users ORDER BY role, created_at, id"):
        payload = accounts.user_payload(account)
        payload["isDeviceAdmin"] = False
        payload["canManage"] = True
        payload["isSelf"] = account["id"] == user.id
        items.append(payload)
    return items


@router.get("")
def list_users(user: CurrentUser = Depends(require_super)):
    with db() as conn:
        return ok(
            {
                "users": _user_list(conn, user),
                "deviceAdminName": "Admin",
                "permissions": {"canManageUsers": True},
            }
        )


@router.post("")
def create_user(
    request: Request,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(require_super),
):
    activation: dict[str, Any] | None = None
    try:
        email = accounts.normalize_email(payload.get("email"))
        role = str(payload.get("role") or "member")
        if role not in accounts.USER_ROLES:
            raise accounts.AccountError("账号角色不合法", "invalid_role")
        # ``groupIds`` is no longer accepted; an old client sending it is ignored.
        team_ids = [str(item) for item in (payload.get("teamIds") or [])]
        with db() as conn:
            team_ids = _validate_teams(conn, team_ids, role)
            created = accounts.create_user(
                conn,
                email=email,
                name=str(payload.get("name") or ""),
                role=role,
                team_ids=team_ids,
                email_verified=bool(payload.get("emailVerified")),
                created_by=user.id,
            )
            if not created["email_verified"]:
                activation = _issue_activation(conn, request, created, user.id)
            log_audit(
                conn,
                user.name or user.id,
                "user.create",
                "user",
                created["id"],
                {"email": created["email"], "role": role, "preCreated": not created["email_verified"]},
            )
    except accounts.AccountError as exc:
        raise fail(exc.status_code, exc.message, exc.code) from exc
    return ok(
        {
            "user": accounts.user_payload(created),
            "activation": activation,
        }
    )


@router.post("/{user_id}/activation-link")
def create_activation_link(
    user_id: str,
    request: Request,
    user: CurrentUser = Depends(require_super),
):
    if user_id == "device-admin":
        raise fail(403, "系统内置的 Admin 身份不可管理", "device_admin_immutable")
    with db() as conn:
        account = accounts.get_user(conn, user_id)
        if not account:
            raise fail(404, "账号不存在", "user_not_found")
        if account.get("email_verified"):
            raise fail(409, "该账号已激活，无需重新生成激活链接", "account_already_activated")
        activation = _issue_activation(conn, request, account, user.id)
        log_audit(
            conn,
            user.name or user.id,
            "user.activation_link",
            "user",
            user_id,
            {"expiresInMinutes": activation["expiresInMinutes"]},
        )
    return ok({"activation": activation})


@router.patch("/{user_id}")
def update_user(
    user_id: str,
    payload: dict[str, Any] = Body(...),
    user: CurrentUser = Depends(require_super),
):
    if user_id == "device-admin":
        raise fail(403, "系统内置的 Admin 身份不可管理", "device_admin_immutable")
    try:
        with db() as conn:
            existing = accounts.get_user(conn, user_id)
            if not existing:
                raise accounts.AccountError("账号不存在", "user_not_found", 404)
            role = payload.get("role")
            if role is not None and role not in accounts.USER_ROLES:
                raise accounts.AccountError("账号角色不合法", "invalid_role")
            # ``groupIds`` is no longer accepted; an old client sending it is ignored.
            team_ids = (
                [str(item) for item in (payload.get("teamIds") or [])]
                if "teamIds" in payload
                else None
            )
            effective_role = role or existing.get("role") or "member"
            effective_teams = (
                team_ids
                if team_ids is not None
                else _id_list(existing.get("team_ids"))
            )
            if role is not None or team_ids is not None:
                effective_teams = _validate_teams(conn, effective_teams, effective_role)
                if team_ids is None:
                    team_ids = effective_teams
            name = payload.get("name") if "name" in payload else None
            updated = accounts.update_user(
                conn,
                user_id,
                name=str(name) if name is not None else None,
                role=role,
                team_ids=team_ids,
            )
            log_audit(
                conn,
                user.name or user.id,
                "user.update",
                "user",
                user_id,
                {"fields": sorted(payload.keys()), "role": updated["role"]},
            )
    except accounts.AccountError as exc:
        raise fail(exc.status_code, exc.message, exc.code) from exc
    return ok({"user": accounts.user_payload(updated)})


@router.delete("/{user_id}")
def delete_user(user_id: str, user: CurrentUser = Depends(require_super)):
    if user_id == "device-admin":
        raise fail(403, "系统内置的 Admin 身份不可删除", "device_admin_immutable")
    if user_id == user.id:
        raise fail(409, "不能删除当前登录的账号", "cannot_delete_self")
    with db() as conn:
        existing = accounts.get_user(conn, user_id)
        if not existing:
            raise fail(404, "账号不存在", "user_not_found")
        conn.execute("DELETE FROM email_codes WHERE email=?", (str(existing.get("email") or "").lower(),))
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        log_audit(
            conn,
            user.name or user.id,
            "user.delete",
            "user",
            user_id,
            {"email": existing.get("email"), "role": existing.get("role")},
        )
    return ok({"deleted": True, "id": user_id})
