"""SQLAlchemy model for tasks."""

from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Task(Base, SyncMixin):
    """Task model representing a todo/plan item."""

    __tablename__ = "tasks"

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(String(10000), default="")
    status: Mapped[str] = mapped_column(String(20), default="todo", index=True)
    priority: Mapped[str] = mapped_column(String(20), default="medium", index=True)
    tags: Mapped[str] = mapped_column(String(4000), default="[]")
    plan: Mapped[str] = mapped_column(String(10000), default="")
    completion: Mapped[str] = mapped_column(String(10000), default="")
    due_date: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    estimated_pomodoros: Mapped[int] = mapped_column(Integer, default=1)
    actual_pomodoros: Mapped[int] = mapped_column(Integer, default=0)
    archived_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "status IN ('todo','in_progress','done','archived')",
            name="check_task_status",
        ),
        CheckConstraint(
            "priority IN ('low','medium','high','urgent')",
            name="check_task_priority",
        ),
    )
