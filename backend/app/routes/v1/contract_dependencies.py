"""Typed module providers and shared Task Space adapter guards."""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from fastapi import Depends, HTTPException, Request

from app.deps import get_mutation_uow, get_space_runtime_handle
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
    uow=Depends(get_mutation_uow),
    handle: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
) -> AsyncIterator["ActiveSessionCoordinator"]:
    """Construct the production ActiveSessionCoordinator over the real Meta
    session factory, the real MutationUnitOfWork and real Space handles.

    Every cross-space handle opened through the runtime is owned by this
    request-scoped provider and closed on *all* exit paths (success, child
    failure, cancellation, provider exception).  The primary request handle is
    owned and closed by ``get_space_runtime_handle`` and is never closed here
    twice.  Construction failures are never swallowed: a missing Meta factory,
    UoW or runtime surfaces as a dependency error instead of a silent
    fallback.
    """
    from app.db.meta_session import get_meta_session_factory
    from app.focus_session.coordinator import (
        ActiveSessionCoordinationError,
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

    opened: list[SpaceRuntimeHandle] = []

    async def space_handle_provider(space_id: str) -> SpaceRuntimeHandle:
        if str(getattr(handle.scope, "space_id", "")) == space_id:
            return handle
        # A conflict pair spans two Spaces: open the other Space's handle
        # through the runtime under the request's global lease so the UoW can
        # execute the second Space's child, exactly like the primary Space.
        try:
            other = await runtime.open_resolved(
                await runtime.resolve_scope(space_id),
                "mutation",
                handle.global_lease,
                owns_global_lease=False,
            )
        except Exception as exc:
            raise ActiveSessionCoordinationError(
                f"cannot open Space handle for {space_id!r}: {type(exc).__name__}"
            ) from exc
        opened.append(other)
        return other

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=meta_factory,
        uow=uow,
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
    )
    try:
        yield coordinator
    finally:
        # Close every cross-space handle this request opened; the primary
        # handle is closed by get_space_runtime_handle's own finally block.
        for opened_handle in opened:
            try:
                await opened_handle.aclose()
            except Exception:
                pass
        opened.clear()


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
