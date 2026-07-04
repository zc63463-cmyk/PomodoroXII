"""Shared mixins for sync-enabled ORM models.

Entities that participate in cross-device synchronization inherit
``SyncMixin`` to obtain a consistent set of primary-key and timestamp
columns without re-declaring them in every model file.
"""

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.services.time import utc_now_iso, utc_now_iso_ms


class SyncMixin:
    """Provide sync-friendly primary key, timestamps, and version counter.

    Columns provided:
      - id: UUID hex string primary key (auto-generated on insert)
      - created_at: UTC ISO timestamp (auto-set on insert, seconds precision)
      - updated_at: UTC ISO timestamp (auto-set on insert/update,
        millisecond precision for sync cursor consistency)
      - version: integer version counter for optimistic concurrency control

    P0-2: updated_at uses utc_now_iso_ms (3-digit ms) so all rows share the
    same canonical timestamp format — lexicographic cursor comparison is
    consistent and rows are never skipped or repeated due to format mismatch.
    """

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: __import__("uuid").uuid4().hex
    )
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)
    # D-1: index=True for sync pull WHERE updated_at > since
    # P0-2: default/onupdate use utc_now_iso_ms for canonical 3-digit ms precision
    updated_at: Mapped[str] = mapped_column(
        String(32), default=utc_now_iso_ms, onupdate=utc_now_iso_ms, index=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
