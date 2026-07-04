"""SQLAlchemy model for the sync outbox (pending sync events queue)."""

from app.services.time import utc_now_iso

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SyncOutbox(Base):
    """SyncOutbox model representing a pending sync event.

    Each row records an entity mutation (create/update/delete) that must be
    pushed to remote sync endpoints. ``synced_at`` is set once the event has
    been acknowledged, after which the row can be pruned.

    Note: this model intentionally does NOT inherit ``SyncMixin``. It uses an
    auto-incrementing integer primary key because outbox rows are ephemeral
    queue entries rather than first-class synced entities.
    """

    __tablename__ = "sync_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(50), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(20))  # create/update/delete
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, index=True)
    synced_at: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
