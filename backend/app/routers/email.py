"""Admin email reminder APIs plus the bundled local mail center."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from starlette.concurrency import run_in_threadpool

from ..auth import CurrentUser, require_super
from ..config import EMAIL_PATTERN, settings_service
from ..db import db, now_iso, row, rows, scalar
from ..http import fail, ok
from ..services import mail_server, scheduler
from ..services.email_service import (
    EmailError,
    deliver,
    email_status,
    recent_logs,
    render_template,
    run_reminder_scan,
)


router = APIRouter(prefix="/api/email", tags=["email"])

MAILBOX_BODY_PREVIEW = 4000


def _json_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return [value]
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    return []


def _mailbox_message(record: dict[str, Any], *, preview: bool) -> dict[str, Any]:
    body_text = record.get("body_text") or ""
    if preview and len(body_text) > MAILBOX_BODY_PREVIEW:
        body_text = body_text[:MAILBOX_BODY_PREVIEW] + "\n…（已截断，点击查看完整正文）"
    return {
        "id": record["id"],
        "direction": record.get("direction") or "outbound",
        "fromAddr": record.get("from_addr") or "",
        "toAddrs": _json_list(record.get("to_addrs")),
        "ccAddrs": _json_list(record.get("cc_addrs")),
        "subject": record.get("subject") or "",
        "bodyText": body_text,
        "bodyHtml": record.get("body_html") or "",
        "kind": record.get("kind") or "",
        "groupId": record.get("group_id") or "",
        "todoId": record.get("todo_id") or "",
        "status": record.get("status") or "stored",
        "error": record.get("error") or "",
        "createdAt": record.get("created_at") or "",
        "readAt": record.get("read_at"),
    }


def _builtin_status() -> dict[str, Any]:
    status = mail_server.mail_server_status()
    return {
        "enabled": status["enabled"],
        "running": status["running"],
        "host": status["host"],
        "port": status["port"],
        "hostname": status["hostname"],
        "limit": status["limit"],
        "stored": status["stored"],
        "lastError": status["lastError"],
    }


@router.get("/status")
def status(user: CurrentUser = Depends(require_super)):
    data = email_status()
    data["scheduler"] = scheduler.state()
    data["templatePreview"] = {
        "subject": render_template(
            settings_service.get().email.reminders.subjectTemplate,
            {
                "siteName": settings_service.get().site.name,
                "groupName": "前端体验组",
                "todoTitle": "日历邮件提醒联调",
                "dueDate": "2026-10-22",
            },
        ),
        "body": settings_service.get().email.reminders.bodyTemplate,
    }
    return ok(data)


@router.get("/logs")
def logs(
    limit: int = Query(default=50, ge=1, le=300),
    user: CurrentUser = Depends(require_super),
):
    return ok({"logs": recent_logs(limit)})


@router.get("/mailbox")
def mailbox(
    limit: int = Query(default=50, ge=1, le=300),
    box: str = Query(default="all"),
    user: CurrentUser = Depends(require_super),
):
    box_key = (box or "all").strip().lower()
    if box_key not in {"all", "outbound", "inbound"}:
        raise fail(422, "box 仅支持 all / outbound / inbound", "invalid_box")
    where = "" if box_key == "all" else " WHERE direction=?"
    params: tuple[Any, ...] = () if box_key == "all" else (box_key,)
    with db() as conn:
        total = scalar(
            conn,
            f"SELECT COUNT(*) FROM mailbox_messages{where}",
            params,
            default=0,
        )
        records = rows(
            conn,
            f"SELECT * FROM mailbox_messages{where} ORDER BY created_at DESC, id DESC LIMIT ?",
            params + (limit,),
        )
    return ok(
        {
            "messages": [_mailbox_message(record, preview=True) for record in records],
            "total": int(total or 0),
            "builtin": _builtin_status(),
        }
    )


@router.get("/mailbox/{message_id}")
def mailbox_message(message_id: str, user: CurrentUser = Depends(require_super)):
    with db() as conn:
        record = row(conn, "SELECT * FROM mailbox_messages WHERE id=?", (message_id,))
        if not record:
            raise fail(404, "邮件不存在或已被本地邮件中心清理", "mailbox_message_not_found")
        if not record.get("read_at"):
            read_at = now_iso()
            conn.execute(
                "UPDATE mailbox_messages SET read_at=? WHERE id=?", (read_at, message_id)
            )
            conn.commit()
            record["read_at"] = read_at
    return ok({"message": _mailbox_message(record, preview=False)})


@router.delete("/mailbox/{message_id}")
def delete_mailbox_message(message_id: str, user: CurrentUser = Depends(require_super)):
    with db() as conn:
        existing = row(conn, "SELECT id FROM mailbox_messages WHERE id=?", (message_id,))
        if not existing:
            raise fail(404, "邮件不存在或已被本地邮件中心清理", "mailbox_message_not_found")
        conn.execute("DELETE FROM mailbox_messages WHERE id=?", (message_id,))
        conn.commit()
    return ok({"deleted": True})


@router.post("/builtin/restart")
def restart_builtin(user: CurrentUser = Depends(require_super)):
    """Restart the bundled SMTP server with the currently saved settings.

    The server runs in its own thread/event loop, so this synchronous route can
    safely call ``restart_sync`` (also works under ``TestClient``).
    """

    mail_server.restart_sync()
    status_block = _builtin_status()
    return ok(
        {
            "running": bool(status_block["running"]),
            "host": status_block["host"],
            "port": status_block["port"],
        }
    )


@router.post("/test")
def send_test(
    payload: dict[str, Any] = Body(default={}),
    user: CurrentUser = Depends(require_super),
):
    cfg = settings_service.get()
    recipient = str(payload.get("to") or "").strip()
    if not recipient:
        if cfg.email.smtp.fromEmail:
            recipient = cfg.email.smtp.fromEmail
        elif cfg.email.deliveryMode == "builtin":
            hostname = (cfg.email.builtin.hostname or "teamstudio.local").strip()
            recipient = f"teamstudio@{hostname or 'teamstudio.local'}"
    if not recipient or not EMAIL_PATTERN.fullmatch(recipient):
        raise fail(422, "请填写有效的测试收件邮箱", "invalid_recipient")
    channel = "内置邮件服务器" if cfg.email.deliveryMode == "builtin" else "外部 SMTP"
    try:
        deliver(
            recipient=recipient,
            subject=f"[{cfg.site.name}] 邮件提醒配置测试",
            body=(
                "这是一封 TeamStudio 邮件配置测试。\n\n"
                f"投递方式：{channel}\n"
                "如果你能在「设置 → 邮件提醒 → 本地邮件中心」看到这封邮件，"
                "说明本地邮件通道工作正常，无需依赖任何外部邮件服务器。\n\n"
                f"发送时间：{settings_service.meta()['updatedAt']}\n"
                "—— TeamStudio"
            ),
            kind="test",
            detail="manual test",
        )
    except EmailError as exc:
        raise fail(400, str(exc), "email_send_failed") from exc
    return ok({"sent": True, "to": recipient})


@router.post("/scan")
async def scan_now(user: CurrentUser = Depends(require_super)):
    result = await run_in_threadpool(run_reminder_scan)
    scheduler.wake_scheduler()
    return ok(result)


@router.get("/preview")
def preview(
    todoId: str = Query(default=""),
    user: CurrentUser = Depends(require_super),
):
    cfg = settings_service.get()
    variables = {
        "siteName": cfg.site.name,
        "memberName": "林知夏",
        "todoTitle": "日历邮件提醒联调",
        "todoDescription": "验证提前 3 天 / 1 天 / 当天三档提醒与去重。",
        "dueDate": "2026-10-22",
        "dueTime": "18:00",
        "groupName": "前端体验组",
        "teamName": "星港产品团队",
        "priority": "高",
        "announcements": "【开发组置顶公告】\n· 团队工作室 2.0 内测开启\n· 本周五 16:00 体验评审",
        "extraContent": cfg.email.reminders.extraContent if cfg.email.reminders.includeExtra else "",
    }
    return ok(
        {
            "subject": render_template(cfg.email.reminders.subjectTemplate, variables),
            "body": render_template(cfg.email.reminders.bodyTemplate, variables),
            "todoId": todoId,
        }
    )
