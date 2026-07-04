"""Sync safety utilities — pure functions for timestamp normalization,
zero-time detection, entity serialization, and LWW conflict resolution.

Does NOT import FastAPI. Does NOT commit. Pure utility functions.
"""

from __future__ import annotations

import json
from typing import Any

from app.services.time import utc_now_iso


# --------------------------------------------------------------------------- #
# Timestamp normalization
# --------------------------------------------------------------------------- #

def normalize_timestamp(ts: str) -> str:
    """Normalize an ISO timestamp to millisecond precision.

    - Empty string → empty string (passthrough).
    - Second-precision ISO (e.g. ``2026-07-04T10:00:00Z``) → padded to
      ``2026-07-04T10:00:00.000Z``.
    - Millisecond-precision input → returned unchanged.
    """
    if not ts:
        return ""
    # Already has millisecond precision.
    if "." in ts:
        return ts
    # Insert .000 before the trailing Z (or +00:00, but we expect Z form).
    if ts.endswith("Z"):
        return ts[:-1] + ".000Z"
    return ts


def is_zero_time(ts: str | None) -> bool:
    """Return True if *ts* is empty or the Unix epoch."""
    if ts is None or ts == "":
        return True
    return ts in ("1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z")


def sanitize_zero_time(ts: str, now: str | None = None) -> str:
    """Replace zero-time *ts* with the current UTC time.

    Real timestamps are returned unchanged. The *now* argument lets tests
    supply a deterministic value; if omitted, ``utc_now_iso()`` is used.
    """
    if is_zero_time(ts):
        return now if now is not None else utc_now_iso()
    return ts


# --------------------------------------------------------------------------- #
# Entity serialization
# --------------------------------------------------------------------------- #

def serialize_entity(obj: Any) -> dict:
    """Convert an ORM instance to a plain dict.

    Like ``app.services.serializers.serialize_entity`` but duplicated here
    so sync safety utilities remain self-contained. Tags stored as JSON
    strings are parsed back to lists.
    """
    d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
    if "tags" in d and isinstance(d["tags"], str):
        if not d["tags"]:
            d["tags"] = []
        else:
            try:
                d["tags"] = json.loads(d["tags"])
            except (json.JSONDecodeError, ValueError):
                d["tags"] = []
    return d


# --------------------------------------------------------------------------- #
# Last-Write-Wins conflict detection
# --------------------------------------------------------------------------- #

def check_lww_conflict(local_obj: Any, remote_ts: str) -> str:
    """Resolve a sync conflict using Last-Write-Wins.

    Returns:
        ``"local"``  — local version is newer or equal (keep local).
        ``"remote"`` — remote version is strictly newer (apply remote).
    """
    local_ts = normalize_timestamp(getattr(local_obj, "updated_at", "") or "")
    remote_ts_n = normalize_timestamp(remote_ts or "")
    if remote_ts_n > local_ts:
        return "remote"
    return "local"
