"""Shared mixins for sync-enabled ORM models.

Entities that participate in cross-device synchronization inherit
``SyncMixin`` to obtain a consistent set of primary-key and timestamp
columns without re-declaring them in every model file.
"""

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.services.time import utc_now_iso


class SyncMixin:
    """Provide sync-friendly primary key, timestamps, and version counter.

    Columns provided:
      - id: UUID hex string primary key (auto-generated on insert)
      - created_at: UTC ISO timestamp (auto-set on insert)
      - updated_at: UTC ISO timestamp (auto-set on insert)
      - version: integer version counter for optimistic concurrency control
    """

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: __import__("uuid").uuid4().hex
    )
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)
    # D-1: index=True for sync pull WHERE updated_at > since
    updated_at: Mapped[str] = mapped_column(
        String(32), default=utc_now_iso, onupdate=utc_now_iso, index=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
