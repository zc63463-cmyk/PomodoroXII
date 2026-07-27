"""Thin contract router for Project definitions and CRUD.

Delegates every request to the injected TaskSpaceQueryModule or
TaskSpaceCommandModule.  The router is intentionally not mounted in
the production v1 app during TS0; TS1/TS2 mount it after replacing
the provider dependencies.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.routes.v1.contract_dependencies import (
    get_contract_space_runtime,
    get_task_space_command_module,
    get_task_space_query_module,
)
from app.schemas.task_space import (
    CreateProjectRequest,
    TaskSpaceAcceptedResponse,
    TaskSpaceDefinitionsResponse,
    TaskSpacePageResponse,
    TaskSpaceViewResponse,
)
from app.task_space.contracts import (
    CreateProject,
    TaskSpaceAccepted,
    TaskSpacePageQuery,
    TaskSpaceRejected,
)

router = APIRouter()


def _map_accepted(outcome: Any) -> TaskSpaceAcceptedResponse:
    if isinstance(outcome, TaskSpaceAccepted):
        return TaskSpaceAcceptedResponse(
            command_id=outcome.command_id,
            entity_type=outcome.entity_type,
            entity_id=outcome.entity_id,
            version=outcome.version,
            value=dict(outcome.value),
        )
    # TaskSpaceRejected — surface as 409 conflict
    rejected: TaskSpaceRejected = outcome

    raise HTTPException(
        status_code=409,
        detail={
            "code": rejected.code,
            "retryable": rejected.retryable,
            "details": dict(rejected.details),
        },
    )


# --------------------------------------------------------------------------- #
# Collection routes
# --------------------------------------------------------------------------- #


@router.get("", response_model=TaskSpacePageResponse)
async def list_projects(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpacePageResponse:
    """List projects with optional pagination."""
    page = await query_module.list_projects(
        scope,
        TaskSpacePageQuery(cursor=cursor, limit=limit, filters={}),
    )
    return TaskSpacePageResponse(
        items=[dict(item) for item in page.items],
        next_cursor=page.next_cursor,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_project(
    body: CreateProjectRequest,
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpaceAcceptedResponse:
    """Create a project via the TaskSpace command module."""
    command = CreateProject(
        command_id=body.command_id,
        space_id=body.space_id,
        payload_hash=body.payload_hash,
        payload={"key": body.key, "name": body.name},
    )
    outcome = await command_module.execute(scope, command)
    return _map_accepted(outcome)


# --------------------------------------------------------------------------- #
# Static route — MUST be declared before /{project_id}
# --------------------------------------------------------------------------- #


@router.get("/definitions", response_model=TaskSpaceDefinitionsResponse)
async def list_definitions(
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_contract_space_runtime),
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


@router.get("/{project_id}", response_model=TaskSpaceViewResponse)
async def get_project(
    project_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpaceViewResponse:
    """Get a single project by ID."""
    view = await query_module.get_project(scope, project_id)
    return TaskSpaceViewResponse(value=dict(view.value))
