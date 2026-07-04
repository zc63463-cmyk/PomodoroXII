"""FolderService -- CRUD for folders (virtual file system hierarchy).

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.models.folder import Folder
from app.services.base import BaseService


class FolderService(BaseService):
    """Thin service for Folder — excludes trashed, orders by sort_order/name."""

    model = Folder

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
        # Always exclude trashed folders from the regular listing.
        q = q.where(Folder.trashed_at.is_(None))
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        q = q.order_by(Folder.sort_order.asc(), Folder.name.asc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total
