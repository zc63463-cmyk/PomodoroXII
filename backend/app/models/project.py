"""Task Space Project ORM model."""

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Project(Base, SyncMixin):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("key", name="uq_projects_key"),
        CheckConstraint(
            "length(key) BETWEEN 2 AND 10 AND substr(key, 1, 1) GLOB '[A-Z]' "
            "AND key NOT GLOB '*[^A-Z0-9]*'",
            name="key_format",
        ),
        CheckConstraint("next_work_item_number >= 1", name="next_work_item_number_positive"),
    )

    key: Mapped[str] = mapped_column(String(10), nullable=False)
    next_work_item_number: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    default_status_definition_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("status_definitions.id"), nullable=False
    )
    default_type_definition_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("type_definitions.id"), nullable=False
    )
    archived_at: Mapped[str | None] = mapped_column(String(32))
