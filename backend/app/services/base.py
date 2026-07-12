"""BaseService — flush-only CRUD foundation for all entity services.

Iron rules:
- Does NOT import FastAPI (MCP-consumable).
- Only flushes, never commits (routes commit).
- Returns ORM instances.
- Accepts dict params (MCP reservation).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.errors import NotFoundError
from app.services.serializers import serialize_entity
from app.services.sync_outbox import record_sync_event
from app.services.time import utc_now_iso


class BaseService:
    """Generic CRUD service bound to a single SQLAlchemy model.

    Subclasses set ``model`` to the ORM class.  All write methods
    ``flush()`` only — the caller (typically a route) is responsible
    for ``commit()``.

    M1: Subclasses that participate in sync should set ``entity_type``
    to the sync entity type string (e.g. ``"task"``, ``"session"``).
    When set, ``delete()`` automatically creates a tombstone so that
    deletions propagate correctly to other devices via sync pull.
    """

    model: type
    entity_type: str | None = None

    def __init__(
        self, db: AsyncSession, *, record_sync_events: bool = True,
    ) -> None:
        self.db = db
        self.record_sync_events = record_sync_events

    async def create(
        self, data: dict[str, Any], *, record_event: bool = True,
    ) -> Any:
        """Create a new row from *data* and flush."""
        obj = self.model(**data)
        self.db.add(obj)
        await self.db.flush()
        await self.db.refresh(obj)
        if self.entity_type and self.record_sync_events and record_event:
            await record_sync_event(
                self.db,
                entity_type=self.entity_type,
                entity_id=obj.id,
                action="create",
                payload=serialize_entity(obj),
            )
        return obj

    async def get(self, id: str) -> Any:
        """Return the row with *id* or raise NotFoundError."""
        obj = await self.db.get(self.model, id)
        if obj is None:
            raise NotFoundError(f"{self.model.__name__} '{id}' not found")
        return obj

    async def list(
        self,
        *,
        offset: int = 0,
        limit: int = 50,
        filters: dict[str, Any] | None = None,
    ) -> tuple[list[Any], int]:
        """Return (items, total) with optional equality filters."""
        q = select(self.model)
        if filters:
            for k, v in filters.items():
                q = q.where(getattr(self.model, k) == v)
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total

    async def update(
        self,
        id: str,
        data: dict[str, Any],
        *,
        bump_updated_at: bool = True,
        record_event: bool = True,
    ) -> Any:
        """Update fields on the row with *id* and bump updated_at.

        When *bump_updated_at* is False (sync_mode=True path), the caller
        is responsible for setting ``updated_at`` and ``version`` in *data*.
        We explicitly preserve ``updated_at`` to block ``SyncMixin.onupdate``
        from firing during the UPDATE (which would otherwise overwrite
        the client-provided timestamp with server-now).
        """
        obj = await self.get(id)
        original_ts = obj.updated_at
        for k, v in data.items():
            setattr(obj, k, v)
        if bump_updated_at:
            obj.updated_at = utc_now_iso()
            if hasattr(obj, "version"):
                obj.version = (obj.version or 0) + 1
        else:
            # P1-3: sync_mode path. Force updated_at into the UPDATE SET
            # clause so SyncMixin.onupdate=utc_now_iso_ms does not fire.
            # If data contains updated_at, it was already setattr'd above;
            # but setattr with the same value does NOT mark the column as
            # dirty, which would allow onupdate to fire and overwrite the
            # client timestamp. flag_modified forces the column into SET.
            if "updated_at" not in data:
                obj.updated_at = original_ts
            flag_modified(obj, "updated_at")
        await self.db.flush()
        await self.db.refresh(obj)
        if self.entity_type and self.record_sync_events and record_event:
            await record_sync_event(
                self.db,
                entity_type=self.entity_type,
                entity_id=obj.id,
                action="update",
                payload=serialize_entity(obj),
            )
        return obj

    async def _ensure_tombstone(self, id: str) -> None:
        """Create a tombstone for this entity if ``entity_type`` is set.

        M1: Centralised tombstone creation so all sync entities record
        deletions consistently.  Subclasses with custom ``delete()``
        methods should call this instead of importing TombstoneService
        directly.
        """
        if self.entity_type:
            from app.services.tombstone import TombstoneService

            await TombstoneService(self.db).create(self.entity_type, id)

    async def delete(self, id: str) -> None:
        """Delete the row with *id*.  Raise NotFoundError if missing.

        M1: Creates a tombstone when ``entity_type`` is set so that
        sync pull can propagate the deletion to other devices.
        """
        obj = await self.get(id)
        await self.db.delete(obj)
        await self.db.flush()
        await self._ensure_tombstone(id)
        if self.entity_type and self.record_sync_events:
            await record_sync_event(
                self.db,
                entity_type=self.entity_type,
                entity_id=id,
                action="delete",
            )
