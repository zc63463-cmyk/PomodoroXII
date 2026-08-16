"""REST routes for time blocks (time blocking feature).

CRUD endpoints for the TimeBlock entity.  Uses an inline
``TimeBlockService(BaseService)`` subclass whose ``list`` may be filtered
by date and is ordered by ``start_time`` then ``sort_order``.
Writes use the durable mutation UoW; read-only endpoints use the query service.
"""
from __future__ import annotations

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
from app.models.time_block import TimeBlock
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.time_block import (
    TimeBlockCreate,
    TimeBlockResponse,
    TimeBlockUpdate,
)
from app.services.time_block import TimeBlockService

router = APIRouter()


@router.post("", response_model=TimeBlockResponse, status_code=201)
async def create_time_block(
    data: TimeBlockCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a new time block."""
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "time_block")
    result = await store.uow.execute(
        scope, store.entity_commands.create(scope, "time_block", payload, None), operation_id
    )
    return dict(result.value)


@router.get("", response_model=PaginatedResponse[TimeBlockResponse])
async def list_time_blocks(
    date: str | None = Query(None, description="Filter by date (YYYY-MM-DD)"),
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List time blocks, optionally filtered by date (ordered by start_time)."""
    filters: dict = {}
    if date is not None:
        filters["date"] = date
    items, total = await TimeBlockService(db).list(
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


@router.get("/{id}", response_model=TimeBlockResponse)
async def get_time_block(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single time block by id."""
    return await TimeBlockService(db).get(id)


@router.put("/{id}", response_model=TimeBlockResponse)
async def update_time_block(
    id: str,
    data: TimeBlockUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update an existing time block (partial update)."""
    current = await db.get(TimeBlock, id)
    if current is None:
        raise NotFoundError(f"TimeBlock '{id}' not found")
    result = await store.uow.execute(
        scope,
        store.entity_commands.update(
            scope, "time_block", id, data.model_dump(exclude_unset=True),
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return dict(result.value)


@router.delete("/{id}")
async def delete_time_block(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Delete a time block."""
    current = await db.get(TimeBlock, id)
    if current is None:
        raise NotFoundError(f"TimeBlock '{id}' not found")
    await store.uow.execute(
        scope,
        store.entity_commands.delete(
            scope, "time_block", id,
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return {"message": "Deleted"}
