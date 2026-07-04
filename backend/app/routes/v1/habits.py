"""REST routes for habits and habit check-ins.

CRUD endpoints for the Habit entity plus nested check-in sub-resources.
Uses inline ``HabitService`` and ``HabitCheckInService`` subclasses of
``BaseService``.  ``HabitService`` serialises the ``rest_days`` list to a
JSON string before persisting (the column is a String).  Check-ins are
scoped under ``/{habit_id}/check-ins``.
Routes commit; the services only flush.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.models.habit import Habit
from app.models.habit_check_in import HabitCheckIn
from app.schemas.common import PaginatedResponse
from app.schemas.habit import HabitCreate, HabitResponse
from app.schemas.habit_check_in import (
    HabitCheckInCreate,
    HabitCheckInResponse,
)
from app.services.base import BaseService

router = APIRouter()


class HabitService(BaseService):
    """Thin service for Habit — rest_days serialisation, sort_order ordering."""

    model = Habit

    async def create(self, data: dict) -> object:
        data = dict(data)
        if "rest_days" in data and isinstance(data["rest_days"], list):
            data["rest_days"] = json.dumps(data["rest_days"])
        return await super().create(data)

    async def list(
        self,
        *,
        offset: int = 0,
        limit: int = 50,
        filters: dict | None = None,
    ) -> tuple[list, int]:
        q = select(self.model)
        if filters:
            for k, v in filters.items():
                q = q.where(getattr(self.model, k) == v)
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        q = q.order_by(Habit.sort_order.asc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total


class HabitCheckInService(BaseService):
    """Thin service for HabitCheckIn — orders check-ins by date descending."""

    model = HabitCheckIn

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
        q = q.order_by(HabitCheckIn.date.desc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total


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
