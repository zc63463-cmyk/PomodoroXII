"""Task Space WorkItemNote aggregate ORM model."""

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class WorkItemNote(Base, SyncMixin):
    __tablename__ = "work_item_notes"
    __table_args__ = (UniqueConstraint("work_item_id", name="uq_work_item_notes_work_item_id"),)

    work_item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("work_items.id"), nullable=False
    )
    document_json: Mapped[str] = mapped_column(Text, nullable=False)
