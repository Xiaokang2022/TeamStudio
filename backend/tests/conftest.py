"""Shared pytest fixtures with an isolated data directory."""

from __future__ import annotations

import os
import shutil
import sys
import uuid
from pathlib import Path

# The Windows workspace sandbox cannot provision owner-only (0o700) directories:
# writing a file inside them afterwards fails with ``PermissionError``. Both
# ``tempfile.mkdtemp`` and pytest's temporary-directory factory request 0o700, so
# widen that mode for this test process only.
if sys.platform == "win32":
    _platform_mkdir = os.mkdir

    def _sandbox_friendly_mkdir(path, mode=0o777, *, dir_fd=None):
        if dir_fd is not None:
            return _platform_mkdir(path, mode, dir_fd=dir_fd)
        return _platform_mkdir(path, 0o775 if mode == 0o700 else mode)

    os.mkdir = _sandbox_friendly_mkdir  # type: ignore[assignment]

# Keep every test artefact below the repository root instead of the system temp
# directory; ``TEAMSTUDIO_TEST_ROOT`` can point it at another writable location.
_TEST_ROOT = Path(
    os.environ.get(
        "TEAMSTUDIO_TEST_ROOT",
        str(Path(__file__).resolve().parents[2] / ".pytest-tmp"),
    )
)
_TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("PYTEST_DEBUG_TEMPROOT", str(_TEST_ROOT))
TEST_DATA_DIR = _TEST_ROOT / f"teamstudio-test-{os.getpid()}-{uuid.uuid4().hex[:8]}"
TEST_DATA_DIR.mkdir(parents=True)
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
    from backend.app.seed import seed_demo_data

    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        if sidecar.exists():
            sidecar.unlink()
    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
    init_db()
    seed_demo_data()
    with TestClient(app, client=("127.0.0.1", 51000), raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture()
def guest_client():
    from fastapi.testclient import TestClient

    from backend.app.config import DEFAULT_SETTINGS, settings_service
    from backend.app.db import DB_PATH, init_db
    from backend.app.main import app
    from backend.app.seed import seed_demo_data

    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        if sidecar.exists():
            sidecar.unlink()
    settings_service.save(DEFAULT_SETTINGS.model_dump(mode="json"))
    init_db()
    seed_demo_data()
    with TestClient(app, client=("10.20.30.40", 51001), raise_server_exceptions=False) as test_client:
        yield test_client
