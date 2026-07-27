"""Thin contract router for WorkItem CRUD and lifecycle actions.

Static action routes (move, transition) are declared before the
plain ``/{work_item_id}`` mutation route so they are never captured
as a path parameter.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, Query

from app.deps import get_space_runtime_handle
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space import (
    CreateWorkItemRequest,
    MoveWorkItemRequest,
    TaskSpaceAcceptedResponse,
    TaskSpacePageResponse,
    TaskSpaceViewResponse,
    TransitionWorkItemRequest,
    UpdateWorkItemRequest,
)
from app.task_space.contracts import (
    CreateWorkItem,
    MutateWorkItem,
    TaskSpacePageQuery,
)

router = APIRouter()


# --------------------------------------------------------------------------- #
# Collection routes
# --------------------------------------------------------------------------- #


@router.get("", response_model=TaskSpacePageResponse)
async def list_work_items(
    project_id: str | None = Query(default=None, alias="projectId"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpacePageResponse:
    """List work items with optional project filter and pagination."""
    filters: dict[str, Any] = {}
    if project_id is not None:
        filters["project_id"] = project_id
    page = await query_module.list_work_items(
        scope,
        TaskSpacePageQuery(cursor=cursor, limit=limit, filters=filters),
    )
    return TaskSpacePageResponse(
        items=[dict(item) for item in page.items],
        next_cursor=page.next_cursor,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_work_item(
    body: CreateWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Create a work item via the TaskSpace command module."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = CreateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        project_id=body.project_id,
        title=body.title,
        description=body.description,
        parent_id=body.parent_id,
        type_definition_id=body.type_definition_id,
        status_definition_id=body.status_definition_id,
        priority=body.priority,
        payload_hash=body.payload_hash,
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


# --------------------------------------------------------------------------- #
# Static action routes — MUST be declared before /{work_item_id}
# --------------------------------------------------------------------------- #


@router.post("/{work_item_id}/move", response_model=TaskSpaceAcceptedResponse)
async def move_work_item(
    work_item_id: str,
    body: MoveWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Move a work item to a new parent."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={"parent_id": body.parent_id},
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


@router.post(
    "/{work_item_id}/transition", response_model=TaskSpaceAcceptedResponse
)
async def transition_work_item(
    work_item_id: str,
    body: TransitionWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Transition a work item to a new status."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={"status_definition_id": body.status_definition_id},
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


# --------------------------------------------------------------------------- #
# Plain mutation routes — declared after all static action routes
# --------------------------------------------------------------------------- #


@router.patch("/{work_item_id}", response_model=TaskSpaceAcceptedResponse)
async def update_work_item(
    work_item_id: str,
    body: UpdateWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Update mutable fields of a work item."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    payload: dict[str, Any] = {}
    if body.title is not None:
        payload["title"] = body.title
    if body.description is not None:
        payload["description"] = body.description
    if body.priority is not None:
        payload["priority"] = body.priority
    if body.type_definition_id is not None:
        payload["type_definition_id"] = body.type_definition_id
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload=payload,
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


@router.get("/{work_item_id}", response_model=TaskSpaceViewResponse)
async def get_work_item(
    work_item_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceViewResponse:
    """Get a single work item by ID."""
    view = await query_module.get_work_item(scope, work_item_id)
    return TaskSpaceViewResponse(value=dict(view.value))
