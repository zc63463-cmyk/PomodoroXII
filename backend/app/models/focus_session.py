"""FocusSession and immutable task-context ORM models."""

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class FocusSession(Base, SyncMixin):
    __tablename__ = "focus_sessions"
    __table_args__ = (
        CheckConstraint(
            "planned_seconds >= 0 AND gross_seconds >= 0 AND paused_seconds >= 0 "
            "AND break_seconds >= 0 AND focused_seconds >= 0",
            name="duration_nonnegative",
        ),
        CheckConstraint("validity IN ('pending','valid','invalid')", name="validity_values"),
        CheckConstraint(
            "review_state IN ('not_required','pending','completed','skipped')",
            name="review_state_values",
        ),
        CheckConstraint(
            "ownership_state IN ('authoritative','local_provisional','activation_conflict')",
            name="ownership_state_values",
        ),
    )

    session_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # 番茄钟体系 × 任务空间体系的双体系兼容字段（2026-09-16）。
    # ``work`` / ``free`` / ``countdown`` 是"投入型"会话（focused_seconds 正常累计，
    # 计入二级投入）；``short_break`` / ``long_break`` 是"休息型"会话：
    # focused_seconds 恒为 0、break_seconds 承载全部净时长、免复盘、不进计划。
    # 归因不变量不变：所有类型都必须挂一个二级 WorkItem（休息沿用上一工作会话的）。
    # 枚举值在 policy / wire schema 双重 fail-closed；DB 层不加 CHECK 的理由见
    # ``alembic_space/versions/016_focus_session_type.py`` 的文件头。
    session_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default="work", server_default="work"
    )
    started_at: Mapped[str] = mapped_column(String(32), nullable=False)
    ended_at: Mapped[str | None] = mapped_column(String(32))
    pause_started_at: Mapped[str | None] = mapped_column(String(32))
    planned_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    gross_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    paused_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    break_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    focused_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    timer_completion: Mapped[str | None] = mapped_column(String(32))
    validity: Mapped[str] = mapped_column(String(32), nullable=False, default="pending", server_default="pending")
    validity_reason: Mapped[str | None] = mapped_column(String(500))
    overall_progress: Mapped[str | None] = mapped_column(String(32))
    mood: Mapped[str | None] = mapped_column(String(32))
    session_note: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    review_state: Mapped[str] = mapped_column(
        String(32), nullable=False, default="not_required", server_default="not_required"
    )
    ownership_state: Mapped[str] = mapped_column(
        String(32), nullable=False, default="authoritative", server_default="authoritative"
    )


class SessionTaskContext(Base, SyncMixin):
    __tablename__ = "session_task_contexts"
    __table_args__ = ()

    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("focus_sessions.id"), nullable=False, unique=True
    )
    project_id: Mapped[str] = mapped_column(String(36), nullable=False)
    level2_work_item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    title_snapshot: Mapped[str] = mapped_column(String(500), nullable=False)
    parent_snapshot: Mapped[str | None] = mapped_column(String(500))
    estimate_snapshot: Mapped[str | None] = mapped_column(String(200))
    status_snapshot: Mapped[str | None] = mapped_column(String(100))
    structure_snapshot: Mapped[str] = mapped_column(Text, nullable=False, default="{}", server_default="{}")
    linked_at: Mapped[str] = mapped_column(String(32), nullable=False)
    link_method: Mapped[str] = mapped_column(String(32), nullable=False)
