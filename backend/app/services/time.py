"""UTC timestamp helpers for PomodoroXII.

All timestamps in the system use Z-suffix UTC format for consistency
with SQLite lexicographic comparison used by the sync protocol.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utc_now_iso() -> str:
    """Return current UTC time as ISO 8601 string with Z suffix, seconds precision.

    Format: 2026-07-02T10:30:45Z
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now_iso_ms() -> str:
    """Return current UTC time as ISO 8601 string with Z suffix, millisecond precision.

    Format: 2026-07-02T10:30:45.123Z
    Used by tombstone and sync audit records, and as the canonical timestamp
    format for sync-enabled entities (SyncMixin.updated_at).

    P0-2: emits exactly 3-digit milliseconds (not 6-digit microseconds) so
    lexicographic comparison of timestamps is consistent across rows.
    """
    now = datetime.now(timezone.utc)
    ms = now.microsecond // 1000
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def utc_now() -> datetime:
    """Return current UTC time as a timezone-aware datetime."""
    return datetime.now(timezone.utc)
