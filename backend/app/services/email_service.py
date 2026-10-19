"""Configurable SMTP delivery and calendar-linked reminder scanning."""

from __future__ import annotations

import json
import re
import smtplib
import ssl
from datetime import date, datetime, time, timedelta
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Any

from ..config import DATA_DIR, settings_service
from ..db import db, get_meta, json_loads, new_id, now_iso, row, rows, scalar, set_meta
from . import mail_server

OUTBOX_PATH = DATA_DIR / "email_outbox.jsonl"
TEMPLATE_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
MAX_SENDS_PER_SCAN = 120
BUILTIN_TIMEOUT_SECONDS = 10


class EmailError(RuntimeError):
    pass


def _external_smtp_configured() -> bool:
    cfg = settings_service.get().email
    return bool(cfg.smtp.host and cfg.smtp.fromEmail)


def smtp_configured() -> bool:
    """Whether a usable delivery channel exists for the active mode.

    ``builtin`` mode counts as configured as soon as the bundled server is
    running (it is lazily (re)started from the saved settings). An external SMTP
    account is treated as a graceful fallback so reminders never get lost while
    the local server is unavailable.
    """

    cfg = settings_service.get().email
    external = _external_smtp_configured()
    if cfg.deliveryMode == "builtin":
        try:
            running = mail_server.ensure_running_sync()
        except Exception:  # pragma: no cover - status checks must never crash
            running = False
        return running or external
    return external


def mask_email(value: str) -> str:
    if "@" not in value:
        return value
    name, domain = value.split("@", 1)
    if len(name) <= 2:
        return name[:1] + "***@" + domain
    return name[:2] + "***@" + domain


def render_template(template: str, variables: dict[str, Any]) -> str:
    def repl(match: re.Match[str]) -> str:
        value = variables.get(match.group(1), "")
        if value is None:
            return ""
        return str(value)

    return TEMPLATE_PATTERN.sub(repl, template)


def _write_outbox(record: dict[str, Any]) -> None:
    try:
        OUTBOX_PATH.parent.mkdir(parents=True, exist_ok=True)
        with OUTBOX_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _log_email(
    *,
    group_id: str = "",
    todo_id: str = "",
    kind: str = "reminder",
    recipient: str,
    subject: str,
    status: str,
    error: str = "",
    detail: str = "",
) -> None:
    record = {
        "id": new_id("mail"),
        "groupId": group_id,
        "todoId": todo_id,
        "kind": kind,
        "recipient": recipient,
        "subject": subject,
        "status": status,
        "error": error,
        "detail": detail,
        "createdAt": now_iso(),
    }
    with db() as conn:
        conn.execute(
            "INSERT INTO email_logs (id,group_id,todo_id,kind,recipient,subject,status,error,detail,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                record["id"],
                group_id,
                todo_id,
                kind,
                recipient,
                subject,
                status,
                error,
                detail,
                record["createdAt"],
            ),
        )
    _write_outbox(record)


def _builtin_from_address(cfg) -> str:
    from_address = (cfg.smtp.fromEmail or "").strip()
    if from_address:
        return from_address
    hostname = (cfg.builtin.hostname or "teamstudio.local").strip() or "teamstudio.local"
    return f"teamstudio@{hostname}"


def _build_message(
    cfg,
    *,
    recipient: str,
    subject: str,
    body: str,
    kind: str,
    group_id: str,
    todo_id: str,
) -> EmailMessage:
    message = EmailMessage()
    message["From"] = formataddr(
        (cfg.smtp.fromName or "团队工作室", _builtin_from_address(cfg))
    )
    message["To"] = recipient
    message["Subject"] = subject
    message["X-TeamStudio-Kind"] = kind or "test"
    if group_id:
        message["X-TeamStudio-Group-Id"] = group_id
    if todo_id:
        message["X-TeamStudio-Todo-Id"] = todo_id
    message.set_content(body)
    return message


def _builtin_connect_host(status: dict[str, Any]) -> str:
    host = str(status.get("host") or "127.0.0.1").strip()
    if host in {"", "0.0.0.0", "::", "::0"}:
        return "127.0.0.1"
    return host


def _send_via_builtin(message: EmailMessage) -> None:
    status = mail_server.mail_server_status()
    if not status.get("running"):
        raise EmailError("内置邮件服务器未运行")
    with smtplib.SMTP(
        _builtin_connect_host(status),
        int(status.get("port") or 2525),
        timeout=BUILTIN_TIMEOUT_SECONDS,
    ) as server:
        server.ehlo()
        server.send_message(message)


