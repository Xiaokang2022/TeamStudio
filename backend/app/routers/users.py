"""Super-administrator user account management.

Only super administrators (the deployment device Admin or a stored ``super`` role)
may list, pre-create, promote, re-scope or delete accounts. The deployment device's
built-in ``Admin`` is shown as a non-editable row and can never be managed or
deleted.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, Request

from ..auth import CurrentUser, require_super
from ..config import settings_service
from ..db import db, log_audit, row, rows
from ..http import fail, ok
from ..services import accounts

router = APIRouter(prefix="/api/users", tags=["users"])


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


def _validate_scope(
    conn: sqlite3.Connection,
    team_ids: list[str],
    group_ids: list[str],
    role: str,
) -> tuple[list[str], list[str]]:
    known_teams = {item["id"] for item in rows(conn, "SELECT id FROM teams")}
    known_groups = {item["id"]: item["team_id"] for item in rows(conn, "SELECT id, team_id FROM groups")}
    cleaned_teams = sorted({item for item in team_ids if item})
    cleaned_groups = sorted({item for item in group_ids if item})
    unknown_teams = [item for item in cleaned_teams if item not in known_teams]
    if unknown_teams:
        raise fail(422, f"团队不存在：{', '.join(unknown_teams)}", "invalid_team_scope")
    unknown_groups = [item for item in cleaned_groups if item not in known_groups]
    if unknown_groups:
        raise fail(422, f"开发组不存在：{', '.join(unknown_groups)}", "invalid_group_scope")
    if role == "team_admin" and not cleaned_teams:
        raise fail(422, "团队管理员至少需要指定一个团队", "team_scope_required")
    if role == "group_admin" and not cleaned_groups:
        raise fail(422, "开发组管理员至少需要指定一个开发组", "group_scope_required")
    return cleaned_teams, cleaned_groups


def _user_list(conn: sqlite3.Connection, user: CurrentUser) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [
        {
            "id": "device-admin",
            "email": "",
            "name": "Admin",
            "avatar": "",
            "avatarColor": "#0ea5e9",
            "bio": "部署设备内置管理员",
            "skills": [],
            "role": "super",
            "roleLabel": "超级管理员",
            "teamIds": [],
            "groupIds": [],
            "emailVerified": True,
            "createdBy": "system",
            "createdAt": "",
            "updatedAt": "",
            "isDeviceAdmin": True,
            "canManage": False,
            "isSelf": user.is_device_admin,
        }
    ]
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
        team_ids = [str(item) for item in (payload.get("teamIds") or [])]
        group_ids = [str(item) for item in (payload.get("groupIds") or [])]
        with db() as conn:
            team_ids, group_ids = _validate_scope(conn, team_ids, group_ids, role)
            created = accounts.create_user(
                conn,
                email=email,
                name=str(payload.get("name") or ""),
                role=role,
                team_ids=team_ids,
                group_ids=group_ids,
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
        raise fail(403, "部署设备的 Admin 身份不可管理", "device_admin_immutable")
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
        raise fail(403, "部署设备的 Admin 身份不可管理", "device_admin_immutable")
    try:
        with db() as conn:
            existing = accounts.get_user(conn, user_id)
            if not existing:
                raise accounts.AccountError("账号不存在", "user_not_found", 404)
            role = payload.get("role")
            if role is not None and role not in accounts.USER_ROLES:
                raise accounts.AccountError("账号角色不合法", "invalid_role")
            team_ids = (
                [str(item) for item in (payload.get("teamIds") or [])]
                if "teamIds" in payload
                else None
            )
            group_ids = (
                [str(item) for item in (payload.get("groupIds") or [])]
                if "groupIds" in payload
                else None
            )
            effective_role = role or existing.get("role") or "member"
            effective_teams = team_ids if team_ids is not None else accounts._list(existing.get("team_ids"))
            effective_groups = group_ids if group_ids is not None else accounts._list(existing.get("group_ids"))
            if role is not None or team_ids is not None or group_ids is not None:
                effective_teams, effective_groups = _validate_scope(
                    conn, effective_teams, effective_groups, effective_role
                )
                if team_ids is None:
                    team_ids = effective_teams
                if group_ids is None:
                    group_ids = effective_groups
            name = payload.get("name") if "name" in payload else None
            updated = accounts.update_user(
                conn,
                user_id,
                name=str(name) if name is not None else None,
                role=role,
                team_ids=team_ids,
                group_ids=group_ids,
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
        raise fail(403, "部署设备的 Admin 身份不可删除", "device_admin_immutable")
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
