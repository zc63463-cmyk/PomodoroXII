"""SQLAlchemy model for memo comments (小记评论)."""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class MemoComment(Base, SyncMixin):
    """MemoComment model representing a comment on a quick note.

    Each comment is tied to a specific quick_note via note_id.
    Comments support personal annotations and are synced across devices.
    """

    __tablename__ = "memo_comments"

    note_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    content: Mapped[str] = mapped_column(String(10000), default="")
