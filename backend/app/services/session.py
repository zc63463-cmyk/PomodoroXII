"""SessionService -- CRUD for pomodoro sessions.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.models.session import Session
from app.services.base import BaseService


class SessionService(BaseService):
    """Thin service for Session — adds started_at desc ordering to list."""

    model = Session
    entity_type = "session"

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
        q = q.order_by(self.model.started_at.desc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total
