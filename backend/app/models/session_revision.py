"""Append-only FocusSession attribution, plan, and outcome facts."""

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class SessionAttributionRevision(Base, SyncMixin):
    __tablename__ = "session_attribution_revisions"
    __table_args__ = (
        UniqueConstraint("session_id", "revision", name="uq_session_attribution_revision"),
        Index(
            "uq_session_attribution_effective",
            "session_id",
            unique=True,
            sqlite_where=text("effective = 1"),
        ),
    )

    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("focus_sessions.id"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False)
    level2_work_item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(500))
    corrected_from_revision: Mapped[int | None] = mapped_column(Integer)
    effective: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")


class SessionWorkItemPlan(Base, SyncMixin):
    __tablename__ = "session_work_item_plans"
    __table_args__ = (
        UniqueConstraint("session_id", "work_item_id", name="uq_session_work_item_plan"),
        CheckConstraint("plan_rank >= 0", name="plan_rank_nonnegative"),
        CheckConstraint(
            "source IN ('before_start','during_session','review_materialized')",
            name="plan_source_values",
        ),
    )

    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("focus_sessions.id"), nullable=False
    )
    work_item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    title_snapshot: Mapped[str] = mapped_column(String(500), nullable=False)
    level2_snapshot: Mapped[str | None] = mapped_column(String(500))
    plan_rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    added_at: Mapped[str] = mapped_column(String(32), nullable=False)
    removed_at: Mapped[str | None] = mapped_column(String(32))
    removal_reason: Mapped[str | None] = mapped_column(String(500))
    current_during_session: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    completion_draft: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")


class SessionWorkItemOutcome(Base, SyncMixin):
    __tablename__ = "session_work_item_outcomes"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "work_item_id", "revision", name="uq_session_work_item_outcome"
        ),
        CheckConstraint(
            "result IN ('completed','progressed','stuck','untouched','cancelled')",
            name="outcome_result_values",
        ),
        CheckConstraint(
            "state_command IN ('complete','cancel','none')",
            name="state_command_values",
        ),
        Index(
            "uq_session_work_item_outcome_effective",
            "session_id",
            "work_item_id",
            unique=True,
            sqlite_where=text("effective = 1"),
        ),
    )

    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("focus_sessions.id"), nullable=False
    )
    session_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    corrected_from_revision: Mapped[int | None] = mapped_column(Integer)
    effective: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    work_item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    touched: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    result: Mapped[str] = mapped_column(String(32), nullable=False)
    persona: Mapped[str | None] = mapped_column(String(32))
    state_command: Mapped[str] = mapped_column(String(32), nullable=False, default="none", server_default="none")
    command_id: Mapped[str | None] = mapped_column(String(128))
    reviewed_at: Mapped[str | None] = mapped_column(String(32))
