"""SMTP relay diagnostics and test delivery (super administrators only).

The bundled SMTP server, local mailbox centre, reminder templates and reminder
scheduler were removed in round 5. This router now only exposes the health of the
external relay plus a one-off test message, used by the system settings screen to
verify the configured SMTP IP/port/account/password.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from ..auth import CurrentUser, require_super
from ..config import EMAIL_PATTERN, settings_service
from ..http import fail, ok
from ..services.email_service import EmailError, email_status, recent_logs, send_test_email

router = APIRouter(prefix="/api/email", tags=["email"])


@router.get("/status")
def status(user: CurrentUser = Depends(require_super)):
    return ok(email_status())


@router.get("/logs")
def logs(
    limit: int = Query(default=30, ge=1, le=200),
    user: CurrentUser = Depends(require_super),
):
    return ok({"logs": recent_logs(limit)})


@router.post("/test")
def send_test(
    payload: dict[str, Any] = Body(default={}),
    user: CurrentUser = Depends(require_super),
):
    recipient = str(payload.get("to") or "").strip()
    if not recipient:
        recipient = settings_service.get().email.smtp.fromEmail
    if not recipient or not EMAIL_PATTERN.fullmatch(recipient):
        raise fail(422, "请填写有效的测试收件邮箱", "invalid_recipient")
    try:
        send_test_email(recipient)
    except EmailError as exc:
        raise fail(400, str(exc), "email_send_failed") from exc
    return ok({"sent": True, "to": recipient})
