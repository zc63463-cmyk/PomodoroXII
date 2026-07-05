"""REST routes for pomodoro sessions.

CRUD endpoints for the Session entity.  There is no dedicated service yet,
so a thin inline ``SessionService(BaseService)`` subclass is used.  Sessions
are created, listed (optionally filtered by type), fetched, and deleted.
Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.schemas.common import PaginatedResponse
from app.schemas.session import SessionCreate, SessionResponse, SessionUpdate
from app.services.session import SessionService

router = APIRouter()


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(
    data: SessionCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new pomodoro session."""
    obj = await SessionService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get("", response_model=PaginatedResponse[SessionResponse])
async def list_sessions(
    type: str | None = Query(
        None, description="Filter by type: work|short_break|long_break|free|countdown"
    ),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List sessions, optionally filtered by type (newest first)."""
    filters: dict = {}
    if type is not None:
        filters["type"] = type
    items, total = await SessionService(db).list(
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


@router.get("/{id}", response_model=SessionResponse)
async def get_session(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single session by id."""
    return await SessionService(db).get(id)


@router.put("/{id}", response_model=SessionResponse)
async def update_session(
    id: str,
    data: SessionUpdate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Update an existing session (partial update)."""
    obj = await SessionService(db).update(id, data.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{id}")
async def delete_session(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a session."""
    await SessionService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}
