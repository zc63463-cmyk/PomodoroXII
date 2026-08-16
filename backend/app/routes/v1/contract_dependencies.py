"""Typed module providers and shared Task Space adapter guards."""
from __future__ import annotations

import logging
import sys
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from fastapi import Depends, HTTPException, Request

from app.deps import get_mutation_uow, require_master_token
from app.errors import AppError, IdempotencyConflictError, ValidationError, to_wire_json
from app.mutation.types import validate_operation_id
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.task_space import TaskSpaceAcceptedResponse
from app.task_space.contracts import TaskSpaceAccepted, TaskSpaceRejected
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule

if TYPE_CHECKING:
    from app.focus_session.contracts import (
        ActiveSessionCoordinator,
        FocusSessionModule,
    )
    from app.task_space.contracts import (
        TaskSpaceCommandModule,
        TaskSpaceQueryModule,
    )

logger = logging.getLogger(__name__)


def get_task_space_query_module() -> "TaskSpaceQueryModule":
    """Return the concrete read-only Task Space provider."""
    return DefaultTaskSpaceQueryModule()


def get_task_space_command_module(
    uow=Depends(get_mutation_uow),
) -> "TaskSpaceCommandModule":
    """Bind the concrete Task Space command provider to the shared UoW."""
    return DefaultTaskSpaceCommandModule(uow)


def get_focus_session_module(
    uow=Depends(get_mutation_uow),
) -> "FocusSessionModule":
    """Build the FocusSession adapter over the shared S3 UoW."""
    from app.focus_session.command_reconciler import (
        S3ReceiptWriter,
        S3StoredTaskCommandLookup,
        SessionCommandReconciler,
    )
    from app.focus_session.module import DefaultFocusSessionModule
    from app.focus_session.query import FocusSessionQuery

    query = FocusSessionQuery()
    task_space = DefaultTaskSpaceCommandModule(uow)
    reconciler = SessionCommandReconciler(
        task_space,
        S3StoredTaskCommandLookup(),
        S3ReceiptWriter(uow),
        query,
    )
    return DefaultFocusSessionModule(uow=uow, query=query, reconciler=reconciler)


async def get_active_session_coordinator(
    request: Request,
    claims=Depends(require_master_token),
    uow=Depends(get_mutation_uow),
) -> AsyncIterator["ActiveSessionCoordinator"]:
    """Construct the production ActiveSessionCoordinator over the real Meta
    session factory, the real MutationUnitOfWork and real Space handles.

    The ActiveSession contract is master-scoped: this provider depends only on
    the master principal, the Meta authority, the runtime and the UoW — it
    never requires a Space token.  Space identity is resolved by the
    coordinator from payload / Meta locator / persisted pair, and each Space
    handle is opened through the *master-authorized* internal opener
    (``RuntimeServices.scope``), which validates registration, deletion and
    path containment via the Meta registry — never by splicing filesystem
    paths.  This does not widen public HTTP permissions: the opener is only
    reachable through the master-only ActiveSession routes.

    Request-scoped handle manager:
      - first use of a Space opens and verifies it, then reuses the handle;
      - multiple Spaces open in stable Space-ID order;
      - every handle is closed in ``finally`` on *all* exit paths (success,
        child failure, cancellation, provider exception);
      - the request-level global lease is released when each owning handle is
        closed (space lease first, then global lease);
      - handles are never cached across requests.

    Cleanup discipline: every handle is attempted even if one fails; failures
    are collected; they never mask a primary business exception and propagate
    as a stable error only when no primary exception is in flight.
    """
    from app.db.meta_session import get_meta_session_factory
    from app.focus_session.coordinator import (
        ProductionActiveSessionCoordinator,
    )
    from app.focus_session.query import FocusSessionQuery

    meta_factory = get_meta_session_factory()
    if meta_factory is None:
        raise RuntimeError("Meta session factory is not installed")
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None:
        raise RuntimeError("SpaceRuntime is not installed")
    if uow is None:
        raise RuntimeError("MutationUnitOfWork is not installed")

    from app.runtime.leases import LeaseMode
    from app.runtime.scope import AuthorizedSpaceScope
    from app.settings import settings

    principal = _master_principal(claims)
    opened: dict[str, SpaceRuntimeHandle] = {}

    # One request-level global lease; every Space handle is opened under it
    # (owns_global_lease=False) so the runtime's lease-order contract holds:
    # global first, Space leases after, global released last.
    global_lease = await runtime.leases.acquire_global(
        LeaseMode.SHARED, "active-session", 5
    )

    async def space_handle_provider(space_id: str) -> SpaceRuntimeHandle:
        existing = opened.get(space_id)
        if existing is not None:
            return existing
        # Master-authorized internal opener: validates the Space is registered
        # / not deleted / paths contained via the Meta registry (never by
        # splicing filesystem paths), then opens the mutation handle under the
        # request-level global lease.
        async with meta_factory() as session:
            master_scope = AuthorizedSpaceScope(
                session, settings.canonical_spaces_root, runtime
            )
            resolved = await master_scope.resolve(principal, space_id, "write")
        handle = await runtime.open_resolved(
            resolved, "mutation", global_lease, owns_global_lease=False
        )
        opened[space_id] = handle
        return handle

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=meta_factory,
        uow=uow,
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
    )
    try:
        yield coordinator
    finally:
        # Space handles first, then the request-level global lease LAST.
        try:
            await _close_opened_handles(opened)
        finally:
            await global_lease.release()


