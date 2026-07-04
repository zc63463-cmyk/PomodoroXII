"""REST routes for habits and habit check-ins.

CRUD endpoints for the Habit entity plus nested check-in sub-resources.
Uses inline ``HabitService`` and ``HabitCheckInService`` subclasses of
``BaseService``.  ``HabitService`` serialises the ``rest_days`` list to a
JSON string before persisting (the column is a String).  Check-ins are
scoped under ``/{habit_id}/check-ins``.
Routes commit; the services only flush.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.schemas.common import PaginatedResponse
from app.schemas.habit import HabitCreate, HabitResponse
from app.schemas.habit_check_in import (
    HabitCheckInCreate,
    HabitCheckInResponse,
)
from app.services.habit import HabitCheckInService, HabitService

router = APIRouter()


# --------------------------------------------------------------------------- #
# Habit CRUD
# --------------------------------------------------------------------------- #
@router.post("", response_model=HabitResponse, status_code=201)
async def create_habit(
    data: HabitCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new habit."""
    obj = await HabitService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get("", response_model=PaginatedResponse[HabitResponse])
async def list_habits(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List all habits ordered by sort_order."""
    items, total = await HabitService(db).list(
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


@router.get("/{id}", response_model=HabitResponse)
async def get_habit(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single habit by id."""
    return await HabitService(db).get(id)


@router.delete("/{id}")
async def delete_habit(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a habit."""
    await HabitService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}


# --------------------------------------------------------------------------- #
# Habit check-ins (nested under /{habit_id}/check-ins)
# --------------------------------------------------------------------------- #
@router.post(
    "/{habit_id}/check-ins",
    response_model=HabitCheckInResponse,
    status_code=201,
)
async def create_check_in(
    habit_id: str,
    data: HabitCheckInCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Record a check-in for the given habit (path habit_id is authoritative)."""
    payload = data.model_dump()
    payload["habit_id"] = habit_id
    obj = await HabitCheckInService(db).create(payload)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get(
    "/{habit_id}/check-ins",
    response_model=PaginatedResponse[HabitCheckInResponse],
)
async def list_check_ins(
    habit_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List check-ins for a habit (newest date first)."""
    items, total = await HabitCheckInService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
        filters={"habit_id": habit_id},
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }
