"""Operational endpoints: metrics and credential-gated observability.

``/api/metrics`` is the only Prometheus scrape endpoint.  It is protected by
the digest-only operations credential (``OperationsCredentialStore``); master
and space JWTs are rejected.  All metric labels are low-cardinality:
HTTP observations use only ``method``/``route``/``status_class`` and recovery
observations use only ``operation``/``outcome``.  Identity values (space ids,
entity ids, request ids), raw paths and tokens are never label values.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from prometheus_client import Counter, Gauge, Histogram, generate_latest
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_meta_db
from app.errors import AuthenticationError
from app.ops.credentials import OperationsCredentialStore, OperationsPrincipal
from app.schemas.common import ErrorResponse

router = APIRouter()

_bearer = HTTPBearer(auto_error=False)

# --------------------------------------------------------------------------- #
# Prometheus metrics (bounded cardinality by construction)
# --------------------------------------------------------------------------- #

# HTTP observations: route is the matched route template (or "unmatched").
HTTP_REQUESTS = Counter(
    "pomodoroxii_http_requests_total",
    "HTTP requests by method, route template and status class",
    ["method", "route", "status_class"],
)
HTTP_LATENCY = Histogram(
    "pomodoroxii_http_request_duration_seconds",
    "HTTP request latency by method, route template and status class",
    ["method", "route", "status_class"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# Recovery observations: operation/outcome only, never space or snapshot ids.
RECOVERY_OPERATIONS = Counter(
    "pomodoroxii_recovery_operations_total",
    "Recovery operations by operation and outcome",
    ["operation", "outcome"],
)
RECOVERY_LAST_SNAPSHOT_SECONDS = Gauge(
    "pomodoroxii_recovery_last_snapshot_success_timestamp_seconds",
    "Unix timestamp of the last verified snapshot, 0 if none",
)
RECOVERY_BACKUP_AGE_SECONDS = Gauge(
    "pomodoroxii_recovery_backup_age_seconds",
    "Seconds since the last verified snapshot, -1 if none",
)
RECOVERY_READY = Gauge(
    "pomodoroxii_recovery_ready",
    "1 when recovery readiness holds (a verified snapshot exists), else 0",
)

API_UP = Gauge(
    "pomodoroxii_api_up",
    "1 when the API process is serving requests",
)
API_UP.set(1)


def record_recovery_operation(operation: str, outcome: str) -> None:
    """Record one recovery operation result (bounded labels only)."""
    RECOVERY_OPERATIONS.labels(operation=operation, outcome=outcome).inc()


# --------------------------------------------------------------------------- #
# Operations-token authentication
# --------------------------------------------------------------------------- #


async def require_operations_token(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer),
    db: AsyncSession = Depends(get_meta_db),
) -> OperationsPrincipal:
    """Require a valid operations credential (not a master/space JWT).

    Missing header -> 401; any other token (master, space, unknown) -> 403.
    The raw token is never logged, returned or persisted.
    """
    if credentials is None:
        raise AuthenticationError("Operations bearer token required")
    store = OperationsCredentialStore(db)
    return await store.verify(credentials.credentials)


# --------------------------------------------------------------------------- #
# Metrics endpoint
# --------------------------------------------------------------------------- #


def _update_recovery_gauges(signals: Any | None) -> None:
    """Map Task 3 snapshot state to bounded recovery gauges."""
    if signals is None:
        RECOVERY_LAST_SNAPSHOT_SECONDS.set(0)
        RECOVERY_BACKUP_AGE_SECONDS.set(-1)
        RECOVERY_READY.set(0)
        return
    last_success = getattr(signals, "last_snapshot_success", None)
    ready = bool(getattr(signals, "readiness", False))
    if not isinstance(last_success, str) or not last_success:
        RECOVERY_LAST_SNAPSHOT_SECONDS.set(0)
        RECOVERY_BACKUP_AGE_SECONDS.set(-1)
    else:
        try:
            parsed = datetime.fromisoformat(last_success.replace("Z", "+00:00"))
            epoch = parsed.timestamp()
        except ValueError:
            epoch = 0.0
        RECOVERY_LAST_SNAPSHOT_SECONDS.set(epoch)
        RECOVERY_BACKUP_AGE_SECONDS.set(
            max(-1.0, time.time() - epoch) if epoch else -1.0
        )
    RECOVERY_READY.set(1 if ready else 0)


@router.get(
    "/api/metrics",
    response_class=Response,
    responses={
        200: {
            "description": "Prometheus metrics",
            "content": {"text/plain": {"schema": {"type": "string"}}},
        },
        401: {"description": "Authentication required", "model": ErrorResponse},
        403: {"description": "Operations credential required", "model": ErrorResponse},
    },
)
async def metrics(
    request: Request,
    principal: OperationsPrincipal = Depends(require_operations_token),
) -> Response:
    """Expose bounded Prometheus metrics to authenticated operators."""
    signals = getattr(request.app.state, "operational_signals", None)
    _update_recovery_gauges(signals)
    content = generate_latest().decode("utf-8")
    return Response(content=content, media_type="text/plain; version=0.0.4")
