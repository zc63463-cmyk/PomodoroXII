"""Typed module providers and shared Task Space adapter guards."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import Depends, HTTPException

from app.deps import get_mutation_uow
from app.errors import AppError, IdempotencyConflictError, ValidationError, to_wire_json
from app.mutation.types import validate_operation_id
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


def get_active_session_coordinator() -> "ActiveSessionCoordinator":
    """Return the installed ActiveSessionCoordinator or fail closed."""
    raise RuntimeError("ActiveSessionCoordinator provider is not installed")


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
