"""Bundled, dependency-free SMTP server for the TeamStudio mail center.

The server is intentionally small: it accepts mail from the local machine (or
from whoever can reach the configured address), parses it with
``email.policy.default`` and stores it in the ``mailbox_messages`` table so the
settings page can render a "本地邮件中心" without any external mail provider.

Public API (called from ``main.py`` lifespan):

* ``async def start_mail_server() -> None`` -- idempotent start, never raises.
* ``async def stop_mail_server() -> None`` -- idempotent stop.
* ``def mail_server_status() -> dict`` -- running/host/port/stored/limit payload.

The actual asyncio event loop runs in a dedicated daemon thread. That keeps the
server independent from the FastAPI event loop (the lifespan may restart under
uvicorn ``--reload``) and lets synchronous code such as ``email_service.deliver``
lazily (re)start it without touching the request's event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import datetime, timedelta, timezone
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses
from typing import Any

from ..config import BuiltinMailSettings, settings_service
from ..db import db, new_id, now_iso

logger = logging.getLogger("teamstudio.mail")

MAX_MESSAGE_BYTES = 2 * 1024 * 1024  # single message hard limit: 2 MB
MAX_CONNECTIONS = 16
IDLE_TIMEOUT = 300.0
DATA_TIMEOUT = 180.0
START_TIMEOUT = 8.0

_lock = threading.RLock()
_thread: threading.Thread | None = None
_loop: asyncio.AbstractEventLoop | None = None
_server: asyncio.AbstractServer | None = None
_running_signature: tuple[str, int, str] | None = None
_state: dict[str, Any] = {
    "running": False,
    "host": "",
    "port": 0,
    "hostname": "",
    "connections": 0,
    "lastError": "",
}


# ---------------------------------------------------------------------------
# settings helpers
# ---------------------------------------------------------------------------


def _builtin_config() -> BuiltinMailSettings:
    return settings_service.get().email.builtin


def _should_run() -> bool:
    email = settings_service.get().email
    return bool(email.enabled and email.deliveryMode == "builtin" and email.builtin.enabled)


def _signature(cfg: BuiltinMailSettings) -> tuple[str, int, str]:
    return (cfg.host, cfg.port, cfg.hostname)


# ---------------------------------------------------------------------------
# lifecycle (thread + private event loop)
# ---------------------------------------------------------------------------


def _start_sync() -> bool:
    """Start the SMTP server in its own thread. Returns True when listening."""

    global _thread, _loop, _server, _running_signature

    if not _should_run():
        return False
    cfg = _builtin_config()

    with _lock:
        if _state["running"] and _running_signature == _signature(cfg):
            return True
        _stop_sync()

        ready = threading.Event()
        outcome: dict[str, Any] = {}
        hostname = cfg.hostname or "teamstudio.local"

        def _runner() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            server = None
            try:
                semaphore = asyncio.Semaphore(MAX_CONNECTIONS)

                async def _handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
                    await _handle_client(reader, writer, hostname, semaphore)

                server = loop.run_until_complete(
                    asyncio.start_server(
                        _handler,
                        cfg.host,
                        cfg.port,
                        limit=MAX_MESSAGE_BYTES + 65536,
                    )
                )
                outcome["loop"] = loop
                outcome["server"] = server
            except Exception as exc:  # port busy, bad host, permissions, ...
                outcome["error"] = exc
            finally:
                ready.set()
            if server is None:
                try:
                    loop.close()
                except Exception:  # pragma: no cover - defensive
                    pass
                return
            try:
                loop.run_forever()
            finally:
                try:
                    server.close()
                    loop.run_until_complete(server.wait_closed())
                except Exception:  # pragma: no cover - defensive
                    pass
                pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
                for task in pending:
                    task.cancel()
                if pending:  # pragma: no cover - defensive cleanup
                    try:
                        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                    except Exception:
                        pass
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                except Exception:  # pragma: no cover - defensive
                    pass
                try:
                    loop.close()
                except Exception:  # pragma: no cover - defensive
                    pass

        thread = threading.Thread(target=_runner, name="teamstudio-smtp-server", daemon=True)
        thread.start()
        ready.wait(timeout=START_TIMEOUT)

        if outcome.get("error") is not None:
            _state.update(running=False, lastError=str(outcome["error"]))
            logger.warning(
                "内置邮件服务器启动失败（%s:%s）：%s", cfg.host, cfg.port, outcome["error"]
            )
            thread.join(timeout=1.0)
            return False
        if outcome.get("server") is None:  # pragma: no cover - timeout guard
            _state.update(running=False, lastError="内置邮件服务器启动超时")
            return False

        _thread = thread
        _loop = outcome["loop"]
        _server = outcome["server"]
        _running_signature = _signature(cfg)
        _state.update(running=True, host=cfg.host, port=cfg.port, hostname=hostname, lastError="")
        logger.info("内置邮件服务器已启动：%s:%s（hostname=%s）", cfg.host, cfg.port, hostname)
        return True


def _stop_sync() -> None:
    global _thread, _loop, _server, _running_signature

    with _lock:
        thread, loop, server = _thread, _loop, _server
        _thread = None
        _loop = None
        _server = None
        _running_signature = None
        _state.update(running=False, connections=0)
        if loop is None or server is None:
            return
        try:
            loop.call_soon_threadsafe(loop.stop)
        except RuntimeError:  # loop already closed
            pass
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=5.0)


def ensure_running_sync() -> bool:
    """Make the running state match the saved settings (lazy self-healing)."""

    try:
        should_run = _should_run()
    except Exception:  # pragma: no cover - settings never raise in practice
        return bool(_state["running"])
    with _lock:
        if not should_run:
            _stop_sync()
            return False
        cfg = _builtin_config()
        if _state["running"] and _running_signature == _signature(cfg):
            return True
        return _start_sync()


def restart_sync() -> bool:
    with _lock:
        _stop_sync()
        return _start_sync()


async def start_mail_server() -> None:
    """Idempotent startup hook used by the FastAPI lifespan.

    Failures (for example a busy port) are logged and swallowed so the API keeps
    booting even when the bundled SMTP server cannot listen.
    """

    try:
        await asyncio.to_thread(ensure_running_sync)
    except Exception:  # pragma: no cover - never break the API lifespan
        logger.exception("内置邮件服务器启动流程异常")


async def stop_mail_server() -> None:
    try:
        await asyncio.to_thread(_stop_sync)
    except Exception:  # pragma: no cover - best effort shutdown
        logger.exception("内置邮件服务器停止流程异常")


def _is_alive() -> bool:
    thread = _thread
    return bool(_state["running"] and thread is not None and thread.is_alive())


def mail_server_status() -> dict[str, Any]:
    """Snapshot of the bundled server for ``GET /api/email/status``."""

    try:
        cfg = _builtin_config()
        email = settings_service.get().email
    except Exception:  # pragma: no cover - defensive
        cfg = BuiltinMailSettings()
        email = None
    running = _is_alive()
    if _state["running"] and not running:  # thread died unexpectedly
        with _lock:
            _state["running"] = False
    stored = 0
    try:
        with db() as conn:
            stored = int(conn.execute("SELECT COUNT(*) FROM mailbox_messages").fetchone()[0])
    except Exception:  # pragma: no cover - table not ready yet
        stored = 0
    return {
        "enabled": bool(cfg.enabled),
        "deliveryMode": getattr(email, "deliveryMode", "builtin"),
        "running": running,
        "host": _state["host"] if running else cfg.host,
        "port": _state["port"] if running else cfg.port,
        "hostname": cfg.hostname,
        "stored": stored,
        "limit": cfg.mailboxLimit,
        "retentionDays": cfg.retentionDays,
        "connections": int(_state.get("connections") or 0),
        "lastError": _state.get("lastError", ""),
    }


# ---------------------------------------------------------------------------
# SMTP protocol
# ---------------------------------------------------------------------------

_ADDRESS_PARAM_RE = re.compile(r"\bsize=(\d+)", re.IGNORECASE)


def _parse_address(argument: str) -> str | None:
    """Extract an envelope address from ``MAIL FROM:``/``RCPT TO:`` arguments."""

    text = argument.strip()
    if text.startswith("<"):
        end = text.find(">")
        if end == -1:
            return None
        return text[1:end].strip()
    parts = text.split()
    if not parts:
        return None
    return parts[0].strip()


def _parse_size(argument: str) -> int | None:
    match = _ADDRESS_PARAM_RE.search(argument)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:  # pragma: no cover - regex guarantees digits
        return None


class _Session:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        hostname: str,
    ) -> None:
        self.reader = reader
        self.writer = writer
        self.hostname = hostname
        self.mail_from: str | None = None
        self.rcpt_to: list[str] = []

    # -- low level helpers -------------------------------------------------

    async def reply(self, text: str) -> None:
        self.writer.write(text.encode("utf-8", "replace"))
        await self.writer.drain()

    async def read_line(self, timeout: float) -> str | None:
        data = await asyncio.wait_for(self.reader.readline(), timeout=timeout)
        if not data:
            return None
        return data.decode("utf-8", "replace").rstrip("\r\n")

    def reset_transaction(self) -> None:
        self.mail_from = None
        self.rcpt_to = []

    # -- main loop ---------------------------------------------------------

    async def run(self) -> None:
        await self.reply(f"220 {self.hostname} ESMTP TeamStudio built-in mail server ready\r\n")
        while True:
            try:
                line = await self.read_line(IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                await self.reply("421 4.4.2 Idle timeout, closing connection\r\n")
                return
            except (ConnectionError, ValueError):
                return
            if line is None:
                return
            if not line.strip():
                await self.reply("500 5.5.2 Empty command\r\n")
                continue
            verb, _, argument = line.partition(" ")
            command = verb.upper()
            if command == "EHLO":
                await self._ehlo(argument)
            elif command == "HELO":
                await self._helo(argument)
            elif command == "MAIL":
                await self._mail(argument)
            elif command == "RCPT":
                await self._rcpt(argument)
            elif command == "DATA":
                should_close = await self._data()
                if should_close:
                    return
            elif command == "RSET":
                self.reset_transaction()
                await self.reply("250 2.0.0 Reset OK\r\n")
            elif command == "NOOP":
                await self.reply("250 2.0.0 OK\r\n")
            elif command == "QUIT":
                await self.reply("221 2.0.0 Bye\r\n")
                return
            else:
                await self.reply("502 5.5.1 Command not implemented\r\n")

    async def _ehlo(self, argument: str) -> None:
        client = argument.strip() or "unknown"
        await self.reply(
            f"250-{self.hostname} Hello {client}\r\n"
            f"250-SIZE {MAX_MESSAGE_BYTES}\r\n"
            "250-8BITMIME\r\n"
            "250 HELP\r\n"
        )

    async def _helo(self, argument: str) -> None:
        client = argument.strip() or "unknown"
        await self.reply(f"250 {self.hostname} Hello {client}\r\n")

    async def _mail(self, argument: str) -> None:
        if not argument.upper().startswith("FROM:"):
            await self.reply("501 5.5.4 Syntax: MAIL FROM:<address>\r\n")
            return
        address = _parse_address(argument[5:])
        if address is None:
            await self.reply("501 5.1.7 Bad sender address syntax\r\n")
            return
        declared = _parse_size(argument)
        if declared is not None and declared > MAX_MESSAGE_BYTES:
            await self.reply("552 5.3.4 Message size exceeds fixed maximum message size\r\n")
            return
        self.mail_from = address
        self.rcpt_to = []
        await self.reply("250 2.1.0 Sender OK\r\n")

    async def _rcpt(self, argument: str) -> None:
        if self.mail_from is None:
            await self.reply("503 5.5.1 Need MAIL before RCPT\r\n")
            return
        if not argument.upper().startswith("TO:"):
            await self.reply("501 5.5.4 Syntax: RCPT TO:<address>\r\n")
            return
        address = _parse_address(argument[3:])
        if not address:
            await self.reply("501 5.1.3 Bad recipient address syntax\r\n")
            return
        if address not in self.rcpt_to:
            self.rcpt_to.append(address)
        await self.reply("250 2.1.5 Recipient OK\r\n")

    async def _data(self) -> bool:
        if self.mail_from is None:
            await self.reply("503 5.5.1 Need MAIL before DATA\r\n")
            return False
        if not self.rcpt_to:
            await self.reply("503 5.5.1 Need RCPT before DATA\r\n")
            return False
        await self.reply("354 End data with <CR><LF>.<CR><LF>\r\n")
        raw, too_big, lost_connection = await self._receive_data()
        if lost_connection:
            return True
        if too_big:
            await self.reply("552 5.3.4 Message size exceeds fixed maximum message size\r\n")
            self.reset_transaction()
            return False
        try:
            _store_received(raw, self.mail_from, list(self.rcpt_to))
        except Exception:
            logger.exception("内置邮件服务器写入邮箱失败")
            await self.reply("451 4.3.0 Local mailbox error, try again later\r\n")
            self.reset_transaction()
            return False
        await self.reply("250 2.0.0 OK: message stored in the TeamStudio mailbox\r\n")
        self.reset_transaction()
        return False

    async def _receive_data(self) -> tuple[bytes, bool, bool]:
        chunks: list[bytes] = []
        total = 0
        too_big = False
        while True:
            try:
                data = await asyncio.wait_for(self.reader.readline(), timeout=DATA_TIMEOUT)
            except asyncio.TimeoutError:
                await self.reply("421 4.4.2 Data timeout, closing connection\r\n")
                return b"", False, True
            except (ConnectionError, ValueError):
                return b"", False, True
            if not data:
                return b"", False, True
            if data in (b".\r\n", b".\n"):
                break
            if data.startswith(b".."):
                data = data[1:]  # undo SMTP dot-stuffing
            total += len(data)
            if total > MAX_MESSAGE_BYTES:
                too_big = True
                continue
            chunks.append(data)
        return b"".join(chunks), too_big, False


async def _handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    hostname: str,
    semaphore: asyncio.Semaphore,
) -> None:
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=5.0)
    except asyncio.TimeoutError:
        try:
            writer.write(b"421 4.3.2 Too many connections, try again later\r\n")
            await writer.drain()
        except Exception:  # pragma: no cover - client vanished
            pass
        try:
            writer.close()
        except Exception:  # pragma: no cover - defensive
            pass
        return
    _state["connections"] = int(_state.get("connections") or 0) + 1
    try:
        await _Session(reader, writer, hostname).run()
    except Exception:  # pragma: no cover - keep the server alive
        logger.exception("内置邮件服务器处理连接时出错")
    finally:
        _state["connections"] = max(0, int(_state.get("connections") or 1) - 1)
        semaphore.release()
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:  # pragma: no cover - defensive
            pass


# ---------------------------------------------------------------------------
# message parsing / persistence
# ---------------------------------------------------------------------------


def _part_text(part: EmailMessage) -> str:
    try:
        content = part.get_content()
    except Exception:
        payload = part.get_payload(decode=True)
        if not payload:
            return ""
        charset = part.get_content_charset() or "utf-8"
        try:
            return payload.decode(charset, errors="replace")
        except LookupError:
            return payload.decode("utf-8", errors="replace")
    if isinstance(content, bytes):
        return content.decode("utf-8", errors="replace")
    return str(content)


def _extract_body(message: EmailMessage) -> tuple[str, str]:
    body_text = ""
    body_html = ""
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_maintype() == "multipart":
                continue
            content_type = part.get_content_type()
            if content_type == "text/plain" and not body_text:
                body_text = _part_text(part)
            elif content_type == "text/html" and not body_html:
                body_html = _part_text(part)
    else:
        if message.get_content_type() == "text/html":
            body_html = _part_text(message)
        else:
            body_text = _part_text(message)
    return body_text, body_html


def _header_text(message: EmailMessage, name: str, limit: int = 200) -> str:
    value = message.get(name)
    if value is None:
        return ""
    return str(value)[:limit]


def _store_received(raw: bytes, mail_from: str, rcpt_to: list[str]) -> str:
    """Parse a raw SMTP payload and persist it into ``mailbox_messages``."""

    kind = "test"
    group_id = ""
    todo_id = ""
    status = "stored"
    error = ""
    subject = ""
    body_text = ""
    body_html = ""
    cc_addrs: list[str] = []
    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
        subject = _header_text(message, "Subject", 500)
        cc_addrs = [address for _, address in getaddresses([_header_text(message, "Cc", 2000)]) if address]
        body_text, body_html = _extract_body(message)
        kind = _header_text(message, "X-TeamStudio-Kind", 40) or "test"
        group_id = _header_text(message, "X-TeamStudio-Group-Id", 80)
        todo_id = _header_text(message, "X-TeamStudio-Todo-Id", 80)
    except Exception as exc:  # malformed message: keep the raw payload for debugging
        status = "error"
        error = f"邮件解析失败：{exc}"[:500]
        subject = "(无法解析的邮件)"
        body_text = raw.decode("utf-8", errors="replace")[:200_000]

    raw_text = raw.decode("utf-8", errors="replace")
    to_addrs = list(dict.fromkeys(rcpt_to))
    cc_addrs = list(dict.fromkeys(cc_addrs))
    created_at = now_iso()
    message_id = new_id("mailbox")
    cfg = _builtin_config()
    with db() as conn:
        conn.execute(
            "INSERT INTO mailbox_messages "
            "(id,direction,from_addr,to_addrs,cc_addrs,subject,body_text,body_html,raw,kind,"
            "group_id,todo_id,status,error,created_at,read_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
            (
                message_id,
                "outbound",
                mail_from,
                json.dumps(to_addrs, ensure_ascii=False),
                json.dumps(cc_addrs, ensure_ascii=False),
                subject,
                body_text,
                body_html,
                raw_text,
                kind,
                group_id,
                todo_id,
                status,
                error,
                created_at,
            ),
        )
        _prune_mailbox(conn, cfg)
        conn.commit()
    logger.info(
        "内置邮件服务器已收信：from=%s to=%s subject=%s", mail_from, ",".join(to_addrs), subject
    )
    return message_id


def _prune_mailbox(conn, cfg: BuiltinMailSettings) -> None:
    """Apply retentionDays / mailboxLimit so the local mailbox stays bounded."""

    try:
        cutoff = (
            datetime.now(timezone.utc).astimezone() - timedelta(days=cfg.retentionDays)
        ).isoformat(timespec="seconds")
        conn.execute("DELETE FROM mailbox_messages WHERE created_at < ?", (cutoff,))
        conn.execute(
            "DELETE FROM mailbox_messages WHERE id IN ("
            "SELECT id FROM mailbox_messages ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
            (cfg.mailboxLimit,),
        )
    except Exception:  # pragma: no cover - pruning must never drop the message
        logger.exception("清理本地邮件中心记录失败")
