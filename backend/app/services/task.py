"""TaskService -- CRUD for tasks with tag serialization and tombstones.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task
from app.services.base import BaseService


class TaskService(BaseService):
    """Service for Task entities.

    - ``create`` converts ``tags`` from list to JSON string and defaults
      ``actual_pomodoros`` to 0.
    - ``list`` supports ``search`` (ilike on title) in addition to
      equality filters.
    - ``delete`` is idempotent and always writes a tombstone.
    """

    model = Task
    entity_type = "task"

    def __init__(self, db: AsyncSession) -> None:
        super().__init__(db)

    async def create(self, data: dict[str, Any]) -> Any:
        """Create a task, converting tags list to JSON string."""
        data = dict(data)
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])
        data.setdefault("actual_pomodoros", 0)
        return await super().create(data)

    async def update(self, id: str, data: dict[str, Any]) -> Any:
        """Update a task, converting tags list to JSON string if present."""
        data = dict(data)
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])
        return await super().update(id, data)

    async def list(
        self,
        *,
        offset: int = 0,
        limit: int = 50,
        filters: dict[str, Any] | None = None,
        search: str | None = None,
    ) -> tuple[list[Any], int]:
        """List tasks with optional search (ilike on title) and filters."""
        q = select(self.model)
        if search:
            q = q.where(self.model.title.ilike(f"%{search}%"))
        if filters:
            for k, v in filters.items():
                q = q.where(getattr(self.model, k) == v)
        total = (
            await self.db.execute(
                select(func.count()).select_from(q.subquery())
            )
        ).scalar() or 0
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total

    async def delete(self, id: str) -> None:
        """Delete a task idempotently and record a tombstone.

        If the row no longer exists this is a no-op for the ORM delete,
        but a tombstone is always ensured (idempotent via
        ``_ensure_tombstone`` → ``TombstoneService``).
        """
        obj = await self.db.get(self.model, id)
        if obj is not None:
            await self.db.delete(obj)
            await self.db.flush()
        # M1: Always ensure a tombstone exists (idempotent).
        await self._ensure_tombstone(id)
        if obj is not None:
            from app.services.sync_outbox import record_sync_event

            await record_sync_event(
                self.db,
                entity_type=self.entity_type,
                entity_id=id,
                action="delete",
            )
