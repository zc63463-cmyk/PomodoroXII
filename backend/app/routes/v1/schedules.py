"""REST routes for schedules (calendar events with completion status).

CRUD endpoints for the Schedule entity.  Uses an inline
``ScheduleService(BaseService)`` subclass whose ``list`` returns only
*upcoming* (incomplete, due now or later) schedules ordered by ``due_at``
ascending. Writes use the durable mutation UoW; read-only endpoints use the
query service.
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
from app.models.schedule import Schedule
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.schedule import ScheduleCreate, ScheduleResponse, ScheduleUpdate
from app.services.schedule import ScheduleService

router = APIRouter()


@router.post("", response_model=ScheduleResponse, status_code=201)
async def create_schedule(
    data: ScheduleCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a new schedule event."""
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "schedule")
    result = await store.uow.execute(
        scope,
        store.entity_commands.create(scope, "schedule", payload, None),
        operation_id,
    )
    return dict(result.value)


@router.get("", response_model=PaginatedResponse[ScheduleResponse])
async def list_schedules(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List upcoming (incomplete, due now or later) schedules."""
    items, total = await ScheduleService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }


@router.get("/{id}", response_model=ScheduleResponse)
async def get_schedule(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single schedule by id."""
    return await ScheduleService(db).get(id)


@router.put("/{id}", response_model=ScheduleResponse)
async def update_schedule(
    id: str,
    data: ScheduleUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update an existing schedule (partial update)."""
    current = await db.get(Schedule, id)
    if current is None:
        raise NotFoundError(f"Schedule '{id}' not found")
    result = await store.uow.execute(
        scope,
        store.entity_commands.update(
            scope, "schedule", id, data.model_dump(exclude_unset=True),
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return dict(result.value)


@router.delete("/{id}")
async def delete_schedule(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Delete a schedule."""
    current = await db.get(Schedule, id)
    if current is None:
        raise NotFoundError(f"Schedule '{id}' not found")
    await store.uow.execute(
        scope,
        store.entity_commands.delete(
            scope, "schedule", id,
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return {"message": "Deleted"}