def _send_via_smtp(cfg, message: EmailMessage) -> None:
    if cfg.smtp.useSsl:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(
            cfg.smtp.host, cfg.smtp.port, timeout=cfg.smtp.timeoutSeconds, context=context
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


def deliver(
    *,
    recipient: str,
    subject: str,
    body: str,
    kind: str = "test",
    group_id: str = "",
    todo_id: str = "",
    detail: str = "",
) -> None:
    cfg = settings_service.get().email
    if not cfg.enabled:
        raise EmailError("邮件功能未启用，请在设置中开启 email.enabled")
    external = _external_smtp_configured()
    channel = ""
    if cfg.deliveryMode == "builtin":
        try:
            running = mail_server.ensure_running_sync()
        except Exception:  # pragma: no cover - delivery surfaces a real error below
            running = False
        if running:
            channel = "builtin"
        elif external:
            # Graceful fallback: the bundled server could not listen (busy port /
            # disabled) but a complete external SMTP account is configured.
            channel = "smtp"
        else:
            raise EmailError(
                "内置邮件服务器未运行，请在「设置 → 邮件提醒」中点击「重启内置服务」后重试"
            )
    else:
        if not external:
            raise EmailError("SMTP 尚未配置完整（host 与 fromEmail 必填）")
        channel = "smtp"
    message = _build_message(
        cfg,
        recipient=recipient,
        subject=subject,
        body=body,
        kind=kind,
        group_id=group_id,
        todo_id=todo_id,
    )
    channel_label = "内置服务器" if channel == "builtin" else "外部 SMTP"
    try:
        if channel == "builtin":
            _send_via_builtin(message)
        else:
            _send_via_smtp(cfg, message)
    except EmailError as exc:
        _log_email(
            group_id=group_id,
            todo_id=todo_id,
            kind=kind,
            recipient=recipient,
            subject=subject,
            status="failed",
            error=str(exc),
            detail=detail,
        )
        raise
    except (OSError, smtplib.SMTPException) as exc:
        _log_email(
            group_id=group_id,
            todo_id=todo_id,
            kind=kind,
            recipient=recipient,
            subject=subject,
            status="failed",
            error=f"[{channel_label}] {exc}",
            detail=detail,
        )
        raise EmailError(f"邮件发送失败（{channel_label}）: {exc}") from exc
    _log_email(
        group_id=group_id,
        todo_id=todo_id,
        kind=kind,
        recipient=recipient,
        subject=subject,
        status="sent",
        detail=f"{detail} · channel={channel}".strip(" ·"),
    )


def _group_announcements(
    conn, group_id: str, include: bool
) -> str:
    if not include:
        return ""
    max_pinned = settings_service.get().announcements.maxPinned
    if max_pinned <= 0:
        return ""
    items = rows(
        conn,
        "SELECT title, content FROM announcements WHERE group_id=? AND pinned=1 "
        "ORDER BY created_at DESC LIMIT ?",
        (group_id, max_pinned),
    )
    if not items:
        return ""
    lines = ["【开发组置顶公告】"]
    for item in items:
        lines.append(f"· {item['title']}")
        if item.get("content"):
            lines.append(f"  {item['content'][:180]}")
    return "\n".join(lines)


def _todo_recipients(
    assignee_email: str, additional: list[str], notify_assignee: bool
) -> list[str]:
    recipients: list[str] = []
    if notify_assignee and assignee_email:
        recipients.append(assignee_email.strip())
    recipients.extend(item.strip() for item in additional if item.strip())
    return list(dict.fromkeys(recipients))


def _already_sent(conn, todo_id: str, offset: int, recipient: str) -> bool:
    return bool(
        scalar(
            conn,
            "SELECT 1 FROM email_reminders_sent WHERE todo_id=? AND offset_days=? AND recipient=?",
            (todo_id, offset, recipient),
            default=0,
        )
    )


def build_reminder_content(
    *,
    todo: dict[str, Any],
    assignee: dict[str, Any],
    group: dict[str, Any],
    team: dict[str, Any],
    announcements: str,
) -> tuple[str, str]:
    cfg = settings_service.get()
    reminder = cfg.email.reminders
    variables = {
        "memberName": assignee.get("name") or "伙伴",
        "todoTitle": todo.get("title", ""),
        "todoDescription": (
            todo.get("description", "") if reminder.includeTodoDescription else "（详见日历）"
        ),
        "dueDate": todo.get("due_date", ""),
        "dueTime": todo.get("due_time", ""),
        "groupName": group.get("name", ""),
        "teamName": team.get("name", ""),
        "priority": {
            "low": "低",
            "normal": "普通",
            "high": "高",
            "urgent": "紧急",
        }.get(todo.get("priority", "normal"), todo.get("priority", "")),
        "announcements": announcements,
        "extraContent": reminder.extraContent if reminder.includeExtra else "",
        "siteName": cfg.site.name,
    }
    subject = render_template(reminder.subjectTemplate, variables).strip()
    body = render_template(reminder.bodyTemplate, variables).strip()
    if not reminders_look_valid(subject, body):
        raise EmailError("邮件模板渲染结果为空，请检查设置中的模板")
    return subject, body


def reminders_look_valid(subject: str, body: str) -> bool:
    return bool(subject.strip() and body.strip())


def run_reminder_scan() -> dict[str, Any]:
    cfg = settings_service.get()
    stats: dict[str, Any] = {
        "startedAt": now_iso(),
        "sent": 0,
        "skipped": 0,
        "failed": 0,
        "pending": 0,
        "entries": [],
        "reason": "",
    }
    if not cfg.email.enabled:
        stats["reason"] = "邮件功能未启用"
        return _finish_scan(stats)
    if not cfg.email.reminders.enabled:
        stats["reason"] = "提醒扫描未启用"
        return _finish_scan(stats)
    if not smtp_configured():
        stats["reason"] = "SMTP 配置不完整"
        return _finish_scan(stats)

    now = datetime.now()
    send_clock = time.fromisoformat(cfg.email.reminders.sendTime)
    global_offsets = cfg.email.reminders.offsetsDays
    additional = cfg.email.reminders.additionalRecipients
    with db() as conn:
        todos = rows(
            conn,
            "SELECT t.*, m.name AS assignee_name, m.email AS assignee_email, "
            "g.name AS group_name, tm.name AS team_name "
            "FROM todos t "
            "LEFT JOIN members m ON m.id=t.assignee_member_id "
            "JOIN groups g ON g.id=t.group_id "
            "JOIN teams tm ON tm.id=g.team_id "
            "WHERE t.status='todo' AND t.email_enabled=1 ORDER BY t.due_date, t.due_time",
        )
        group_rows = rows(conn, "SELECT id,name,team_id FROM groups")
        team_rows = rows(conn, "SELECT id,name FROM teams")
        groups = {item["id"]: item for item in group_rows}
        teams = {item["id"]: item for item in team_rows}
        for todo in todos:
            try:
                due_date = date.fromisoformat(todo["due_date"])
                due_time = time.fromisoformat(todo["due_time"])
            except (TypeError, ValueError):
                stats["skipped"] += 1
                continue
            due_at = datetime.combine(due_date, due_time)
            if now > due_at + timedelta(hours=24):
                continue
            offsets = json_loads(todo.get("reminder_offsets_days"), global_offsets) or global_offsets
            recipient_list = _todo_recipients(
                todo.get("assignee_email") or "",
                additional,
                cfg.email.reminders.notifyAssignee,
            )
            if not recipient_list:
                continue
            for offset in offsets:
                try:
                    offset = int(offset)
                except (TypeError, ValueError):
                    continue
                scheduled_day = due_date - timedelta(days=offset)
                scheduled_at = datetime.combine(scheduled_day, send_clock)
                if now < scheduled_at:
                    continue
                if now > due_at + timedelta(hours=24):
                    continue
                for recipient in recipient_list:
                    if _already_sent(conn, todo["id"], offset, recipient):
                        stats["skipped"] += 1
                        continue
                    group = groups.get(todo["group_id"], {})
                    team = teams.get(group.get("team_id", ""), {})
                    announcements = _group_announcements(
                        conn, todo["group_id"], cfg.email.reminders.includeAnnouncements
                    )
                    try:
                        subject, body = build_reminder_content(
                            todo=todo,
                            assignee={
                                "name": todo.get("assignee_name") or "伙伴",
                                "email": recipient,
                            },
                            group=group,
                            team=team,
                            announcements=announcements,
                        )
                        deliver(
                            recipient=recipient,
                            subject=subject,
                            body=body,
                            kind="reminder",
                            group_id=todo["group_id"],
                            todo_id=todo["id"],
                            detail=f"offset={offset}",
                        )
                    except EmailError as exc:
                        stats["failed"] += 1
                        stats["entries"].append(
                            {
                                "todoId": todo["id"],
                                "recipient": mask_email(recipient),
                                "offsetDays": offset,
                                "status": "failed",
                                "error": str(exc),
                            }
                        )
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO email_reminders_sent "
                        "(id,group_id,todo_id,offset_days,recipient,sent_at) VALUES (?,?,?,?,?,?)",
                        (
                            new_id("sent"),
                            todo["group_id"],
                            todo["id"],
                            offset,
                            recipient,
                            now_iso(),
                        ),
                    )
                    conn.commit()
                    stats["sent"] += 1
                    stats["entries"].append(
                        {
                            "todoId": todo["id"],
                            "todoTitle": todo["title"],
                            "recipient": mask_email(recipient),
                            "offsetDays": offset,
                            "status": "sent",
                        }
                    )
                    if stats["sent"] + stats["failed"] >= MAX_SENDS_PER_SCAN:
                        stats["reason"] = "达到单次扫描发送上限，剩余任务将在下次扫描继续"
                        return _finish_scan(stats)
    stats["pending"] = pending_reminder_count()
    return _finish_scan(stats)


