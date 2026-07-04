"""TombstoneService — idempotent deletion tracking for sync.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tombstone import Tombstone
from app.services.time import utc_now, utc_now_iso

TOMBSTONE_TTL_DAYS = 90


class TombstoneService:
    """Track deleted entities so they are not resurrected during sync."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(self, entity_type: str, entity_id: str) -> Tombstone:
        """Record a tombstone for (entity_type, entity_id).

        Idempotent: if a tombstone already exists it is returned as-is.
        Handles TOCTOU races by catching IntegrityError on the unique
        constraint and re-querying.
        """
        existing = await self.exists(entity_type, entity_id)
        if existing is not None:
            return existing
        tomb = Tombstone(
            entity_type=entity_type,
            entity_id=entity_id,
            deleted_at=utc_now_iso(),
        )
        self.db.add(tomb)
        try:
            await self.db.flush()
            await self.db.refresh(tomb)
            return tomb
        except IntegrityError:
            # Race: another concurrent request inserted the same tombstone.
            await self.db.rollback()
            existing = await self.exists(entity_type, entity_id)
            if existing is not None:
                return existing
            raise

    async def exists(self, entity_type: str, entity_id: str) -> Tombstone | None:
        """Return the tombstone for (entity_type, entity_id) or None."""
        res = await self.db.execute(
            select(Tombstone).where(
                Tombstone.entity_type == entity_type,
                Tombstone.entity_id == entity_id,
            )
        )
        return res.scalar_one_or_none()

    async def cleanup_expired(self, ttl_days: int = TOMBSTONE_TTL_DAYS) -> int:
        """Delete tombstones older than *ttl_days* and return the count removed."""
        cutoff = (utc_now() - timedelta(days=ttl_days)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        res = await self.db.execute(
            select(Tombstone).where(Tombstone.deleted_at < cutoff)
        )
        old = res.scalars().all()
        for t in old:
            await self.db.delete(t)
        await self.db.flush()
        return len(old)
