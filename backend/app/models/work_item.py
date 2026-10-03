"""Task Space WorkItem ORM model."""

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class WorkItem(Base, SyncMixin):
    __tablename__ = "work_items"
    __table_args__ = (
        UniqueConstraint("project_id", "display_key", name="uq_work_items_project_display_key"),
        CheckConstraint(
            "priority IS NULL OR priority IN ('low','medium','high','urgent')",
            name="priority_values",
        ),
        CheckConstraint(
            "confidence IS NULL OR confidence IN ('low','medium','high')",
            name="confidence_values",
        ),
        CheckConstraint("effort_actual_seconds >= 0", name="effort_actual_nonnegative"),
        CheckConstraint(
            "(effort_estimate_lower_seconds IS NULL AND effort_estimate_upper_seconds IS NULL) "
            "OR (effort_estimate_lower_seconds >= 0 AND effort_estimate_upper_seconds > 0 "
            "AND effort_estimate_lower_seconds <= effort_estimate_upper_seconds)",
            name="effort_range",
        ),
    )

    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id"), nullable=False, index=True
    )
    display_key: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    type_definition_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("type_definitions.id"), nullable=False
    )
    status_definition_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("status_definitions.id"), nullable=False
    )
    # ★ 2026-09-12（ADR-0003）：最后一次进入 waiting 类目前所处的状态。
    #   服务端自持的唯一写入者 = 进入 Waiting 的迁移编译；只走读投影，
    #   不进 WORK_ITEM_SYNC_FIELDS。NULL = 无可信前态（绝不猜）。
    pre_waiting_status_definition_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("status_definitions.id")
    )
    priority: Mapped[str | None] = mapped_column(String(20))
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("work_items.id"), index=True
    )
    child_rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    completion_window_start: Mapped[str | None] = mapped_column(String(32))
    completion_window_end: Mapped[str | None] = mapped_column(String(32))
    review_point: Mapped[str | None] = mapped_column(String(32))
    hard_deadline: Mapped[str | None] = mapped_column(String(32))
    # ★ 2026-10-03（space_018）：截止日期。竞品调研 7/7 主流产品都有 due date，
    #   这是柔性计划字段族里唯一证据充分的基础字段；与 DORMANT 的 8 个柔性字段
    #   无关（那些仍不激活）。可空：NULL = 无截止。值域不做 DB CHECK（同族惯例，
    #   校验在 schema / 编译器层）。本阶段只出不进：不进 WORK_ITEM_SYNC_FIELDS。
    due_at: Mapped[str | None] = mapped_column(String(32))
    effort_estimate_lower_seconds: Mapped[int | None] = mapped_column(Integer)
    effort_estimate_upper_seconds: Mapped[int | None] = mapped_column(Integer)
    effort_actual_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    confidence: Mapped[str | None] = mapped_column(String(20))
    completed_at: Mapped[str | None] = mapped_column(String(32))
    cancelled_at: Mapped[str | None] = mapped_column(String(32))
    archived_at: Mapped[str | None] = mapped_column(String(32))
    marked_as_attention: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
