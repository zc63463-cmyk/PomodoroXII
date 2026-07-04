"""SQLAlchemy model for task-quick-note junction (任务-小记关联)."""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class TaskQuickNote(Base, SyncMixin):
    """TaskQuickNote junction model linking a task to a quick note.

    This is a many-to-many junction table — a single note can be associated
    with multiple tasks, and a single task can be associated with
    multiple notes.
    """

    __tablename__ = "task_quick_notes"

    task_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    quick_note_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
