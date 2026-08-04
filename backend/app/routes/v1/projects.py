"""Thin contract router for Project definitions and CRUD.

Delegates every request to the injected TaskSpaceQueryModule or
TaskSpaceCommandModule.  The router is intentionally not mounted in
the production v1 app during TS0; TS1/TS2 mount it after replacing
the provider dependencies.
"""
from __future__ import annotations

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
    CreateProjectRequest,
    ProjectPageResponse,
    ProjectResponse,
    TaskSpaceAcceptedResponse,
    TaskSpaceDefinitionsResponse,
)
from app.task_space.contracts import (
    CreateProject,
    TaskSpacePageQuery,
)

router = APIRouter()


def _space_id(scope) -> str:
    value = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(value, str) or not value:
        raise RuntimeError("authorized Space runtime handle is required")
    return value


def _project_response(value, space_id: str) -> ProjectResponse:
    """Map a complete snake_case query row to the wire response."""
    return ProjectResponse(
        id=str(value["id"]),
        space_id=space_id,
        key=str(value["key"]),
        name=str(value["name"]),
        description=value["description"],
        next_work_item_number=int(value["next_work_item_number"]),
        rank=int(value["rank"]),
        archived_at=value["archived_at"],
        version=int(value["version"]),
        created_at=str(value["created_at"]),
        updated_at=str(value["updated_at"]),
    )


# --------------------------------------------------------------------------- #
# Collection routes
# --------------------------------------------------------------------------- #


@router.get("", response_model=ProjectPageResponse)
async def list_projects(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> ProjectPageResponse:
    """List projects with optional pagination."""
    page = await query_module.list_projects(
        scope,
        TaskSpacePageQuery(cursor=cursor, limit=limit, filters={}),
    )
    space_id = _space_id(scope)
    return ProjectPageResponse(
        items=[_project_response(item, space_id) for item in page.items],
        next_cursor=page.next_cursor,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_project(
    body: CreateProjectRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Create a project via the TaskSpace command module."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = CreateProject(
        command_id=body.command_id,
        space_id=body.space_id,
        payload_hash=body.payload_hash,
        payload={"key": body.key, "name": body.name},
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


# --------------------------------------------------------------------------- #
# Static route — MUST be declared before /{project_id}
# --------------------------------------------------------------------------- #


@router.get("/definitions", response_model=TaskSpaceDefinitionsResponse)
async def list_definitions(
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceDefinitionsResponse:
    """List system status, type, and label definitions."""
    view = await query_module.list_definitions(scope)
    return TaskSpaceDefinitionsResponse(
        statuses=[dict(s) for s in view.statuses],
        types=[dict(t) for t in view.types],
        labels=[dict(lbl) for lbl in view.labels],
    )


# --------------------------------------------------------------------------- #
# Parameter route — declared after all static routes
# --------------------------------------------------------------------------- #


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> ProjectResponse:
    """Get a single project by ID."""
    view = await query_module.get_project(scope, project_id)
    return _project_response(view.value, _space_id(scope))
