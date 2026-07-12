"""Persistent state for sync retention and materialized full snapshots."""

from sqlalchemy import ForeignKey, Index, Integer, LargeBinary, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.services.time import utc_now_iso


class SyncState(Base):
    __tablename__ = "sync_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    retention_floor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_cursor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class SyncSnapshot(Base):
    __tablename__ = "sync_snapshots"
    __table_args__ = (
        Index("ix_sync_snapshots_expiry_status", "expires_at", "status"),
    )

    token: Mapped[str] = mapped_column(String(36), primary_key=True)
    cursor: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False, default="")
    format: Mapped[str] = mapped_column(
        String(32), nullable=False, default="gzip-chunks-v1", server_default=text("'legacy-json-v1'")
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="building", server_default=text("'ready'")
    )
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    uncompressed_bytes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    compressed_bytes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    checksum: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=text("''")
    )
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)
    expires_at: Mapped[str] = mapped_column(
        String(32), nullable=False, default="", server_default=text("''")
    )


class SyncSnapshotChunk(Base):
    __tablename__ = "sync_snapshot_chunks"
    __table_args__ = (
        Index("ix_sync_snapshot_chunks_offset", "snapshot_token", "item_start", unique=True),
    )

    snapshot_token: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("sync_snapshots.token", ondelete="CASCADE"),
        primary_key=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_start: Mapped[int] = mapped_column(Integer, nullable=False)
    item_count: Mapped[int] = mapped_column(Integer, nullable=False)
    compressed_payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    uncompressed_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    compressed_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
