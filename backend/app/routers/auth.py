"""Authentication routes.

Round 5 primary flow: password-less e-mail codes.

* ``POST /api/auth/email/request`` – send a six-digit code (open registration or login).
* ``POST /api/auth/email/verify``  – verify the code, create the account on first use
  and set the signed session cookie.

The pre-existing OIDC SSO flow and the deployment device's built-in Admin identity
are kept as additional sign-in paths. Guests are never redirected automatically.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from ..auth import (
    STATE_COOKIE,
    CurrentUser,
    clear_device_logout_cookie,
    clear_session_cookie,
    device_admin_logged_out,
    get_current_user,
    hash_verification_code,
    is_local_request,
    refresh_session_cookie,
    set_device_logout_cookie,
    set_session_cookie,
    verification_code_matches,
)
from ..config import settings_service
from ..db import db, new_id, now_iso, row
from ..http import fail, ok
from ..services import accounts
from ..services.email_service import EmailError, send_verification_code
from ..sso import SsoError, begin_login, complete_login, logout_url


router = APIRouter(prefix="/api/auth", tags=["auth"])


def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _redirect(path: str, **params: str) -> RedirectResponse:
    if not path.startswith("/") or path.startswith("//"):
        path = "/"
    query = "&".join(f"{key}={quote(value)}" for key, value in params.items() if value)
    base, _, fragment = path.partition("#")
    separator = "&" if "?" in base else "?"
    target = base + (separator + query if query else "")
    if fragment:
        target += "#" + fragment
    return RedirectResponse(target, status_code=303)


def _latest_code(email: str) -> dict | None:
    with db() as conn:
        return row(
            conn,
            "SELECT * FROM email_codes WHERE email=? AND purpose<>'activate' "
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (email,),
        )


def _consume_codes(email: str) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE email_codes SET consumed_at=? WHERE email=? AND consumed_at IS NULL",
            (now_iso(), email),
        )


@router.get("/me")
def me(
    request: Request,
    response: Response,
    user: CurrentUser = Depends(get_current_user),
):
    refresh_session_cookie(response, user)
    return ok(user.as_dict())


@router.get("/config")
def auth_config(request: Request):
    data = settings_service.public()["auth"]
    data["emailService"] = {
        "configured": settings_service.email_configured(),
        "enabled": settings_service.get().email.enabled,
    }
    local = is_local_request(request)
    data["deployDevice"] = local
    data["deviceAdminActive"] = bool(local and not device_admin_logged_out(request))
    return ok(data)


@router.post("/email/request")
def request_email_code(payload: dict = Body(...)):
    cfg = settings_service.get()
    if not cfg.auth.emailLogin.enabled:
        raise fail(403, "邮箱验证码登录未启用", "email_login_disabled")
    try:
        email = accounts.normalize_email(payload.get("email"))
        accounts.email_local_part(email)
    except accounts.AccountError as exc:
        raise fail(exc.status_code, exc.message, exc.code) from exc

    with db() as conn:
        account = accounts.get_user_by_email(conn, email)
        if not account:
            # The immutable id is the e-mail local part; reject an unusable prefix
            # before sending a code instead of failing at verification time.
            conflict = accounts.get_user(conn, accounts.derive_user_id(email))
            if conflict:
                raise fail(
                    409,
                    "该邮箱前缀已被其他账号占用，请更换邮箱",
                    "user_id_conflict",
                )

    # Pre-created accounts must first activate via the one-time link issued by the
    # super administrator; they do not use e-mail codes. This works without SMTP.
    if account and not account.get("email_verified"):
        raise fail(
            403,
            "该账号尚未激活，请使用超级管理员提供的激活链接完成激活",
            "account_not_activated",
        )

    if not settings_service.email_configured():
        raise fail(
            503,
            "邮件服务尚未配置，请联系超级管理员在系统设置中填写 SMTP 服务器与发件邮箱",
            "email_not_configured",
        )

    resend_seconds = cfg.auth.emailLogin.resendSeconds
    previous = _latest_code(email)
    previous_at = _parse_iso(previous.get("created_at")) if previous else None
    if previous_at is not None:
        elapsed = (_now() - previous_at).total_seconds()
        if elapsed < resend_seconds:
            retry_after = max(1, int(resend_seconds - elapsed))
            raise fail(
                429,
                f"发送过于频繁，请 {retry_after} 秒后再试",
                "code_rate_limited",
                {"retryAfterSeconds": retry_after},
            )

    registered = bool(account and account.get("email_verified"))
    purpose = "login" if registered else "register"
    code = "".join(str(secrets.randbelow(10)) for _ in range(cfg.auth.emailLogin.codeLength))
    expires_minutes = cfg.auth.emailLogin.codeExpiryMinutes
    expires_at = (_now() + timedelta(minutes=expires_minutes)).isoformat(timespec="seconds")

    _consume_codes(email)
    with db() as conn:
        conn.execute(
            "INSERT INTO email_codes (id,email,code_hash,purpose,expires_at,attempts,"
            "consumed_at,request_ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                new_id("code"),
                email,
                hash_verification_code(email, code),
                purpose,
                expires_at,
                0,
                None,
                "",
                now_iso(),
            ),
        )

    try:
        send_verification_code(
            recipient=email,
            code=code,
            purpose=purpose,
            expires_minutes=expires_minutes,
        )
    except EmailError as exc:
        _consume_codes(email)
        raise fail(502, f"验证码邮件发送失败：{exc}", "email_send_failed") from exc

    return ok(
        {
            "sent": True,
            "mode": "code",
            "email": email,
            "purpose": purpose,
            "registered": registered,
            "expiresInSeconds": expires_minutes * 60,
            "resendAfterSeconds": resend_seconds,
            "codeLength": cfg.auth.emailLogin.codeLength,
            "precreatedActivationMinutes": cfg.auth.emailLogin.precreatedActivationMinutes,
        }
    )


@router.post("/email/verify")
def verify_email_code(
    request: Request,
    response: Response,
    payload: dict = Body(...),
):
    cfg = settings_service.get()
    if not cfg.auth.emailLogin.enabled:
        raise fail(403, "邮箱验证码登录未启用", "email_login_disabled")
    try:
        email = accounts.normalize_email(payload.get("email"))
    except accounts.AccountError as exc:
        raise fail(exc.status_code, exc.message, exc.code) from exc
    submitted = str(payload.get("code") or "").strip()
    if not submitted or not submitted.isdigit() or len(submitted) != cfg.auth.emailLogin.codeLength:
        raise fail(422, f"请输入 {cfg.auth.emailLogin.codeLength} 位数字验证码", "code_format_invalid")

    record = _latest_code(email)
    if not record or record.get("consumed_at"):
        raise fail(422, "验证码不存在或已失效，请重新获取", "code_invalid")
    expires_at = _parse_iso(record.get("expires_at"))
    if expires_at is not None and expires_at < _now():
        _consume_codes(email)
        raise fail(422, "验证码已过期，请重新获取", "code_expired")
    attempts = int(record.get("attempts") or 0)
    if attempts >= cfg.auth.emailLogin.maxAttempts:
        _consume_codes(email)
        raise fail(429, "验证码尝试次数过多，请重新获取", "code_attempts_exceeded")
    if not verification_code_matches(email, submitted, str(record.get("code_hash") or "")):
        with db() as conn:
            conn.execute(
                "UPDATE email_codes SET attempts=attempts+1 WHERE id=?",
                (record["id"],),
            )
        remaining = cfg.auth.emailLogin.maxAttempts - attempts - 1
        raise fail(
            422,
            f"验证码不正确，还可尝试 {max(0, remaining)} 次",
            "code_mismatch",
            {"remainingAttempts": max(0, remaining)},
        )

    is_new = False
    with db() as conn:
        conn.execute(
            "UPDATE email_codes SET consumed_at=? WHERE id=?",
            (now_iso(), record["id"]),
        )
        account = accounts.get_user_by_email(conn, email)
        if not account:
            try:
                account = accounts.create_user(
                    conn,
                    email=email,
                    name="",
                    role="member",
                    email_verified=True,
                    created_by="self-register",
                )
            except accounts.AccountError as exc:
                raise fail(exc.status_code, exc.message, exc.code) from exc
            is_new = True
        elif not account.get("email_verified"):
            account = accounts.mark_email_verified(conn, account["id"])
        account = accounts.get_user(conn, account["id"])

    assert account is not None
    identity = accounts.account_session_identity(account)
    set_session_cookie(response, identity)
    return ok(
        {
            "loggedIn": True,
            "isNewUser": is_new,
            "user": accounts.user_payload(account),
            "sessionDays": cfg.auth.session.maxAgeDays,
        }
    )


@router.get("/activate")
def activate_account(token: str = Query(default="", max_length=200)):
    """One-time activation link for pre-created accounts.

    Opens automatically in the browser: validates the token, activates the account,
    sets the session cookie and redirects into the workspace. Invalid / expired /
    already-used links redirect to the login page with a status flag.
    """

    def target(status: str) -> RedirectResponse:
        return RedirectResponse(f"/#/login?activation={quote(status)}", status_code=303)

    if not token:
        return target("invalid")
    with db() as conn:
        record = accounts.find_activation_token(conn, token)
        if not record:
            return target("invalid")
        if record.get("used_at"):
            return target("used")
        expires_at = _parse_iso(record.get("expires_at"))
        if expires_at is None or expires_at < _now():
            return target("expired")
        account = accounts.get_user(conn, record["user_id"])
        if not account:
            return target("invalid")
        accounts.consume_activation_token(conn, record["token_hash"])
        if not account.get("email_verified"):
            account = accounts.mark_email_verified(conn, account["id"])
        account = accounts.get_user(conn, account["id"])

    assert account is not None
    identity = accounts.account_session_identity(account)
    response = RedirectResponse("/#/overview", status_code=303)
    set_session_cookie(response, identity)
    return response


# --------------------------------------------------------------------------- SSO


@router.get("/login")
def login(next: str = Query(default="/", max_length=500)):
    if not settings_service.sso_configured():
        if settings_service.get().auth.guestMode:
            return _redirect(next or "/", sso="unconfigured")
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "error": {
                    "code": "sso_unconfigured",
                    "message": "企业 SSO 尚未配置，且访客模式已关闭。",
                },
            },
        )
    try:
        url, state_cookie = begin_login(next)
    except SsoError as exc:
        return _redirect(next or "/", sso="error", sso_message=str(exc))
    response = RedirectResponse(url, status_code=303)
    cfg = settings_service.get()
    response.set_cookie(
        STATE_COOKIE,
        state_cookie,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=cfg.auth.session.secureCookie,
        path="/api/auth",
    )
    return response


@router.get("/callback")
def callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    error_description: str = "",
):
    if error:
        return _redirect("/", sso="denied", sso_message=error_description or error)
    try:
        if not code or not state:
            raise SsoError("SSO 回调缺少必要参数", "sso_callback_invalid")
        identity, next_path = complete_login(code, state, request.cookies.get(STATE_COOKIE))
    except SsoError as exc:
        return _redirect("/", sso="error", sso_message=str(exc))
    response = RedirectResponse(next_path or "/", status_code=303)
    set_session_cookie(response, identity)
    response.delete_cookie(STATE_COOKIE, path="/api/auth")
    return response


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    user: CurrentUser = Depends(get_current_user),
):
    result = ok(
        {
            "loggedOut": True,
            "endSessionUrl": logout_url() if user.source == "sso" else None,
        }
    )
    clear_session_cookie(response)
    # On the deployment device, also remember that the built-in Admin identity was
    # intentionally signed out so the browser can use a normal e-mail account instead.
    if is_local_request(request):
        set_device_logout_cookie(response)
    return result


@router.post("/device/login")
def device_admin_login(request: Request, response: Response):
    """Restore the built-in device Admin identity (only on the deployment device)."""
    if not is_local_request(request):
        raise fail(403, "仅本机可使用系统内置管理员登录", "device_admin_unavailable")
    clear_device_logout_cookie(response)
    clear_session_cookie(response)
    return ok({"deviceAdmin": True, "authenticated": True})
