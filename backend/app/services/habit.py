"""HabitService + HabitCheckInService -- CRUD for habits and check-ins.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select

from app.models.habit import Habit
from app.models.habit_check_in import HabitCheckIn
from app.services.base import BaseService


class HabitService(BaseService):
    """Thin service for Habit — rest_days serialisation, sort_order ordering."""

    model = Habit
    entity_type = "habit"

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
    entity_type = "habitCheckIn"

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
