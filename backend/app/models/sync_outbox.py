"""SQLAlchemy model for the append-only server sync event ledger."""

from sqlalchemy import Boolean, CheckConstraint, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.services.time import utc_now_iso


class SyncOutbox(Base):
    """One ordered server-side entity mutation.

    H2 retains the historical ``sync_outbox`` table name for compatibility.
    Its ``id`` orders events within committed, non-overlapping mutations, but
    H2-C must not treat allocation order as commit order until concurrency is
    serialized or a commit-safe sequence protocol is introduced.
    ``synced_at`` remains nullable for compatibility and is not the cursor.

    This model intentionally does NOT inherit ``SyncMixin``: ledger rows are
    transport records rather than first-class synced entities.
    """

    __tablename__ = "sync_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(50), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(20))  # create/update/delete
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, index=True)
    synced_at: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    operation_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    batch_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    visible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("0"), index=True
    )

    __table_args__ = (
        CheckConstraint("version IS NULL OR version >= 0", name="version_nonnegative"),
    )
