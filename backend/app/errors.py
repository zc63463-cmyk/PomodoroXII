"""Domain exception hierarchy and FastAPI exception handlers.

All application errors derive from :class:`AppError`, which carries a
stable ``error_type`` string so clients can branch on semantics rather
than parsing the human-readable ``detail``.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.schemas.common import (
    RequestValidationErrorResponse,
    RequestValidationIssue,
)


class AppError(Exception):
    """Base class for all expected application errors.

    Attributes:
        detail: Human-readable message shown to the client.
        status_code: HTTP status code returned.
        error_type: Stable machine-readable error code.
    """

    detail: str = "Application error"
    status_code: int = 500
    error_type: str = "app_error"

    def __init__(
        self,
        detail: str | None = None,
        status_code: int | None = None,
        error_type: str | None = None,
    ) -> None:
        if detail is not None:
            self.detail = detail
        if status_code is not None:
            self.status_code = status_code
        if error_type is not None:
            self.error_type = error_type
        super().__init__(self.detail)


class NotFoundError(AppError):
    detail = "Resource not found"
    status_code = 404
    error_type = "not_found"


class ConflictError(AppError):
    detail = "Conflict with current state"
    status_code = 409
    error_type = "conflict"


class ValidationError(AppError):
    detail = "Validation error"
    status_code = 422
    error_type = "validation_error"


class AuthenticationError(AppError):
    detail = "Authentication required"
    status_code = 401
    error_type = "authentication_error"


class AuthorizationError(AppError):
    detail = "Not authorized"
    status_code = 403
    error_type = "authorization_error"


class SyncCursorExpiredError(AppError):
    detail = "Sync cursor expired; perform a full sync"
    status_code = 409
    error_type = "sync_cursor_expired"

    def __init__(self, *, floor: int, current_cursor: int) -> None:
        super().__init__()
        self.floor = floor
        self.current_cursor = current_cursor
        self.recovery_action = "full_sync"


class SyncSnapshotExpiredError(AppError):
    detail = "Sync snapshot expired; restart full sync"
    status_code = 409
    error_type = "sync_snapshot_expired"


def register_exception_handlers(app: FastAPI) -> None:
    """Register handlers for AppError subclasses and a catch-all 500."""

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        content = {
            "detail": exc.detail,
            "error_type": exc.error_type,
        }
        if isinstance(exc, SyncCursorExpiredError):
            content.update({
                "floor": exc.floor,
                "current_cursor": exc.current_cursor,
                "recovery_action": exc.recovery_action,
            })
        return JSONResponse(status_code=exc.status_code, content=content)

    @app.exception_handler(RequestValidationError)
    async def _handle_request_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        body = RequestValidationErrorResponse(
            detail="Request validation failed",
            error_type="request_validation_error",
            errors=[
                RequestValidationIssue(
                    loc=list(error.get("loc", [])),
                    msg=error.get("msg", ""),
                    type=error.get("type", ""),
                )
                for error in exc.errors()
            ],
        )
        return JSONResponse(
            status_code=422,
            content=body.model_dump(mode="json"),
        )

    @app.exception_handler(500)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logging = __import__("logging")
        logging.getLogger("pomodoroxi.errors").error(
            "Unhandled exception on %s %s: %s",
            request.method,
            request.url.path,
            exc,
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "error_type": "server_error"},
        )
