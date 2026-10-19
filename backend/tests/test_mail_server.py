"""Bundled SMTP server, offline delivery and local mail center API tests."""

from __future__ import annotations

import json
import smtplib
import socket
from email.message import EmailMessage

import pytest

from backend.app.config import DEFAULT_SETTINGS, settings_service
from backend.app.db import db, new_id, now_iso, rows
from backend.app.services import mail_server
from backend.app.services.email_service import deliver, smtp_configured

MAX_MESSAGE_BYTES = 2 * 1024 * 1024


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _builtin_settings(port: int) -> dict:
    payload = DEFAULT_SETTINGS.model_dump(mode="json")
    payload["email"]["enabled"] = True
    payload["email"]["deliveryMode"] = "builtin"
    payload["email"]["builtin"].update(
        {
            "enabled": True,
            "host": "127.0.0.1",
            "port": port,
            "hostname": "mail.test",
            "mailboxLimit": 200,
            "retentionDays": 30,
        }
    )
    return payload


@pytest.fixture()
def builtin_mail(client):
    """Start the bundled SMTP server on a random free port for one test."""

    port = 0
    started = False
    for _ in range(5):
        port = _free_port()
        settings_service.save(_builtin_settings(port))
        if mail_server.ensure_running_sync():
            started = True
            break
    if not started:  # pragma: no cover - extremely unlikely on CI machines
        settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
        pytest.skip("无法在随机端口启动内置 SMTP 服务器")
    try:
        yield port
    finally:
        settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
        mail_server.ensure_running_sync()  # stops, because email.enabled is false again


def _send(
    port: int,
    *,
    sender: str,
    recipients: list[str],
    subject: str,
    body: str,
    cc: list[str] | None = None,
    connection: smtplib.SMTP | None = None,
) -> None:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    if cc:
        message["Cc"] = ", ".join(cc)
    message["Subject"] = subject
    message.set_content(body)
    owns_connection = connection is None
    smtp = connection or smtplib.SMTP("127.0.0.1", port, timeout=15)
    try:
        smtp.ehlo("pytest")
        smtp.send_message(message, from_addr=sender, to_addrs=recipients)
    finally:
        if owns_connection:
            smtp.quit()


def _stored_records() -> list[dict]:
    with db() as conn:
        return rows(
            conn,
            "SELECT * FROM mailbox_messages ORDER BY created_at, id",
        )


def test_builtin_smtp_stores_multi_recipient_messages(client, builtin_mail):
    port = builtin_mail
    with smtplib.SMTP("127.0.0.1", port, timeout=15) as smtp:
        smtp.ehlo("pytest")
        _send(
            port,
            sender="sender@local.test",
            recipients=["a@local.test", "b@local.test"],
            cc=["cc@local.test"],
            subject="内置服务器验收",
            body="第一行\n.以点开头的第二行\n最后一行",
            connection=smtp,
        )
        # Same connection, a second message: the transaction must be reset.
        _send(
            port,
            sender="sender@local.test",
            recipients=["c@local.test"],
            subject="同一连接的第二封",
            body="第二封正文",
            connection=smtp,
        )

    records = _stored_records()
    subjects = [record["subject"] for record in records]
    assert "内置服务器验收" in subjects
    assert "同一连接的第二封" in subjects

    first = next(record for record in records if record["subject"] == "内置服务器验收")
    assert first["direction"] == "outbound"
    assert first["from_addr"] == "sender@local.test"
    assert json.loads(first["to_addrs"]) == ["a@local.test", "b@local.test"]
    assert json.loads(first["cc_addrs"]) == ["cc@local.test"]
    assert first["status"] == "stored"
    # Dot-stuffing must be undone when parsing the stored payload.
    assert ".以点开头的第二行" in first["body_text"]
    assert first["body_text"].splitlines()[0] == "第一行"

    second = next(record for record in records if record["subject"] == "同一连接的第二封")
    assert json.loads(second["to_addrs"]) == ["c@local.test"]


def test_builtin_smtp_protocol_errors_and_noop(client, builtin_mail):
    port = builtin_mail
    with socket.create_connection(("127.0.0.1", port), timeout=15) as sock:
        stream = sock.makefile("rwb")

        def read_response() -> list[str]:
            lines: list[str] = []
            while True:
                raw = stream.readline()
                assert raw, "SMTP server closed the connection unexpectedly"
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                lines.append(line)
                if len(line) >= 4 and line[3] == " ":
                    return lines

        assert read_response()[0].startswith("220")
        stream.write(b"EHLO pytest\r\n")
        stream.flush()
        ehlo = read_response()
        assert ehlo[-1].startswith("250")
        assert any(line.startswith("250-SIZE") for line in ehlo)

        stream.write(b"RCPT TO:<early@local.test>\r\n")
        stream.flush()
        assert read_response()[0].startswith("503")

        stream.write(b"FOOBAR\r\n")
        stream.flush()
        assert read_response()[0].startswith("502")

        stream.write(b"NOOP\r\n")
        stream.flush()
        assert read_response()[0].startswith("250")

        stream.write(b"RSET\r\n")
        stream.flush()
        assert read_response()[0].startswith("250")

        stream.write(b"QUIT\r\n")
        stream.flush()
        assert read_response()[0].startswith("221")
        stream.close()


