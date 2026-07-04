"""ReflectionService -- CRUD for daily reflections.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select

from app.models.reflection import Reflection
from app.services.base import BaseService

# Fields stored as JSON-serialised strings in SQLite.
_JSON_LIST_FIELDS = (
    "related_task_ids",
    "tags",
    "sections",
    "auto_linked_session_ids",
)


class ReflectionService(BaseService):
    """Thin service for Reflection — JSON list / bool serialisation, date ordering."""

    model = Reflection
    entity_type = "reflection"

    async def create(self, data: dict) -> object:
        data = dict(data)
        for field in _JSON_LIST_FIELDS:
            if field in data and isinstance(data[field], list):
                data[field] = json.dumps(data[field])
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
        q = q.order_by(Reflection.date.desc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total
