"""QuickNoteService -- CRUD for quick notes (rapid capture).

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select

from app.models.quick_note import QuickNote
from app.services.base import BaseService


class QuickNoteService(BaseService):
    """Thin service for QuickNote — tags serialisation, trashed exclusion, pin ordering."""

    model = QuickNote
    entity_type = "quickNote"

    async def create(self, data: dict) -> object:
        data = dict(data)
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])
        return await super().create(data)

    async def update(self, id: str, data: dict) -> object:
        data = dict(data)
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])
        return await super().update(id, data)

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
        # Exclude trashed quick notes from the regular listing.
        q = q.where(QuickNote.trashed_at.is_(None))
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        # Pinned first, then newest.
        q = q.order_by(QuickNote.pinned.desc(), QuickNote.created_at.desc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total
