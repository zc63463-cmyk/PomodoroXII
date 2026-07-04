"""SQLAlchemy model for session-quick-note junction (会话-小记关联)."""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class SessionQuickNote(Base, SyncMixin):
    """SessionQuickNote junction model linking a pomodoro session to a quick note.

    This is a many-to-many junction table — a single note can be associated
    with multiple sessions, and a single session can be associated with
    multiple notes.
    """

    __tablename__ = "session_quick_notes"

    session_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    quick_note_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