def _finish_scan(stats: dict[str, Any]) -> dict[str, Any]:
    stats["finishedAt"] = now_iso()
    with db() as conn:
        set_meta(conn, "email.lastScanAt", stats["finishedAt"])
        set_meta(conn, "email.lastScanResult", stats)
    return stats


def pending_reminder_count() -> int:
    cfg = settings_service.get()
    if not cfg.email.enabled or not cfg.email.reminders.enabled:
        return 0
    now = datetime.now()
    send_clock = time.fromisoformat(cfg.email.reminders.sendTime)
    global_offsets = cfg.email.reminders.offsetsDays
    count = 0
    with db() as conn:
        todos = rows(
            conn,
            "SELECT t.*, m.email AS assignee_email FROM todos t "
            "LEFT JOIN members m ON m.id=t.assignee_member_id "
            "WHERE t.status='todo' AND t.email_enabled=1",
        )
        for todo in todos:
            try:
                due_date = date.fromisoformat(todo["due_date"])
                due_time = time.fromisoformat(todo["due_time"])
            except (TypeError, ValueError):
                continue
            due_at = datetime.combine(due_date, due_time)
            if now > due_at + timedelta(hours=24):
                continue
            offsets = json_loads(todo.get("reminder_offsets_days"), global_offsets) or global_offsets
            recipients = _todo_recipients(
                todo.get("assignee_email") or "",
                cfg.email.reminders.additionalRecipients,
                cfg.email.reminders.notifyAssignee,
            )
            for offset in offsets:
                scheduled_at = datetime.combine(
                    due_date - timedelta(days=int(offset)), send_clock
                )
                if scheduled_at > now:
                    continue
                for recipient in recipients:
                    if not _already_sent(conn, todo["id"], int(offset), recipient):
                        count += 1
    return count


