"""Thin contract router for Label definition CRUD (D5 Y).

Every write delegates to the TaskSpaceCommandModule via a LabelCommand; the
label definition is a sync-enabled entity, so each command compiles the
typed ``task_space.CreateLabel/UpdateLabel/ArchiveLabel`` request into a
generic ``label`` sync event inside one mutation command.
"""
from __future__ import annotations

from dataclasses import replace

from fastapi import APIRouter, Depends, Header

from app.deps import get_space_runtime_handle
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space import (
    ArchiveLabelRequest,
    CreateLabelRequest,
    LabelResponse,
    TaskSpaceAcceptedResponse,
    UpdateLabelRequest,
)
from app.task_space.contracts import (
    LabelCommand,
    TaskSpaceAccepted,
    TaskSpaceOutcome,
)

router = APIRouter()


def _space_id(scope) -> str:
    value = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(value, str) or not value:
        raise RuntimeError("authorized Space runtime handle is required")
    return value


def _label_response(value, space_id: str) -> LabelResponse:
    return LabelResponse(
        id=str(value["id"]),
        name=str(value["name"]),
        color=value["color"],
        archived_at=value["archived_at"],
        version=int(value["version"]),
        created_at=str(value["created_at"]),
        updated_at=str(value["updated_at"]),
    )


async def _map_label_outcome(
    outcome: TaskSpaceOutcome,
    scope,
    space_id: str,
) -> TaskSpaceAcceptedResponse:
    """Enrich a label accepted response with the full definition view."""
    if not isinstance(outcome, TaskSpaceAccepted) or outcome.entity_type != "label":
        return map_task_space_outcome(outcome)
    value = _label_response(outcome.value, space_id).model_dump(by_alias=True)
    return map_task_space_outcome(replace(outcome, value=value))


def _command(
    *, operation: str, command_id: str, space_id: str, label_id: str | None,
    expected_version: int | None, payload_hash: str, payload: dict[str, object],
) -> LabelCommand:
    return LabelCommand(
        operation=operation,
        command_id=command_id,
        space_id=space_id,
        label_id=label_id,
        expected_version=expected_version,
        payload_hash=payload_hash,
        payload=payload,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_label(
    body: CreateLabelRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Create a label definition."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="create",
        command_id=body.command_id,
        space_id=body.space_id,
        label_id=None,
        expected_version=None,
        payload_hash=body.payload_hash,
        payload={"name": body.name, "color": body.color},
    )
    outcome = await command_module.execute(scope, command)
    return await _map_label_outcome(outcome, scope, _space_id(scope))


@router.patch("/{label_id}", response_model=TaskSpaceAcceptedResponse)
async def update_label(
    label_id: str,
    body: UpdateLabelRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Update mutable fields of a label definition."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    payload: dict[str, object] = {}
    for field_name in ("name", "color"):
        if field_name in body.model_fields_set:
            payload[field_name] = getattr(body, field_name)
    command = _command(
        operation="update",
        command_id=body.command_id,
        space_id=body.space_id,
        label_id=label_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload=payload,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_label_outcome(outcome, scope, _space_id(scope))


@router.delete("/{label_id}", response_model=TaskSpaceAcceptedResponse)
async def archive_label(
    label_id: str,
    body: ArchiveLabelRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Archive (soft-delete) a label definition via a DELETE command body.

    A DELETE carrying a command envelope is intentionally used so removals
    get the same idempotency + CAS + payload-hash guarantees as every other
    Task Space mutation.
    """
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="archive",
        command_id=body.command_id,
        space_id=body.space_id,
        label_id=label_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={},
    )
    outcome = await command_module.execute(scope, command)
    return await _map_label_outcome(outcome, scope, _space_id(scope))
