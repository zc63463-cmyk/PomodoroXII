"""Thin contract router for WorkItem CRUD and lifecycle actions.

Static action routes (move, transition) are declared before the
plain ``/{work_item_id}`` mutation route so they are never captured
as a path parameter.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import select

from app.deps import get_space_runtime_handle
from app.models.work_item import WorkItem
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space import (
    AddWorkItemLabelsRequest,
    CreateWorkItemRequest,
    MoveWorkItemRequest,
    RemoveWorkItemLabelsRequest,
    TaskSpaceAcceptedResponse,
    TransitionWorkItemRequest,
    UpdateWorkItemRequest,
    WorkItemPageResponse,
    WorkItemResponse,
)
from app.task_space.contracts import (
    CreateWorkItem,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpaceOutcome,
    TaskSpacePageQuery,
)

router = APIRouter()


def _space_id(scope) -> str:
    value = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(value, str) or not value:
        raise RuntimeError("authorized Space runtime handle is required")
    return value


async def _work_item_depths(scope, items: tuple[Mapping[str, object], ...]) -> dict[str, int]:
    """Resolve read-only tree depth from authoritative ORM parent rows."""
    depths = {
        str(value["id"]): int(value["depth"])
        for value in items
        if "depth" in value
    }
    missing = [value for value in items if str(value["id"]) not in depths]
    if not missing:
        return depths
    session_factory = getattr(scope, "session_factory", None)
    if not callable(session_factory):
        raise RuntimeError("authoritative WorkItem rows are required for depth")
    async with session_factory() as session:
        rows = tuple((await session.execute(select(WorkItem))).scalars())
    by_id = {str(row.id): row for row in rows}
    for value in missing:
        current = value
        depth = 1
        visited = {str(value["id"])}
        while (
            current["parent_id"]
            if isinstance(current, Mapping)
            else getattr(current, "parent_id", None)
        ) is not None:
            parent_value = (
                current["parent_id"]
                if isinstance(current, Mapping)
                else current.parent_id
            )
            parent_id = str(parent_value)
            if parent_id in visited or parent_id not in by_id:
                raise RuntimeError("invalid_work_item_tree")
            parent = by_id[parent_id]
            current_project = (
                current["project_id"]
                if isinstance(current, Mapping)
                else getattr(current, "project_id", None)
            )
            if str(parent.project_id) != str(current_project):
                raise RuntimeError("invalid_work_item_tree")
            visited.add(parent_id)
            depth += 1
            current = parent
        if depth not in (1, 2, 3):
            raise RuntimeError("invalid_work_item_tree")
        depths[str(value["id"])] = depth
    return depths


def _work_item_response(value, space_id: str, depth: int) -> WorkItemResponse:
    """Map a complete snake_case query row to the wire response."""
    return WorkItemResponse(
        id=str(value["id"]),
        space_id=space_id,
        display_key=str(value["display_key"]),
        project_id=str(value["project_id"]),
        title=str(value["title"]),
        description=value["description"],
        type_definition_id=str(value["type_definition_id"]),
        status_definition_id=str(value["status_definition_id"]),
        priority=value["priority"],
        parent_id=value["parent_id"],
        child_rank=int(value["child_rank"]),
        depth=depth,
        completion_window_start=value["completion_window_start"],
        completion_window_end=value["completion_window_end"],
        review_point=value["review_point"],
        hard_deadline=value["hard_deadline"],
        effort_estimate_lower_seconds=value["effort_estimate_lower_seconds"],
        effort_estimate_upper_seconds=value["effort_estimate_upper_seconds"],
        effort_actual_seconds=int(value["effort_actual_seconds"]),
        confidence=value["confidence"],
        completed_at=value["completed_at"],
        cancelled_at=value["cancelled_at"],
        archived_at=value["archived_at"],
        marked_as_attention=bool(value["marked_as_attention"]),
        label_ids=sorted(str(item) for item in value.get("label_ids", [])),
        version=int(value["version"]),
        created_at=str(value["created_at"]),
        updated_at=str(value["updated_at"]),
    )


async def _map_work_item_outcome(
    outcome: TaskSpaceOutcome,
    scope,
    query_module,
) -> TaskSpaceAcceptedResponse:
    """Return a complete authoritative WorkItem accepted post-image.

    The compiler's value is the domain post-image and intentionally contains
    no derived ``depth`` column.  REST accepted responses must nevertheless
    satisfy the same complete WorkItem contract as reads, so enrich only the
    response value from the committed query projection.
    """
    if not isinstance(outcome, TaskSpaceAccepted) or outcome.entity_type != "work_item":
        return map_task_space_outcome(outcome)
    view = await query_module.get_work_item(scope, outcome.entity_id)
    depths = await _work_item_depths(scope, (view.value,))
    value = _work_item_response(
        view.value,
        _space_id(scope),
        depths[str(outcome.entity_id)],
    ).model_dump(by_alias=True)
    return map_task_space_outcome(replace(outcome, value=value))


# --------------------------------------------------------------------------- #
# Collection routes
# --------------------------------------------------------------------------- #


@router.get("", response_model=WorkItemPageResponse)
async def list_work_items(
    project_id: str | None = Query(default=None, alias="projectId"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> WorkItemPageResponse:
    """List work items with optional project filter and pagination."""
    filters: dict[str, Any] = {}
    if project_id is not None:
        filters["project_id"] = project_id
    page = await query_module.list_work_items(
        scope,
        TaskSpacePageQuery(cursor=cursor, limit=limit, filters=filters),
    )
    space_id = _space_id(scope)
    depths = await _work_item_depths(scope, page.items)
    return WorkItemPageResponse(
        items=[
            _work_item_response(item, space_id, depths[str(item["id"])])
            for item in page.items
        ],
        next_cursor=page.next_cursor,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_work_item(
    body: CreateWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
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
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# Static action routes — MUST be declared before /{work_item_id}
# --------------------------------------------------------------------------- #


@router.post("/{work_item_id}/move", response_model=TaskSpaceAcceptedResponse)
async def move_work_item(
    work_item_id: str,
    body: MoveWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
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
        # child_rank is deliberately absent: the online Move API never accepts
        # a client-supplied rank.  The server assigns the authoritative
        # max(existing ranks, -1) + 1 within the same transaction.
        payload={
            "operation": "move",
            "project_id": body.project_id,
            "new_parent_id": body.parent_id,
        },
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.post(
    "/{work_item_id}/transition", response_model=TaskSpaceAcceptedResponse
)
async def transition_work_item(
    work_item_id: str,
    body: TransitionWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
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
        payload={
            "operation": "transition",
            "status_definition_id": body.status_definition_id,
        },
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# D5 Y label junction routes — MUST be declared before /{work_item_id}
# --------------------------------------------------------------------------- #


def _labels_command(
    *,
    operation: str,
    command_id: str,
    space_id: str,
    work_item_id: str,
    expected_version: int,
    payload_hash: str,
    label_ids: list[str],
) -> MutateWorkItem:
    business = {"label_ids": sorted(label_ids)}
    return MutateWorkItem(
        command_id=command_id,
        space_id=space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=payload_hash,
        payload={"operation": operation, **business},
    )


@router.post("/{work_item_id}/labels", response_model=TaskSpaceAcceptedResponse)
async def add_work_item_labels(
    work_item_id: str,
    body: AddWorkItemLabelsRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Converge the work item's label set to the declared full target set."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _labels_command(
        operation="add_labels",
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        label_ids=body.label_ids,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.delete(
    "/{work_item_id}/labels/{label_id}", response_model=TaskSpaceAcceptedResponse
)
async def remove_work_item_label(
    work_item_id: str,
    label_id: str,
    body: RemoveWorkItemLabelsRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Remove one label by declaring the post-removal full target set."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _labels_command(
        operation="remove_labels",
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        label_ids=body.label_ids,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# Plain mutation routes — declared after all static action routes
# --------------------------------------------------------------------------- #


@router.patch("/{work_item_id}", response_model=TaskSpaceAcceptedResponse)
async def update_work_item(
    work_item_id: str,
    body: UpdateWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Update mutable fields of a work item."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    # The business payload is a nested ``patch`` object that mirrors the
    # compiler contract (``_compile_UpdateWorkItem`` reads payload["patch"]).
    # Only fields the caller explicitly provided appear in the patch, so an
    # explicit ``description: null`` clears the field while an omitted field
    # is left untouched -- matching the frontend canonical hash input.
    patch: dict[str, Any] = {}
    for field_name in ("title", "description", "priority", "type_definition_id"):
        if field_name in body.model_fields_set:
            patch[field_name] = getattr(body, field_name)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={"operation": "update", "patch": patch},
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.get("/{work_item_id}", response_model=WorkItemResponse)
async def get_work_item(
    work_item_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> WorkItemResponse:
    """Get a single work item by ID."""
    view = await query_module.get_work_item(scope, work_item_id)
    value = view.value
    depths = await _work_item_depths(scope, (value,))
    return _work_item_response(value, _space_id(scope), depths[str(value["id"])])
