"""Meta-level ORM models: space registry + global settings.

These tables live in the *meta* database only (never in a per-space
database). The schema is registered only on ``MetaBase.metadata`` so Meta and Space
migrations can evolve independently.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, String
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


class MetaSetting(MetaBase):
    """Global key/value setting stored in the meta database."""

    __tablename__ = "meta_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    value: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=_utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=_utc_now_iso)
