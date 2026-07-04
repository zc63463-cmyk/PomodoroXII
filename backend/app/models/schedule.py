"""SQLAlchemy model for schedules (calendar events with completion status)."""

from sqlalchemy import String, Boolean, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Schedule(Base, SyncMixin):
    """Schedule model representing a calendar event with completion status.

    Distinct from pomodoro sessions: a schedule is a broader time-planning
    entity (appointments, deadlines, reminders) that can be completed or
    left pending. No timer/countdown fields — those belong to the pomodoro
    engine.
    """

    __tablename__ = "schedules"

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    due_at: Mapped[str] = mapped_column(String(32), nullable=False)
    completed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    color: Mapped[str] = mapped_column(String(20), default="#3b82f6")
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    start_time: Mapped[str | None] = mapped_column(String(10), nullable=True)
    end_time: Mapped[str | None] = mapped_column(String(10), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "priority IN ('high','medium','low')",
            name="check_schedule_priority",
        ),
    )
