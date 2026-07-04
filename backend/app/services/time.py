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
    """Return current UTC time as ISO 8601 string with Z suffix, microsecond precision.

    Format: 2026-07-02T10:30:45.123456Z
    Used by tombstone and sync audit records.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def utc_now() -> datetime:
    """Return current UTC time as a timezone-aware datetime."""
    return datetime.now(timezone.utc)
