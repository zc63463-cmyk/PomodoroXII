"""SQLAlchemy model for habits (habit streak chain feature)."""

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Habit(Base, SyncMixin):
    """Habit model representing a habit streak chain entity.

    Tracks daily habits with configurable rest days and target counts.
    rest_days is stored as a JSON-serialized string (array of weekday ints)
    because SQLite lacks a native array type; sync serialization handles
    list <-> JSON string conversion.
    """

    __tablename__ = "habits"

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(String(10000), default="")
    color: Mapped[str] = mapped_column(String(20), default="#7F77DD")
    icon: Mapped[str] = mapped_column(String(20), default="✅")
    target_count: Mapped[int] = mapped_column(Integer, default=1)
    rest_day_protection: Mapped[bool] = mapped_column(Boolean, default=False)
    # JSON array of ints (0=Sunday ... 6=Saturday) stored as a string.
    rest_days: Mapped[str] = mapped_column(String(4000), default="[]")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
