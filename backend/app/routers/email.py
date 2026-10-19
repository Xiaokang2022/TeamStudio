"""Admin email reminder APIs."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from starlette.concurrency import run_in_threadpool

from ..auth import CurrentUser, require_super
from ..config import EMAIL_PATTERN, settings_service
from ..http import fail, ok
from ..services import scheduler
from ..services.email_service import (
    EmailError,
    deliver,
    email_status,
    recent_logs,
    render_template,
    run_reminder_scan,
)


router = APIRouter(prefix="/api/email", tags=["email"])


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


@router.post("/test")
def send_test(
    payload: dict[str, Any] = Body(default={}),
    user: CurrentUser = Depends(require_super),
):
    cfg = settings_service.get()
    recipient = str(payload.get("to") or cfg.email.smtp.fromEmail or "").strip()
    if not recipient or not EMAIL_PATTERN.fullmatch(recipient):
        raise fail(422, "请填写有效的测试收件邮箱", "invalid_recipient")
    try:
        deliver(
            recipient=recipient,
            subject=f"[{cfg.site.name}] 邮件提醒配置测试",
            body=(
                "这是一封 TeamStudio 邮件配置测试。\n\n"
                "如果你收到此邮件，说明 SMTP 连接、发件人与模板通道工作正常。\n\n"
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
