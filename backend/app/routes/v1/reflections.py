"""REST routes for daily reflections.

CRUD endpoints for the Reflection entity.  Uses an inline
``ReflectionService(BaseService)`` subclass that serialises JSON-array
fields (``related_task_ids``, ``tags``, ``sections``,
``auto_linked_session_ids``) and the boolean ``is_structured`` (stored as
the string ``"true"``/``"false"``) before persisting.  Listings are
ordered by date descending and may be filtered by date.
Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.schemas.common import PaginatedResponse
from app.schemas.reflection import ReflectionCreate, ReflectionResponse
from app.services.reflection import ReflectionService

router = APIRouter()


@router.post("", response_model=ReflectionResponse, status_code=201)
async def create_reflection(
    data: ReflectionCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new daily reflection."""
    obj = await ReflectionService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


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


@router.delete("/{id}")
async def delete_reflection(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a reflection."""
    await ReflectionService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}
