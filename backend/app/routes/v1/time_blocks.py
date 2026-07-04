"""REST routes for time blocks (time blocking feature).

CRUD endpoints for the TimeBlock entity.  Uses an inline
``TimeBlockService(BaseService)`` subclass whose ``list`` may be filtered
by date and is ordered by ``start_time`` then ``sort_order``.
Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.models.time_block import TimeBlock
from app.schemas.common import PaginatedResponse
from app.schemas.time_block import TimeBlockCreate, TimeBlockResponse
from app.services.base import BaseService

router = APIRouter()


class TimeBlockService(BaseService):
    """Thin service for TimeBlock — date filtering, start_time/sort_order ordering."""

    model = TimeBlock

    async def list(
        self,
        *,
        offset: int = 0,
        limit: int = 100,
        filters: dict | None = None,
    ) -> tuple[list, int]:
        q = select(self.model)
        if filters:
            for k, v in filters.items():
                q = q.where(getattr(self.model, k) == v)
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        q = q.order_by(TimeBlock.start_time.asc(), TimeBlock.sort_order.asc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total


@router.post("", response_model=TimeBlockResponse, status_code=201)
async def create_time_block(
    data: TimeBlockCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new time block."""
    obj = await TimeBlockService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


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


@router.delete("/{id}")
async def delete_time_block(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a time block."""
    await TimeBlockService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}
