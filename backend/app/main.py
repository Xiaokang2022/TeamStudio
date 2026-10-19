"""TeamStudio FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import FRONTEND_DIST, settings_service
from .db import init_db
from .seed import seed_if_empty, seed_member_tasks_if_empty
from .services import scheduler
from .routers import auth as auth_router
from .routers import bootstrap as bootstrap_router
from .routers import email as email_router
from .routers import settings as settings_router

try:  # Feature routers are developed in parallel; keep API bootable during scaffolding.
    from .routers import boards, calendar, tasks, workspace
except ImportError as exc:  # pragma: no cover - only during initial scaffolding
    boards = calendar = tasks = workspace = None  # type: ignore[assignment]
    _FEATURE_IMPORT_ERROR = exc
else:
    _FEATURE_IMPORT_ERROR = None

logger = logging.getLogger("teamstudio")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seeded = seed_if_empty()
    seeded_tasks = seed_member_tasks_if_empty()
    logger.info(
        "TeamStudio started (seeded=%s, memberTasksSeeded=%s)", seeded, seeded_tasks
    )
    scheduler.start_scheduler()
    yield
    await scheduler.stop_scheduler()


app = FastAPI(
    title="TeamStudio API",
    description="现代化团队工作室：团队 / 开发组协作、日历、红黑榜与邮件提醒",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)

app.add_middleware(GZipMiddleware, minimum_size=800)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


def _error_json(status: int, code: str, message: str, details=None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"ok": False, "error": {"code": code, "message": message, "details": details}},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return _error_json(
            exc.status_code,
            str(detail.get("code", "http_error")),
            str(detail.get("message", "请求失败")),
            detail.get("details"),
        )
    return _error_json(exc.status_code, "http_error", str(detail))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    details = [
        {
            "path": ".".join(str(part) for part in error.get("loc", ())),
            "message": error.get("msg", "参数错误"),
        }
        for error in exc.errors()
    ]
    return _error_json(422, "validation_error", "请求参数校验失败", details)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return _error_json(500, "internal_error", "服务器内部错误，请查看服务日志")


app.include_router(auth_router.router)
app.include_router(bootstrap_router.router)
app.include_router(settings_router.router)
app.include_router(email_router.router)
if workspace and calendar and boards and tasks:
    app.include_router(workspace.router)
    app.include_router(calendar.router)
    app.include_router(boards.router)
    app.include_router(tasks.router)
elif _FEATURE_IMPORT_ERROR:
    logger.warning("Feature routers unavailable: %s", _FEATURE_IMPORT_ERROR)

if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_frontend(full_path: str):
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "接口不存在"})
    if FRONTEND_DIST.exists():
        candidate = (FRONTEND_DIST / full_path).resolve()
        if candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        index = FRONTEND_DIST / "index.html"
        if index.exists():
            return FileResponse(index)
    return HTMLResponse(
        """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <title>TeamStudio API</title>
        <style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;
        place-items:center;min-height:100vh;margin:0}main{text-align:center;max-width:560px;
        padding:40px;border:1px solid #334155;border-radius:24px;background:#1e293b}
        code{background:#0f172a;padding:2px 8px;border-radius:6px;color:#7dd3fc}
        a{color:#818cf8}</style></head><body><main><h1>TeamStudio API 正在运行</h1>
        <p>前端尚未构建。请运行 <code>scripts\\build.ps1</code>，或启动 Vite 开发服务器。</p>
        <p><a href="/api/docs">查看 API 文档</a> · <a href="/api/health">健康检查</a></p>
        </main></body></html>
        """,
        status_code=200,
    )
