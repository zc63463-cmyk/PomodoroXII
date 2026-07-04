"""SQLAlchemy model for daily reflections."""

from sqlalchemy import String, CheckConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Reflection(Base, SyncMixin):
    """Reflection model for daily retrospectives."""

    __tablename__ = "reflections"

    date: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    content: Mapped[str] = mapped_column(String(50000), default="")
    mood: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    related_task_ids: Mapped[str] = mapped_column(String(4000), default="[]")
    tags: Mapped[str] = mapped_column(String(4000), default="[]")
    # Phase 2 extensions: structured reflection + auto-linking
    sections: Mapped[str] = mapped_column(String(4000), default="[]")
    is_structured: Mapped[str] = mapped_column(String(10), default="false")
    auto_linked_session_ids: Mapped[str] = mapped_column(String(4000), default="[]")

    __table_args__ = (
        CheckConstraint(
            "mood IN ('great','good','normal','bad','terrible')",
            name="check_reflection_mood",
        ),
        Index("idx_reflection_date_mood", "date", "mood"),
    )
