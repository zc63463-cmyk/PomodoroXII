"""Domain exception hierarchy and FastAPI exception handlers.

All application errors derive from :class:`AppError`, which carries a
stable ``error_type`` string so clients can branch on semantics rather
than parsing the human-readable ``detail``.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


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


def register_exception_handlers(app: FastAPI) -> None:
    """Register handlers for AppError subclasses and a catch-all 500."""

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": exc.detail,
                "error_type": exc.error_type,
            },
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
