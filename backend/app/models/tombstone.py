"""Tombstone model for tracking deleted entities during sync."""

from app.services.time import utc_now_iso

from sqlalchemy import Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Tombstone(Base):
    """Records of deleted entities to prevent resurrection during sync.

    When an entity is deleted, we cannot simply remove it from the database
    because other clients that have not yet synced need to know it was deleted.
    Tombstones solve this by recording the deletion event with a timestamp.

    Note: this model intentionally does NOT inherit ``SyncMixin``. It uses an
    auto-incrementing integer primary key and a unique constraint on
    ``(entity_type, entity_id)`` so each deleted entity is recorded exactly
    once.
    """

    __tablename__ = "tombstones"
    __table_args__ = (
        UniqueConstraint("entity_type", "entity_id", name="uq_tombstone_entity"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    entity_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    deleted_at: Mapped[str] = mapped_column(
        String(32), default=utc_now_iso, index=True
    )