def _master_principal(claims: Any):
    from app.auth.authority import Principal

    if isinstance(claims, Principal):
        return claims
    return Principal(
        subject=str(claims["sub"]),
        token_type="master",
        epoch=int(claims.get("epoch", 0)),
        expires_at=claims.get("exp") if isinstance(claims.get("exp"), int) else None,
    )


async def _close_opened_handles(opened: dict[str, SpaceRuntimeHandle]) -> None:
    """Close every opened handle; never mask the in-flight exception.

    - every handle is attempted even if one close fails;
    - failures are collected; if no primary exception is propagating they are
      raised as a stable ActiveSessionCoordinationError; otherwise they are
      logged as exception notes without silencing them.
    """
    failures: list[BaseException] = []
    for space_id in sorted(opened):
        handle = opened[space_id]
        # Close on the *same* asyncio Task that opened the handle: wrapping in
        # asyncio.shield() would run aclose in a fresh Task and trip the
        # runtime's lease Task-ownership check.  Under cancellation the
        # generator's finally still runs this await; a CancelledError from
        # aclose is collected like any other cleanup failure.
        try:
            await handle.aclose()
        except BaseException as exc:  # noqa: BLE001 - cleanup must not mask others
            failures.append(exc)
    if not failures:
        return
    primary = sys.exc_info()
    # GeneratorExit is the normal async-generator close signal (provider.aclose);
    # it is not a real business exception to preserve — propagate the cleanup
    # failure instead.  A genuine in-flight business exception / cancellation
    # is preserved and cleanup failures are logged, never raised over it.
    if primary[0] is None or primary[0] is GeneratorExit:
        from app.focus_session.coordinator import ActiveSessionCoordinationError

        detail = ", ".join(
            f"{space_id}:{type(exc).__name__}"
            for space_id, exc in zip(sorted(opened), failures, strict=False)
        )
        raise ActiveSessionCoordinationError(
            f"Space handle cleanup failed: {detail}"
        ) from failures[0]
    for failure in failures:
        logger.warning(
            "ActiveSession handle cleanup failure (primary exception "
            "preserved): %s: %s",
            type(failure).__name__,
            failure,
        )

def require_idempotency_key(command_id: str, header_value: str | None) -> None:
    """Validate an optional wire idempotency key and bind it to the body ID."""
    if header_value is None:
        return
    try:
        validate_operation_id(header_value)
    except ValueError as exc:
        raise ValidationError("Idempotency-Key is not a valid operation ID") from exc
    if header_value != command_id:
        raise IdempotencyConflictError(operation_id=command_id)


def require_space_identity(scope: Any, body_space_id: str) -> None:
    """Reject a body Space that differs from the authorized runtime handle."""
    scope_space_id = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(scope_space_id, str):
        raise RuntimeError("authorized Space runtime handle is required")
    if body_space_id != scope_space_id:
        raise AppError(
            code="space_scope_mismatch",
            details={
                "scopeSpaceId": scope_space_id,
                "payloadSpaceId": body_space_id,
            },
        )


def require_path_identity(path_id: str, body_id: str, entity: str) -> None:
    """Reject conflicting path/body identities before a module is called."""
    if path_id != body_id:
        raise ValidationError(f"{entity} identity does not match the route")


def map_task_space_outcome(
    outcome: TaskSpaceAccepted | TaskSpaceRejected,
) -> TaskSpaceAcceptedResponse:
    """Map the closed Task Space outcome union at the REST boundary."""
    if isinstance(outcome, TaskSpaceAccepted):
        return TaskSpaceAcceptedResponse(
            command_id=outcome.command_id,
            entity_type=outcome.entity_type,
            entity_id=outcome.entity_id,
            version=outcome.version,
            value=to_wire_json(outcome.value),
        )
    raise HTTPException(
        status_code=409,
        detail={
            "code": outcome.code,
            "retryable": outcome.retryable,
            "details": to_wire_json(outcome.details),
        },
    )
