"""SQLAlchemy model for schedule-quick-note junction (日程-小记关联)."""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class ScheduleQuickNote(Base, SyncMixin):
    """ScheduleQuickNote junction model linking a schedule to a quick note.

    This is a many-to-many junction table — a single note can be associated
    with multiple schedules, and a single schedule can be associated with
    multiple notes.
    """

    __tablename__ = "schedule_quick_notes"

    schedule_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    quick_note_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
