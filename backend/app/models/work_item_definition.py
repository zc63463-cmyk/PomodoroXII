"""Task Space definition and label ORM models."""

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class StatusDefinition(Base, SyncMixin):
    __tablename__ = "status_definitions"
    # ★ 2026-10-02（状态双轴 /迁移 space_017）：
    #   category 由 6 值收敛为 5 值（`paused` 并入 `in_progress`）。
    #   `WAITING` 保留 —— 它是 ADR-0003 等待前态的锚点。
    #   拼写是 `cancelled`（双 l），不要跟着 Linear 的 `canceled` 改。
    __table_args__ = (
        CheckConstraint(
            "category IN ('not_started','in_progress','waiting','completed','cancelled')",
            name="category_values",
        ),
        # ★ 表级 UniqueConstraint(category, system) 已被**删除**，它会直接阻断
        #   「同一 category 下添加多条用户 status」—— 而这正是双轴的核心需求。
        #   替换为部分唯一索引（见 models/__table_args__ 下方 Index 定义）：
        #   只约束「每个 category 至多一条**未归档的**系统行」，
        #   同时允许 (a) 同 category 多条用户行( b) 归档旧系统行后补新的。
        Index(
            "uq_status_definitions_system_live",
            "category",
            unique=True,
            sqlite_where=text("system = 1 AND archived_at IS NULL"),
        ),
        Index("ix_status_definitions_category_rank", "category", "rank"),
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
