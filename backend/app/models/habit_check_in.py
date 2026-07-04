"""SQLAlchemy model for habit check-ins (daily check-in records)."""

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class HabitCheckIn(Base, SyncMixin):
    """HabitCheckIn model representing a daily check-in record for a habit.

    Each record captures the check-in date, cumulative count for that day,
    and an optional note. Multiple check-ins on the same day increment the
    count rather than creating new rows (enforced client-side).
    """

    __tablename__ = "habit_check_ins"

    habit_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    date: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    count: Mapped[int] = mapped_column(Integer, default=1)
    note: Mapped[str] = mapped_column(String(10000), default="")
