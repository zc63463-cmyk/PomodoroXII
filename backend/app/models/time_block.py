"""SQLAlchemy model for time blocks (time blocking feature)."""

from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class TimeBlock(Base, SyncMixin):
    """Time block model representing a planned block of time on a given date.

    Used by the time-blocking feature to schedule work/break periods.
    block_type and status are constrained via CHECK constraints to a fixed
    set of valid values (stored as strings for SQLite compatibility).
    """

    __tablename__ = "time_blocks"

    task_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(500), default="")
    date: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    start_time: Mapped[str] = mapped_column(String(10), nullable=False)
    end_time: Mapped[str] = mapped_column(String(10), nullable=False)
    planned_duration: Mapped[int] = mapped_column(Integer, default=0)
    actual_duration: Mapped[int] = mapped_column(Integer, default=0)
    block_type: Mapped[str] = mapped_column(String(20), default="work")
    status: Mapped[str] = mapped_column(String(20), default="planned")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        CheckConstraint(
            "block_type IN ('work','short_break','long_break')",
            name="check_timeblock_type",
        ),
        CheckConstraint(
            "status IN ('planned','in_progress','completed','skipped')",
            name="check_timeblock_status",
        ),
    )
