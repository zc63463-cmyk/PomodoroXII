"""Registered sync clients and their durable ACK cursors."""

from sqlalchemy import Boolean, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.services.time import utc_now_iso


class SyncClient(Base):
    __tablename__ = "sync_clients"
    __table_args__ = (
        Index(
            "ix_sync_clients_watermark",
            "revoked_at",
            "lease_expires_at",
            "ack_cursor",
        ),
        Index("ix_sync_clients_user_revoked", "user_id", "revoked_at"),
    )

    client_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    ack_cursor: Mapped[int] = mapped_column(Integer, nullable=False)
    last_seen_at: Mapped[str] = mapped_column(String(32), nullable=False)
    lease_expires_at: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)
    revoked_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    snapshot_required: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
