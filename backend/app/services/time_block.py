"""TimeBlockService -- CRUD for time blocks.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.models.time_block import TimeBlock
from app.services.base import BaseService


class TimeBlockService(BaseService):
    """Thin service for TimeBlock — date filtering, start_time/sort_order ordering."""

    model = TimeBlock
    entity_type = "timeBlock"

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
