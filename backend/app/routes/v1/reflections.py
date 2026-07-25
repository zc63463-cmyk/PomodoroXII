"""REST routes for daily reflections.

CRUD endpoints for the Reflection entity.  Uses an inline
``ReflectionService(BaseService)`` subclass that serialises JSON-array
fields (``related_task_ids``, ``tags``, ``sections``,
``auto_linked_session_ids``) and the boolean ``is_structured`` (stored as
the string ``"true"``/``"false"``) before persisting.  Listings are
ordered by date descending and may be filtered by date.
Writes use the durable mutation UoW; read-only endpoints use the query service.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import (
    entity_id_for_operation,
    expected_version_from_request,
    get_knowledge_store,
    get_operation_id,
    get_space_context,
    get_space_db,
    get_space_runtime_handle,
)
from app.errors import NotFoundError
from app.models.reflection import Reflection
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.reflection import (
    ReflectionCreate,
    ReflectionResponse,
    ReflectionUpdate,
)
from app.services.reflection import ReflectionService

router = APIRouter()


@router.post("", response_model=ReflectionResponse, status_code=201)
async def create_reflection(
    data: ReflectionCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a new daily reflection."""
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "reflection")
    for field in ("related_task_ids", "tags", "sections", "auto_linked_session_ids"):
        payload[field] = json.dumps(payload.get(field, []))
    result = await store.uow.execute(
        scope, store.entity_commands.create(scope, "reflection", payload, None), operation_id
    )
    return dict(result.value)


@router.get("", response_model=PaginatedResponse[ReflectionResponse])
async def list_reflections(
    date: str | None = Query(None, description="Filter by date (YYYY-MM-DD)"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List reflections, optionally filtered by date (newest first)."""
    filters: dict = {}
    if date is not None:
        filters["date"] = date
    items, total = await ReflectionService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
        filters=filters or None,
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }


@router.get("/{id}", response_model=ReflectionResponse)
async def get_reflection(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single reflection by id."""
    return await ReflectionService(db).get(id)


@router.put("/{id}", response_model=ReflectionResponse)
async def update_reflection(
    id: str,
    data: ReflectionUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update an existing reflection (partial update)."""
    current = await db.get(Reflection, id)
    if current is None:
        raise NotFoundError(f"Reflection '{id}' not found")
    patch = data.model_dump(exclude_unset=True)
    for field in ("related_task_ids", "tags", "sections", "auto_linked_session_ids"):
        if field in patch:
            patch[field] = json.dumps(patch[field])
    result = await store.uow.execute(
        scope,
        store.entity_commands.update(
            scope, "reflection", id, patch,
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return dict(result.value)


@router.delete("/{id}")
async def delete_reflection(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Delete a reflection."""
    current = await db.get(Reflection, id)
    if current is None:
        raise NotFoundError(f"Reflection '{id}' not found")
    await store.uow.execute(
        scope,
        store.entity_commands.delete(
            scope, "reflection", id,
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return {"message": "Deleted"}
