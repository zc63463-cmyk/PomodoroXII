"""Persistent state for sync retention and materialized full snapshots."""

from sqlalchemy import CheckConstraint, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.services.time import utc_now_iso


class SyncState(Base):
    __tablename__ = "sync_state"
    __table_args__ = (
        CheckConstraint(
            "retention_floor >= 0 AND current_cursor >= retention_floor",
            name="floor_cursor",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    retention_floor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_cursor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class SyncSnapshot(Base):
    __tablename__ = "sync_snapshots"

    token: Mapped[str] = mapped_column(String(36), primary_key=True)
    cursor: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)
