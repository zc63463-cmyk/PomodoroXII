"""Sync safety utilities — pure functions for timestamp normalization,
zero-time detection, entity serialization, LWW conflict resolution,
client field stripping, and folder circular reference detection.

Does NOT import FastAPI. Does NOT commit. Pure utility functions +
async DB helpers.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
# Re-exported from app.services.serializers so callers that import from
# sync_safety (e.g. SyncService.pull) get the same canonical implementation.
from app.services.serializers import serialize_entity  # noqa: F401, E402


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


# --------------------------------------------------------------------------- #
# Client field stripping (C2)
# --------------------------------------------------------------------------- #

# Generic client-only fields present on all entities (client-side bookkeeping).
_CLIENT_ONLY_FIELDS: set[str] = {"synced", "_dirty", "_etag"}

# Protected fields that must never be overwritten by client payloads.
# ``id`` is re-injected from the event's entity_id; ``created_at`` and
# ``version`` are server-managed.
_PROTECTED_FIELDS: set[str] = {"id", "created_at", "version"}

# Entity-specific client-only fields.
_ENTITY_CLIENT_FIELDS: dict[str, set[str]] = {
    "task": {"actual_pomodoros"},
    "quickNote": {"archive_file_path", "migrated_to_note_id"},
}


def strip_client_fields(data: dict[str, Any], entity_type: str) -> dict[str, Any]:
    """Strip client-only and protected fields from a sync payload.

    Returns a **new** dict with the following removed:
    - Generic client-only fields (``synced``, ``_dirty``, ``_etag``).
    - Entity-specific client fields (e.g. ``actual_pomodoros`` for tasks).
    - Protected fields (``id``, ``created_at``, ``version``).

    The original *data* dict is not modified.
    """
    stripped = dict(data)
    # Remove generic client-only fields.
    for key in _CLIENT_ONLY_FIELDS:
        stripped.pop(key, None)
    # Remove entity-specific client fields.
    for key in _ENTITY_CLIENT_FIELDS.get(entity_type, set()):
        stripped.pop(key, None)
    # Remove protected fields.
    for key in _PROTECTED_FIELDS:
        stripped.pop(key, None)
    return stripped


# --------------------------------------------------------------------------- #
# Folder circular reference detection (C3)
# --------------------------------------------------------------------------- #


async def check_folder_circular_ref(
    db: AsyncSession, folder_id: str, new_parent_id: str | None
) -> bool:
    """Detect whether setting *new_parent_id* would create a cycle.

    Traverses the parent chain upward from *new_parent_id*.  Returns
    ``True`` if *folder_id* is encountered (i.e. the folder would become
    its own ancestor), ``False`` otherwise.

    A ``visited`` set guards against pre-existing cycles in the data.
    """
    if new_parent_id is None:
        return False
    if folder_id == new_parent_id:
        return True
    # Walk up the parent chain looking for folder_id.
    from app.models.folder import Folder

    current: str | None = new_parent_id
    visited: set[str] = set()
    while current is not None and current not in visited:
        visited.add(current)
        if current == folder_id:
            return True
        result = await db.execute(
            select(Folder.parent_id).where(Folder.id == current)
        )
        row = result.first()
        if row is None:
            break
        current = row[0]
    return False
