"""HTTP middleware for the PomodoroXII API."""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.logging import request_id_var


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
