"""Immutable FocusSession command envelopes and receipts."""

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SessionCommandEnvelope(Base):
    __tablename__ = "session_command_envelopes"
    command_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    space_id: Mapped[str] = mapped_column(String(36), nullable=False)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("focus_sessions.id"), nullable=False
    )
    session_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    work_item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    expected_version: Mapped[int] = mapped_column(Integer, nullable=False)
    target_transition: Mapped[str] = mapped_column(String(32), nullable=False)
    replay_safe: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint("expected_version >= 0", name="expected_version_nonnegative"),
        CheckConstraint(
            "target_transition IN ('complete','cancel')", name="target_transition_values"
        ),
        CheckConstraint("length(payload_hash) = 64", name="payload_hash_length"),
    )


class SessionCommandReceipt(Base):
    __tablename__ = "session_command_receipts"
    command_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("session_command_envelopes.command_id"), primary_key=True
    )
    state: Mapped[str] = mapped_column(String(32), nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(64))
    retryable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    details_json: Mapped[str | None] = mapped_column(Text)
    result_json: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "state IN ('not_needed','pending','succeeded','failed','conflict','unknown','abandoned')",
            name="receipt_state_values",
        ),
    )
