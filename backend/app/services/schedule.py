"""ScheduleService -- CRUD for schedules (calendar events).

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.schedule import Schedule
from app.services.base import BaseService
from app.services.time import utc_now_iso


class ScheduleService(BaseService):
    """Thin service for Schedule — lists upcoming items ordered by due_at."""

    model = Schedule
    entity_type = "schedule"

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
        # Upcoming: not yet completed and due now or later.
        q = q.where(Schedule.completed_at.is_(None))
        q = q.where(Schedule.due_at >= utc_now_iso())
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        q = q.order_by(Schedule.due_at.asc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total
