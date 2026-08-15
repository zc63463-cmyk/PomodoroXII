"""Operational endpoints: metrics and credential-gated observability.

``/api/metrics`` is the only Prometheus scrape endpoint.  It is protected by
the digest-only operations credential (``OperationsCredentialStore``); master
and space JWTs are rejected.  All metric labels are low-cardinality:
HTTP observations use only ``method``/``route``/``status_class`` and recovery
observations use only ``operation``/``outcome``.  Identity values (space ids,
entity ids, request ids), raw paths and tokens are never label values.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from prometheus_client import Counter, Gauge, Histogram, generate_latest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal
from app.deps import get_meta_db
from app.errors import AuthenticationError
from app.ops.credentials import OperationsCredentialStore, OperationsPrincipal
from app.runtime.scope import AuthorizedSpaceScope
from app.runtime.sqlite_vfs import MaintenanceOptions
from app.schemas.common import ErrorResponse

router = APIRouter()
logger = logging.getLogger("pomodoroxi.ops.metrics")

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
_RECOVERY_OPERATION_LABELS = frozenset(
    {"snapshot", "verify", "restore", "cutover", "relocate"}
)
_RECOVERY_OUTCOME_LABELS = frozenset({"success", "failure", "timeout"})
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
PENDING_MUTATIONS = Gauge(
    "pomodoroxii_pending_mutations",
    "Nonterminal durable mutation batches across registered Spaces",
)
PENDING_MUTATION_OLDEST_AGE_SECONDS = Gauge(
    "pomodoroxii_pending_mutation_oldest_age_seconds",
    "Age in seconds of the oldest nonterminal mutation batch, 0 if none",
)
SYNC_LAG_EVENTS = Gauge(
    "pomodoroxii_sync_lag_events",
    "Visible sync events above the minimum active client ACK",
)
DEGRADED_SPACES = Gauge(
    "pomodoroxii_degraded_spaces",
    "Registered Spaces whose read-only health or metric probe is unavailable",
)

API_UP = Gauge(
    "pomodoroxii_api_up",
    "1 when the API process is serving requests",
)
API_UP.set(1)


def record_recovery_operation(operation: str, outcome: str) -> None:
    """Record one recovery operation result (bounded labels only)."""
    if (
        operation not in _RECOVERY_OPERATION_LABELS
        or outcome not in _RECOVERY_OUTCOME_LABELS
    ):
        raise ValueError("unsupported recovery metric label")
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


async def _update_fleet_gauges(
    request: Request, principal: OperationsPrincipal
) -> None:
    """Collect fleet-wide values through registry-bound read-only authorities."""
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None:
        PENDING_MUTATIONS.set(0)
        SYNC_LAG_EVENTS.set(0)
        DEGRADED_SPACES.set(0)
        return

    from app.db.meta_session import get_meta_session_factory
    from app.db.models.meta import Space
    from app.settings import settings

    factory = get_meta_session_factory()
    async with factory() as db:
        rows = (await db.execute(select(Space).order_by(Space.id))).scalars().all()
        trusted = Principal(
            subject="operations-metrics",
            token_type="trusted_stdio",
            epoch=principal.epoch,
            expires_at=None,
        )
        scope_authority = AuthorizedSpaceScope(
            db, settings.canonical_spaces_root, runtime
        )
        pending_mutations = 0
        oldest_pending_epoch: float | None = None
        sync_lag_events = 0
        degraded_spaces = 0
        for row in rows:
            try:
                scope = await scope_authority.resolve(trusted, row.id, "read")
                health = await runtime.health(scope)
                if not health.available:
                    degraded_spaces += 1
                    continue
                async with scope.containment.open_verified() as opens:
                    with opens.database_target.open_maintenance(
                        MaintenanceOptions(read_only=True)
                    ) as connection:
                        pending_row = connection.execute(
                            "SELECT COUNT(*),MIN(updated_at) FROM mutation_batches "
                            "WHERE state NOT IN ('FINALIZED','ABORTED','COMPENSATED')"
                        ).fetchone()
                        local_pending = int(pending_row[0])
                        local_oldest_epoch = None
                        if pending_row[1] is not None:
                            local_oldest_epoch = datetime.fromisoformat(
                                str(pending_row[1]).replace("Z", "+00:00")
                            ).timestamp()
                        pending_mutations += local_pending
                        if local_oldest_epoch is not None:
                            oldest_pending_epoch = (
                                local_oldest_epoch
                                if oldest_pending_epoch is None
                                else min(oldest_pending_epoch, local_oldest_epoch)
                            )
                        minimum_ack = connection.execute(
                            "SELECT MIN(ack_sequence) FROM sync_clients "
                            "WHERE requires_recovery=0"
                        ).fetchone()[0]
                        if minimum_ack is not None:
                            sync_lag_events += int(
                                connection.execute(
                                    "SELECT COUNT(*) FROM sync_outbox "
                                    "WHERE visible=1 AND id>?",
                                    (int(minimum_ack),),
                                ).fetchone()[0]
                            )
            except Exception as exc:  # one unavailable Space must not hide fleet metrics
                degraded_spaces += 1
                logger.warning(
                    "Space metrics probe failed (error_type=%s)", type(exc).__name__
                )

    PENDING_MUTATIONS.set(pending_mutations)
    PENDING_MUTATION_OLDEST_AGE_SECONDS.set(
        max(0.0, time.time() - oldest_pending_epoch)
        if oldest_pending_epoch is not None
        else 0.0
    )
    SYNC_LAG_EVENTS.set(sync_lag_events)
    DEGRADED_SPACES.set(degraded_spaces)


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
    await _update_fleet_gauges(request, principal)
    content = generate_latest().decode("utf-8")
    return Response(content=content, media_type="text/plain; version=0.0.4")
