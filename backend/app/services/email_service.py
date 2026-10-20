"""External SMTP delivery used for password-less e-mail verification codes.

The self-hosted SMTP server, mailbox centre and calendar e-mail reminders were
removed in round 5. All delivery now goes through the single external SMTP relay
configured in ``settings.email.smtp`` (server IP/host + port + proxy mailbox
account + password), which keeps deployments simple and avoids any local mail
dependency.
"""

from __future__ import annotations

import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any

from ..config import mask_email, settings_service
from ..db import db, new_id, now_iso, row, rows

TEMPLATE_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")

PURPOSE_LABELS = {
    "login": "登录",
    "register": "注册",
    "verify": "邮箱验证",
}


class EmailError(RuntimeError):
    """Raised when an e-mail cannot be delivered through the configured SMTP relay."""


def render_template(template: str, variables: dict[str, Any]) -> str:
    def repl(match: re.Match[str]) -> str:
        value = variables.get(match.group(1), "")
        if value is None:
            return ""
        return str(value)

    return TEMPLATE_PATTERN.sub(repl, template)


def smtp_configured() -> bool:
    cfg = settings_service.get().email
    return bool(cfg.enabled and cfg.smtp.host.strip() and smtp_from_address())


def smtp_from_address() -> str:
    cfg = settings_service.get().email.smtp
    return (cfg.fromEmail or cfg.username or "").strip()


def _log_email(
    *,
    recipient: str,
    subject: str,
    status: str,
    kind: str = "verification",
    error: str = "",
    detail: str = "",
) -> None:
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO email_logs (id,group_id,todo_id,kind,recipient,subject,status,"
                "error,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    new_id("mail"),
                    "",
                    "",
                    kind,
                    recipient,
                    subject,
                    status,
                    error,
                    detail,
                    now_iso(),
                ),
            )
    except Exception:  # pragma: no cover - logging must never break delivery
        pass


def _build_message(*, recipient: str, subject: str, body: str) -> EmailMessage:
    cfg = settings_service.get().email
    message = EmailMessage()
    message["From"] = formataddr(
        (cfg.smtp.fromName or "团队工作室", smtp_from_address())
    )
    message["To"] = recipient
    message["Subject"] = subject
    message["X-TeamStudio-Kind"] = "verification"
    message.set_content(body)
    return message


def _deliver_message(message: EmailMessage) -> None:
    cfg = settings_service.get().email
    if not cfg.enabled:
        raise EmailError("邮件服务未启用，请在系统设置中开启")
    if not cfg.smtp.host.strip():
        raise EmailError("尚未配置 SMTP 服务器地址")
    if not smtp_from_address():
        raise EmailError("尚未配置发件邮箱地址")
    try:
        if cfg.smtp.useSsl:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(
                cfg.smtp.host,
                cfg.smtp.port,
                timeout=cfg.smtp.timeoutSeconds,
                context=context,
            ) as server:
                if cfg.smtp.username:
                    server.login(cfg.smtp.username, cfg.smtp.password)
                server.send_message(message)
            return
        with smtplib.SMTP(cfg.smtp.host, cfg.smtp.port, timeout=cfg.smtp.timeoutSeconds) as server:
            server.ehlo()
            if cfg.smtp.useStartTls:
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if cfg.smtp.username:
                server.login(cfg.smtp.username, cfg.smtp.password)
            server.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        raise EmailError(f"邮件发送失败：{exc}") from exc


def send_email(*, recipient: str, subject: str, body: str, kind: str = "verification") -> None:
    recipient = recipient.strip()
    if not recipient:
        raise EmailError("收件邮箱不能为空")
    message = _build_message(recipient=recipient, subject=subject, body=body)
    try:
        _deliver_message(message)
    except EmailError as exc:
        _log_email(
            recipient=mask_email(recipient),
            subject=subject,
            status="failed",
            kind=kind,
            error=str(exc),
        )
        raise
    _log_email(
        recipient=mask_email(recipient),
        subject=subject,
        status="sent",
        kind=kind,
    )


def send_verification_code(
    *, recipient: str, code: str, purpose: str = "login", expires_minutes: int = 10
) -> None:
    cfg = settings_service.get()
    variables = {
        "siteName": cfg.site.name,
        "code": code,
        "expiresMinutes": expires_minutes,
        "purpose": PURPOSE_LABELS.get(purpose, "登录"),
    }
    subject = render_template(cfg.email.subjectTemplate, variables).strip() or (
        f"[{cfg.site.name}] 邮箱验证码"
    )
    body = render_template(cfg.email.bodyTemplate, variables).strip() or (
        f"你的验证码是 {code}，{expires_minutes} 分钟内有效。"
    )
    send_email(recipient=recipient, subject=subject, body=body, kind="verification")


def send_test_email(recipient: str) -> None:
    cfg = settings_service.get()
    subject = f"[{cfg.site.name}] 邮件服务配置测试"
    body = (
        "这是一封 TeamStudio 邮件服务配置测试邮件。\n\n"
        f"如果你能收到这封邮件，说明 SMTP 服务器 {cfg.email.smtp.host}:"
        f"{cfg.email.smtp.port} 与发件邮箱 {smtp_from_address()} 配置正常。\n\n"
        "—— TeamStudio"
    )
    send_email(recipient=recipient, subject=subject, body=body, kind="test")


def email_status() -> dict[str, Any]:
    cfg = settings_service.get().email
    with db() as conn:
        last = row(
            conn,
            "SELECT created_at, status, error FROM email_logs ORDER BY created_at DESC LIMIT 1",
        )
        sent_today = row(
            conn,
            "SELECT COUNT(*) AS count FROM email_logs WHERE status='sent' AND created_at LIKE ?",
            (now_iso()[:10] + "%",),
        )
    return {
        "enabled": cfg.enabled,
        "configured": smtp_configured(),
        "host": cfg.smtp.host,
        "port": cfg.smtp.port,
        "username": cfg.smtp.username,
        "fromEmail": cfg.smtp.fromEmail,
        "fromName": cfg.smtp.fromName,
        "useStartTls": cfg.smtp.useStartTls,
        "useSsl": cfg.smtp.useSsl,
        "timeoutSeconds": cfg.smtp.timeoutSeconds,
        "lastSentAt": last.get("created_at") if last and last.get("status") == "sent" else None,
        "lastError": last.get("error") if last and last.get("status") == "failed" else "",
        "sentToday": int(sent_today.get("count") or 0) if sent_today else 0,
    }


def recent_logs(limit: int = 30) -> list[dict[str, Any]]:
    with db() as conn:
        records = rows(
            conn,
            "SELECT id, kind, recipient, subject, status, error, created_at "
            "FROM email_logs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
    return records
