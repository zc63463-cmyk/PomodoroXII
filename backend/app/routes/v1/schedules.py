"""REST routes for schedules (calendar events with completion status).

CRUD endpoints for the Schedule entity.  Uses an inline
``ScheduleService(BaseService)`` subclass whose ``list`` returns only
*upcoming* (incomplete, due now or later) schedules ordered by ``due_at``
ascending.  Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.schemas.common import PaginatedResponse
from app.schemas.schedule import ScheduleCreate, ScheduleResponse, ScheduleUpdate
from app.services.schedule import ScheduleService

router = APIRouter()


@router.post("", response_model=ScheduleResponse, status_code=201)
async def create_schedule(
    data: ScheduleCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new schedule event."""
    obj = await ScheduleService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


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
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Update an existing schedule (partial update)."""
    obj = await ScheduleService(db).update(id, data.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{id}")
async def delete_schedule(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a schedule."""
    await ScheduleService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}
