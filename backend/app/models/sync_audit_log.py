"""SQLAlchemy model for the sync audit log."""

from app.services.time import utc_now_iso

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SyncAuditLog(Base):
    """SyncAuditLog model representing an auditable sync event.

    Immutable append-only log used for diagnostics and compliance. Each row
    captures the event type, affected entity, and a free-form details blob.

    Note: this model intentionally does NOT inherit ``SyncMixin``. It uses an
    auto-incrementing integer primary key because audit rows are append-only
    records that are never updated or synced as entities.
    """

    __tablename__ = "sync_audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(50), index=True)
    entity_type: Mapped[str] = mapped_column(String(50), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    details: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, index=True)
