"""Durable client registration state for Sync v2."""

from sqlalchemy import Boolean, CheckConstraint, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SyncClient(Base):
    """One registered Sync v2 client for the current Space."""

    __tablename__ = "sync_clients"
    __table_args__ = (
        CheckConstraint("ack_sequence >= 0", name="ack_nonnegative"),
        CheckConstraint(
            "recovery_generation >= 0",
            name="generation_nonnegative",
        ),
        CheckConstraint(
            "recovery_waterline IS NULL OR recovery_waterline >= 0",
            name="recovery_waterline_nonnegative",
        ),
    )

    client_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    ack_sequence: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    catalog_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    registered_at: Mapped[str] = mapped_column(String(32), nullable=False)
    last_seen_at: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    requires_recovery: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("1")
    )
    recovery_generation: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    recovery_manifest_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    recovery_waterline: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recovery_completed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


__all__ = ["SyncClient"]
