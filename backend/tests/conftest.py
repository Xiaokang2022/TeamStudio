"""Shared pytest fixtures with an isolated data directory."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="teamstudio-test-"))
os.environ["TEAMSTUDIO_DATA_DIR"] = str(TEST_DATA_DIR)
os.environ["TEAMSTUDIO_DB"] = str(TEST_DATA_DIR / "teamstudio-test.db")
os.environ["TEAMSTUDIO_SETTINGS"] = str(TEST_DATA_DIR / "settings-test.json")
os.environ["TEAMSTUDIO_SESSION_SECRET"] = "teamstudio-test-secret-please-change"
os.environ["TEAMSTUDIO_TRUST_PROXY"] = "0"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _cleanup_test_data():
    yield
    shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)


@pytest.fixture()
def client():
    from backend.app.config import DEFAULT_SETTINGS, settings_service
    from backend.app.db import DB_PATH, init_db
    from backend.app.main import app
    from backend.app.seed import seed_if_empty

    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        if sidecar.exists():
            sidecar.unlink()
    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
    init_db()
    seed_if_empty()
    with TestClient(app, client=("127.0.0.1", 51000), raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture()
def guest_client():
    from fastapi.testclient import TestClient

    from backend.app.config import DEFAULT_SETTINGS, settings_service
    from backend.app.db import DB_PATH, init_db
    from backend.app.main import app
    from backend.app.seed import seed_if_empty

    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        if sidecar.exists():
            sidecar.unlink()
    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
    init_db()
    seed_if_empty()
    with TestClient(app, client=("10.20.30.40", 51001), raise_server_exceptions=False) as test_client:
        yield test_client
