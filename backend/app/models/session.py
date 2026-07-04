"""SQLAlchemy model for pomodoro sessions."""

from sqlalchemy import String, Integer, Float, Boolean, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Session(Base, SyncMixin):
    """Session model representing a work or break interval."""

    __tablename__ = "sessions"

    task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    type: Mapped[str] = mapped_column(String(20))
    duration: Mapped[int] = mapped_column(Integer)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    plan: Mapped[str] = mapped_column(String(10000), default="")
    completion: Mapped[str] = mapped_column(String(10000), default="")
    started_at: Mapped[str] = mapped_column(String(32))
    ended_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    mood: Mapped[str | None] = mapped_column(String(20), nullable=True)
    note: Mapped[str] = mapped_column(String(10000), default="")
    # Phase 1: enhanced metrics
    attention_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    flow_state_detected: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    flow_state_confidence: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )
    interruption_count: Mapped[int] = mapped_column(
        Integer, nullable=True, server_default="0"
    )
    total_interruption_duration: Mapped[int] = mapped_column(
        Integer, nullable=True, server_default="0"
    )
    avg_recovery_time: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pause_count: Mapped[int] = mapped_column(
        Integer, nullable=True, server_default="0"
    )
    total_pause_duration: Mapped[int] = mapped_column(
        Integer, nullable=True, server_default="0"
    )
    cognitive_mark_summary: Mapped[str | None] = mapped_column(
        String(4000), nullable=True, default=""
    )

    __table_args__ = (
        CheckConstraint(
            "type IN ('work','short_break','long_break','free','countdown')",
            name="check_session_type",
        ),
    )
