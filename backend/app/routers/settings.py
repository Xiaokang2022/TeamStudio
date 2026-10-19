"""Full settings JSON/GUI editing, validation and schema endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from ..auth import CurrentUser, require_super
from ..config import DEFAULT_SETTINGS, ConfigValidationError, settings_service
from ..db import db, rows
from ..http import ok


router = APIRouter(prefix="/api/settings", tags=["settings"])


def _settings_payload() -> dict[str, Any]:
    return {
        "settings": settings_service.get().model_dump(mode="json"),
        "meta": settings_service.meta(),
    }


@router.get("")
def get_settings(user: CurrentUser = Depends(require_super)):
    return ok(_settings_payload())


@router.put("")
def save_settings(
    payload: dict[str, Any] = Body(...), user: CurrentUser = Depends(require_super)
):
    try:
        saved = settings_service.save(payload)
    except ConfigValidationError as exc:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": {
                    "code": "settings_validation_failed",
                    "message": "配置校验未通过，请修正后再保存。",
                    "details": exc.details,
                },
            },
        )
    return ok(
        {
            "settings": saved.model_dump(mode="json"),
            "meta": settings_service.meta(),
            "message": "配置已保存并即时生效",
        }
    )


@router.post("/validate")
def validate_settings(payload: dict[str, Any] = Body(...), user: CurrentUser = Depends(require_super)):
    valid, candidate, details = settings_service.validate(payload)
    if not valid:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": {
                    "code": "settings_validation_failed",
                    "message": "JSON 配置校验未通过。",
                    "details": details,
                },
            },
        )
    return ok({"valid": True, "settings": candidate.model_dump(mode="json") if candidate else None})


@router.get("/schema")
def settings_schema(user: CurrentUser = Depends(require_super)):
    return ok({"schema": settings_service.schema(), "meta": settings_service.meta()})


@router.get("/defaults")
def settings_defaults(user: CurrentUser = Depends(require_super)):
    return ok(DEFAULT_SETTINGS.model_dump(mode="json"))


@router.get("/workspace")
def settings_workspace(user: CurrentUser = Depends(require_super)):
    with db() as conn:
        teams = rows(conn, "SELECT id,name,short_name,color FROM teams ORDER BY sort_order, name")
        groups = rows(conn, "SELECT id,team_id,name,color FROM groups ORDER BY sort_order, name")
        members = rows(
            conn,
            "SELECT id,team_id,group_id,name,email,title FROM members ORDER BY team_id, group_id, sort_order",
        )
    return ok({"teams": teams, "groups": groups, "members": members})