def test_builtin_smtp_rejects_oversized_message(client, builtin_mail):
    port = builtin_mail
    message = EmailMessage()
    message["From"] = "sender@local.test"
    message["To"] = "big@local.test"
    message["Subject"] = "超大邮件"
    message.set_content("x" * (MAX_MESSAGE_BYTES + 4096))
    with smtplib.SMTP("127.0.0.1", port, timeout=30) as smtp:
        smtp.ehlo("pytest")
        with pytest.raises(smtplib.SMTPResponseException) as excinfo:
            smtp.send_message(message)
        assert excinfo.value.smtp_code == 552
    assert _stored_records() == []


def test_email_status_reports_builtin_block(client):
    data = client.get("/api/email/status").json()["data"]
    assert data["enabled"] is False
    assert data["deliveryMode"] == "builtin"
    assert data["builtin"]["enabled"] is True
    assert data["builtin"]["running"] is False
    assert data["builtin"]["limit"] > 0
    assert "permission" not in data  # legacy keys must stay intact
    assert isinstance(data["scheduler"], dict)
    assert "running" in data["scheduler"]
    assert "subject" in data["templatePreview"]
    assert "body" in data["templatePreview"]
    assert data["smtpConfigured"] is False


def test_offline_test_mail_mailbox_and_delivery_logs(client, builtin_mail):
    port = builtin_mail
    status = client.get("/api/email/status").json()["data"]
    assert status["deliveryMode"] == "builtin"
    assert status["builtin"]["running"] is True
    assert status["builtin"]["port"] == port
    assert status["builtin"]["host"] == "127.0.0.1"
    assert status["builtin"]["hostname"] == "mail.test"
    assert status["builtin"]["limit"] == 200
    assert status["smtpConfigured"] is True

    response = client.post("/api/email/test", json={"to": "qa@local.test"})
    assert response.status_code == 200
    assert response.json()["data"]["sent"] is True

    logs = client.get("/api/email/logs").json()["data"]["logs"]
    assert any(
        log["kind"] == "test" and log["status"] == "sent" and log["recipient"].endswith("@local.test")
        for log in logs
    )

    mailbox = client.get("/api/email/mailbox?limit=10&box=outbound").json()["data"]
    assert mailbox["total"] >= 1
    assert mailbox["builtin"]["running"] is True
    message = next(item for item in mailbox["messages"] if item["toAddrs"] == ["qa@local.test"])
    assert message["subject"]
    assert message["kind"] == "test"
    assert message["readAt"] is None

    detail = client.get(f"/api/email/mailbox/{message['id']}").json()["data"]["message"]
    assert "内置邮件服务器" in detail["bodyText"]
    assert detail["readAt"]

    # Reading again must not overwrite the first read timestamp.
    again = client.get(f"/api/email/mailbox/{message['id']}").json()["data"]["message"]
    assert again["readAt"] == detail["readAt"]

    deleted = client.delete(f"/api/email/mailbox/{message['id']}")
    assert deleted.json()["data"]["deleted"] is True
    assert client.get(f"/api/email/mailbox/{message['id']}").status_code == 404
    assert client.delete(f"/api/email/mailbox/{message['id']}").status_code == 404
    assert client.get("/api/email/mailbox?limit=10").json()["data"]["total"] == 0


def test_deliver_builtin_works_offline_and_logs(client, builtin_mail):
    assert smtp_configured() is True
    deliver(
        recipient="ops@local.test",
        subject="离线投递验收",
        body="不依赖外部邮件服务器即可投递。",
        kind="test",
        detail="offline unit test",
    )
    records = _stored_records()
    stored = next(record for record in records if record["subject"] == "离线投递验收")
    assert json.loads(stored["to_addrs"]) == ["ops@local.test"]
    assert "不依赖外部邮件服务器" in stored["body_text"]

    with db() as conn:
        sent = rows(
            conn,
            "SELECT * FROM email_logs WHERE status='sent' AND recipient='ops@local.test'",
        )
    assert sent
    assert "channel=builtin" in sent[-1]["detail"]


def test_mailbox_list_truncates_body_but_detail_is_complete(client, builtin_mail):
    long_body = "S" * 5000
    with db() as conn:
        conn.execute(
            "INSERT INTO mailbox_messages (id,direction,from_addr,to_addrs,cc_addrs,subject,"
            "body_text,body_html,raw,kind,group_id,todo_id,status,error,created_at,read_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
            (
                new_id("mailbox"),
                "outbound",
                "long@local.test",
                json.dumps(["long@local.test"], ensure_ascii=False),
                json.dumps([], ensure_ascii=False),
                "超长正文",
                long_body,
                "",
                "",
                "test",
                "",
                "",
                "stored",
                "",
                now_iso(),
            ),
        )
        conn.commit()
    mailbox = client.get("/api/email/mailbox?limit=10").json()["data"]
    listed = next(item for item in mailbox["messages"] if item["subject"] == "超长正文")
    assert len(listed["bodyText"]) <= 4100
    assert listed["bodyText"].startswith("S" * 100)
    detail = client.get(f"/api/email/mailbox/{listed['id']}").json()["data"]["message"]
    assert detail["bodyText"] == long_body


def test_restart_endpoint_is_idempotent(client, builtin_mail):
    first = client.post("/api/email/builtin/restart").json()["data"]
    assert first["running"] is True
    assert first["port"] == builtin_mail
    second = client.post("/api/email/builtin/restart").json()["data"]
    assert second["running"] is True
    assert second["port"] == builtin_mail
