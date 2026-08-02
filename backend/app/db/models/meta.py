"""Meta-level ORM models: space registry + global settings.

These tables live in the *meta* database only (never in a per-space
database). The schema is registered only on ``MetaBase.metadata`` so Meta and Space
migrations can evolve independently.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, CheckConstraint, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import MetaBase


def _utc_now_iso() -> str:
    """ISO-8601 UTC timestamp string (seconds precision)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Space(MetaBase):
    """A user space: owns its own SQLite DB and notes directory.

    Attributes:
        id: Stable space identifier (nanoid), used to compute paths.
        name: Human-readable space name.
        db_path: Filesystem path to the space's SQLite database.
        notes_dir: Filesystem path to the space's notes directory.
        is_default: Whether this is the user's default space.
        created_at / updated_at: ISO-8601 UTC timestamps.
    """

    __tablename__ = "spaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    db_path: Mapped[str] = mapped_column(String(500), nullable=False)
    notes_dir: Mapped[str] = mapped_column(String(500), nullable=False)
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=_utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=_utc_now_iso)


class ActiveSessionLocator(MetaBase):
    """Application-wide singleton that owns the currently active focus session.

    Exactly one row may exist (``singleton_key = 'active'``).  TS2's
    ``ActiveSessionCoordinator`` mutates this row through a CAS on
    ``ownership_epoch``; the row is never deleted.
    """

    __tablename__ = "active_session_locator"

    singleton_key: Mapped[str] = mapped_column(
        String(16), primary_key=True, default="active", server_default="active"
    )
    space_id: Mapped[str] = mapped_column(String(36), nullable=False)
    session_id: Mapped[str] = mapped_column(String(36), nullable=False)
    operation_id: Mapped[str] = mapped_column(String(128), nullable=False)
    state: Mapped[str] = mapped_column(String(20), nullable=False)
    owner_device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_tab_id: Mapped[str] = mapped_column(String(64), nullable=False)
    ownership_epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    lease_expires_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint("singleton_key = 'active'", name="single_active_slot"),
        CheckConstraint(
            "state IN ('claiming','active','releasing')", name="state"
        ),
        CheckConstraint(
            "ownership_epoch > 0", name="ownership_epoch_positive"
        ),
        Index("ix_active_session_locator_space_id", "space_id"),
        Index("ix_active_session_locator_session_id", "session_id"),
        Index("ix_active_session_locator_operation_id", "operation_id"),
        Index("ix_active_session_locator_lease_expires_at", "lease_expires_at"),
    )


class ActiveSessionOperation(MetaBase):
    """Internal journal of every ActiveSession coordination operation.

    Each row is identified by ``operation_id`` and progresses through
    ``phase`` values.  Terminal rows and conflict rows are retained
    through the S5 recovery/backup window.
    """

    __tablename__ = "active_session_operations"

    operation_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    intent_json: Mapped[str] = mapped_column(Text, nullable=False)
    phase: Mapped[str] = mapped_column(String(32), nullable=False)
    result_descriptor_json: Mapped[str | None] = mapped_column(Text)
    related_operation_id: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('start','heartbeat','pause','resume','end','takeover',"
            "'update_note','set_current_plan_item','set_completion_draft',"
            "'add_plan_item','remove_plan_item','activate_provisional',"
            "'resolve_activation_conflict')",
            name="active_session_operation_kind",
        ),
        CheckConstraint(
            "phase IN ('prepared','claimed','space_committed',"
            "'awaiting_resolution','transferred','completed','rejected',"
            "'manual_intervention')",
            name="active_session_operation_phase",
        ),
        CheckConstraint(
            "payload_hash NOT GLOB '*[^0-9a-f]*' AND length(payload_hash) = 64",
            name="active_session_operation_hash",
        ),
        CheckConstraint(
            "result_descriptor_json IS NULL OR "
            "length(CAST(result_descriptor_json AS BLOB)) <= 8192",
            name="active_session_operation_result_descriptor_size",
        ),
        Index("ix_active_session_operations_kind", "kind"),
        Index("ix_active_session_operations_phase", "phase"),
        Index(
            "ix_active_session_operations_related_operation_id",
            "related_operation_id",
        ),
    )


class MetaSetting(MetaBase):
    """Global key/value setting stored in the meta database."""

    __tablename__ = "meta_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    value: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=_utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=_utc_now_iso)