def email_status() -> dict[str, Any]:
    cfg = settings_service.get()
    with db() as conn:
        last_scan = get_meta(conn, "email.lastScanAt")
        sent_today = scalar(
            conn,
            "SELECT COUNT(*) FROM email_logs WHERE status='sent' AND created_at LIKE ?",
            (datetime.now().strftime("%Y-%m-%d") + "%",),
            default=0,
        )
        failed_today = scalar(
            conn,
            "SELECT COUNT(*) FROM email_logs WHERE status='failed' AND created_at LIKE ?",
            (datetime.now().strftime("%Y-%m-%d") + "%",),
            default=0,
        )
    from_address = cfg.email.smtp.fromEmail
    if cfg.email.deliveryMode == "builtin" and not from_address:
        from_address = _builtin_from_address(cfg.email)
    # Resolve the channel first: in builtin mode this lazily (re)starts the
    # bundled server, so the reported ``builtin.running`` is up to date.
    configured = smtp_configured()
    builtin = mail_server.mail_server_status()
    return {
        "enabled": cfg.email.enabled,
        "remindersEnabled": cfg.email.reminders.enabled,
        "deliveryMode": cfg.email.deliveryMode,
        "builtin": {
            "enabled": builtin["enabled"],
            "running": builtin["running"],
            "host": builtin["host"],
            "port": builtin["port"],
            "hostname": builtin["hostname"],
            "stored": builtin["stored"],
            "limit": builtin["limit"],
            "retentionDays": builtin["retentionDays"],
            "lastError": builtin["lastError"],
        },
        "smtpConfigured": configured,
        "fromEmail": mask_email(from_address) if from_address else "",
        "lastScanAt": last_scan,
        "pendingReminders": pending_reminder_count(),
        "sentToday": sent_today,
        "failedToday": failed_today,
    }


def recent_logs(limit: int = 50) -> list[dict[str, Any]]:
    with db() as conn:
        records = rows(
            conn,
            "SELECT id,group_id,todo_id,kind,recipient,subject,status,error,detail,created_at "
            "FROM email_logs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
    for record in records:
        record["recipient"] = mask_email(record.get("recipient", ""))
    return records
