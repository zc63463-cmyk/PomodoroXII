"""HTTP middleware for the PomodoroXII API."""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.logging import request_id_var
from app.settings import settings


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Propagate a per-request id through the logging context and headers.

    - Reuse an incoming ``x-request-id`` header if present.
    - Otherwise generate a fresh UUID4.
    - Bind it to ``request_id_var`` so structured logs include it.
    - Echo it back in the ``x-request-id`` response header for tracing.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["x-request-id"] = request_id
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach baseline security headers to every HTTP response.

    Headers added in all environments:
      - ``X-Content-Type-Options: nosniff``
      - ``X-Frame-Options: DENY``
      - ``Referrer-Policy: strict-origin-when-cross-origin``
      - ``Permissions-Policy`` (restricts camera, microphone, geolocation)

    In production, when ``settings.debug`` is disabled, also adds:
      - ``Strict-Transport-Security: max-age=31536000; includeSubDomains``
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=()"
        )
        if settings.environment == "production" and not settings.debug:
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        return response
