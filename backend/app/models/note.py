"""SQLAlchemy model for notes (lightweight knowledge base with category/search)."""

from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Note(Base, SyncMixin):
    """Note model for lightweight knowledge-base entries.

    Stored as structured DB records (not filesystem Markdown files).
    Supports category-based classification and tag-based filtering.
    No filesystem watcher or FTS5 — search uses SQL LIKE with indexed columns.

    The full ``content`` is stored externally (filesystem / object storage)
    to keep the DB row small. This table keeps a ``content_hash`` for
    integrity checks and a ``word_count`` for display/metrics.
    """

    __tablename__ = "notes"

    title: Mapped[str] = mapped_column(String(500), default="")
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(String(500), default="")
    tags: Mapped[str] = mapped_column(String(4000), default="[]")
    category: Mapped[str | None] = mapped_column(
        String(200), nullable=True, index=True
    )
    folder_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(
        String(20), default="active", index=True
    )  # active | archived
    trashed_at: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'archived')",
            name="check_note_status",
        ),
    )
