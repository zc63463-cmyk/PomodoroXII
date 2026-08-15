"""HTTP middleware for the PomodoroXII API."""

from __future__ import annotations

import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.logging import request_id_var
from app.ops.routes import HTTP_LATENCY, HTTP_REQUESTS
from app.settings import settings


def _route_template(request: Request) -> str:
    """Return the matched route template, or ``unmatched`` for 404s.

    Starlette stores the matched route on the request scope after routing;
    the path parameter placeholders (``{space_id}`` etc.) are the template,
    never the raw request path.  This keeps the label cardinality bounded.
    """
    route = request.scope.get("route")
    template = getattr(route, "path", None)
    return template if isinstance(template, str) and template else "unmatched"


class RequestMetricsMiddleware(BaseHTTPMiddleware):
    """Record bounded HTTP request metrics (method/route/status_class).

    The route label is the matched template (or ``unmatched``), never the raw
    URI, and no identity values (space ids, request ids, tokens) appear in any
    label.  ``/api/metrics`` itself is observed like any other route.
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            HTTP_REQUESTS.labels(
                request.method, _route_template(request), "5xx"
            ).inc()
            HTTP_LATENCY.labels(
                request.method, _route_template(request), "5xx"
            ).observe(time.perf_counter() - start)
            raise
        labels = (
            request.method,
            _route_template(request),
            f"{response.status_code // 100}xx",
        )
        HTTP_REQUESTS.labels(*labels).inc()
        HTTP_LATENCY.labels(*labels).observe(time.perf_counter() - start)
        return response


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
