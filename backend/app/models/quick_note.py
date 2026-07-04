"""SQLAlchemy model for quick notes (rapid capture with optional session link)."""

from sqlalchemy import String, Boolean, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class QuickNote(Base, SyncMixin):
    """QuickNote model for rapid text capture during work sessions.

    Supports optional association with a pomodoro session via session_id.
    A session can have multiple quick notes; a quick note can exist
    independently without a session link.

    Two distinct "removed" states:
      - ``trashed_at``: Soft-delete via trash route (same as Note/Folder).
        Item appears in recycle bin, can be restored or purged.
      - ``archived_at``: Migration archive — set when a quick note is
        converted to a full Note. The quick note row is kept for
        reference (with ``migrated_to_note_id`` pointing to the new
        Note) but hidden from active listings. This is NOT a deletion.
    """

    __tablename__ = "quick_notes"

    content: Mapped[str] = mapped_column(String(50000), default="")
    mood: Mapped[str | None] = mapped_column(String(20), nullable=True)
    tags: Mapped[str] = mapped_column(String(4000), default="[]")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    archived_at: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )
    archive_file_path: Mapped[str | None] = mapped_column(
        String(500), nullable=True
    )
    folder_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    trashed_at: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )
    migrated_to_note_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    session_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )

    __table_args__ = (
        CheckConstraint(
            "mood IN ('normal','happy','sad','tired','excited','calm') OR mood IS NULL",
            name="check_quick_note_mood",
        ),
    )
