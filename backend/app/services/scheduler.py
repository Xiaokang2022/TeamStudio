"""Background reminder scheduler integrated with FastAPI lifespan."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta
from typing import Any

from ..config import settings_service
from .email_service import run_reminder_scan

_state: dict[str, Any] = {
    "running": False,
    "lastScanAt": None,
    "lastResult": None,
    "nextScanAt": None,
    "lastError": "",
}
_task: asyncio.Task | None = None
_wake = None


def state() -> dict[str, Any]:
    return dict(_state)


async def _loop() -> None:
    global _wake
    _state["running"] = True
    _wake = asyncio.Event()
    try:
        while True:
            cfg = settings_service.get()
            interval = max(30, cfg.email.reminders.scanIntervalSeconds)
            try:
                if cfg.email.enabled and cfg.email.reminders.enabled:
                    result = await asyncio.to_thread(run_reminder_scan)
                    _state["lastResult"] = result
                    _state["lastScanAt"] = result.get("finishedAt")
                    _state["lastError"] = ""
                else:
                    _state["lastError"] = "邮件提醒未启用"
            except Exception as exc:  # scheduler must never die silently
                _state["lastError"] = str(exc)
                _state["lastScanAt"] = datetime.now().isoformat(timespec="seconds")
            _state["nextScanAt"] = (
                datetime.now() + timedelta(seconds=interval)
            ).isoformat(timespec="seconds")
            try:
                await asyncio.wait_for(_wake.wait(), timeout=interval)
                _wake.clear()
            except asyncio.TimeoutError:
                continue
    finally:
        _state["running"] = False
        _state["nextScanAt"] = None


def start_scheduler() -> None:
    global _task
    if _task and not _task.done():
        return
    _task = asyncio.create_task(_loop(), name="teamstudio-email-scheduler")


async def stop_scheduler() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _task
    _task = None


def wake_scheduler() -> None:
    if _wake:
        _wake.set()
