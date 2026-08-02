"""Task Space definition and label ORM models."""

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class StatusDefinition(Base, SyncMixin):
    __tablename__ = "status_definitions"
    __table_args__ = (
        CheckConstraint(
            "category IN ('not_started','in_progress','paused','waiting','completed','cancelled')",
            name="category_values",
        ),
        UniqueConstraint("category", "system", name="uq_status_definitions_category_system"),
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    icon: Mapped[str | None] = mapped_column(String(32))
    color: Mapped[str | None] = mapped_column(String(32))
    rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    system: Mapped[bool] = mapped_column(nullable=False, default=False, server_default="0")
    archived_at: Mapped[str | None] = mapped_column(String(32))


class TypeDefinition(Base, SyncMixin):
    __tablename__ = "type_definitions"
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    icon: Mapped[str | None] = mapped_column(String(32))
    color: Mapped[str | None] = mapped_column(String(32))
    rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    system: Mapped[bool] = mapped_column(nullable=False, default=False, server_default="0")
    archived_at: Mapped[str | None] = mapped_column(String(32))

    __table_args__ = (CheckConstraint("length(trim(name)) > 0", name="name_nonblank"),)


class Label(Base, SyncMixin):
    __tablename__ = "labels"
    __table_args__ = (UniqueConstraint("name", name="uq_labels_name"),)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[str | None] = mapped_column(String(32))
    archived_at: Mapped[str | None] = mapped_column(String(32))


class WorkItemLabel(Base):
    __tablename__ = "work_item_labels"

    work_item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("work_items.id"), primary_key=True
    )
    label_id: Mapped[str] = mapped_column(String(36), ForeignKey("labels.id"), primary_key=True)
