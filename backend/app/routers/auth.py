"""Authentication routes: local Admin, OIDC SSO and automatic guest fallback."""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from ..auth import (
    STATE_COOKIE,
    CurrentUser,
    clear_session_cookie,
    get_current_user,
    set_session_cookie,
)
from ..config import settings_service
from ..http import ok
from ..sso import SsoError, begin_login, complete_login, logout_url


router = APIRouter(prefix="/api/auth", tags=["auth"])


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


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)):
    return ok(user.as_dict())


@router.get("/config")
def auth_config():
    return ok(settings_service.public()["auth"])


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
def logout():
    response = JSONResponse(ok({"loggedOut": True, "endSessionUrl": logout_url()}))
    clear_session_cookie(response)
    return response
