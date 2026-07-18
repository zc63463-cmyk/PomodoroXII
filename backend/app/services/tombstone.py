"""TombstoneService — idempotent deletion tracking for sync.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import RetentionAckRequiredError
from app.models.tombstone import Tombstone
from app.services.time import utc_now_iso_ms

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
            deleted_at=utc_now_iso_ms(),
        )
        self.db.add(tomb)
        try:
            await self.db.flush()
            await self.db.refresh(tomb)
            return tomb
        except IntegrityError:
            # Race: another concurrent request inserted the same tombstone.
            # Expunge the failed pending row instead of session.rollback(),
            # which inside a SAVEPOINT would undo prior deletes in the same event.
            self.db.expunge(tomb)
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
        """Reject cleanup until S4 owns registered-client ACK waterlines."""
        raise RetentionAckRequiredError()
