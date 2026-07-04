"""Tests for sync_safety utility functions.

Covers 5 functions:
- normalize_timestamp: ISO timestamp → millisecond-precision ISO
- is_zero_time: detect empty/zero timestamps
- sanitize_zero_time: replace zero time with current UTC
- serialize_entity: ORM obj → dict (with tags JSON parsing)
- check_lww_conflict: Last-Write-Wins conflict resolution
"""

from __future__ import annotations

import pytest


# --------------------------------------------------------------------------- #
# normalize_timestamp
# --------------------------------------------------------------------------- #

def test_normalize_timestamp_pads_seconds_to_milliseconds():
    """Second-precision ISO should be padded to millisecond precision."""
    from app.services.sync_safety import normalize_timestamp

    result = normalize_timestamp("2026-07-04T10:00:00Z")
    assert result == "2026-07-04T10:00:00.000Z"


def test_normalize_timestamp_preserves_millisecond_input():
    """Millisecond-precision input should be returned unchanged."""
    from app.services.sync_safety import normalize_timestamp

    result = normalize_timestamp("2026-07-04T10:00:00.123Z")
    assert result == "2026-07-04T10:00:00.123Z"


def test_normalize_timestamp_handles_empty_string():
    """Empty string input should return empty string (not raise)."""
    from app.services.sync_safety import normalize_timestamp

    assert normalize_timestamp("") == ""


# --------------------------------------------------------------------------- #
# is_zero_time
# --------------------------------------------------------------------------- #

def test_is_zero_time_true_for_empty_string():
    """Empty string is considered zero time."""
    from app.services.sync_safety import is_zero_time

    assert is_zero_time("") is True


def test_is_zero_time_true_for_epoch():
    """Epoch timestamp (1970-01-01T00:00:00Z) is considered zero time."""
    from app.services.sync_safety import is_zero_time

    assert is_zero_time("1970-01-01T00:00:00Z") is True
    assert is_zero_time("1970-01-01T00:00:00.000Z") is True


def test_is_zero_time_false_for_real_timestamp():
    """A real timestamp returns False."""
    from app.services.sync_safety import is_zero_time

    assert is_zero_time("2026-07-04T10:00:00Z") is False


# --------------------------------------------------------------------------- #
# sanitize_zero_time
# --------------------------------------------------------------------------- #

def test_sanitize_zero_time_replaces_zero_with_now():
    """Zero time should be replaced with the provided now value."""
    from app.services.sync_safety import sanitize_zero_time

    result = sanitize_zero_time("", now="2026-07-04T12:00:00.000Z")
    assert result == "2026-07-04T12:00:00.000Z"


def test_sanitize_zero_time_preserves_real_timestamp():
    """Real timestamps should be returned unchanged."""
    from app.services.sync_safety import sanitize_zero_time

    real = "2026-07-04T10:00:00.000Z"
    result = sanitize_zero_time(real, now="2026-07-04T12:00:00.000Z")
    assert result == real


# --------------------------------------------------------------------------- #
# serialize_entity
# --------------------------------------------------------------------------- #

def test_serialize_entity_converts_orm_to_dict_with_tags_parsed(space_session):
    """serialize_entity should extract columns and parse tags JSON to list."""
    from app.services.sync_safety import serialize_entity
    from app.models.task import Task

    task = Task(
        id="ser-1",
        title="Serialize me",
        status="todo",
        priority="medium",
        tags='["work","urgent"]',
    )
    d = serialize_entity(task)
    assert d["id"] == "ser-1"
    assert d["title"] == "Serialize me"
    assert d["tags"] == ["work", "urgent"]


def test_serialize_entity_handles_empty_tags(space_session):
    """serialize_entity should return [] for empty tags string."""
    from app.services.sync_safety import serialize_entity
    from app.models.task import Task

    task = Task(
        id="ser-2",
        title="Empty tags",
        status="todo",
        priority="medium",
        tags="",
    )
    d = serialize_entity(task)
    assert d["tags"] == []


# --------------------------------------------------------------------------- #
# check_lww_conflict
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_check_lww_conflict_returns_local_when_local_newer(space_session):
    """If local updated_at > remote_ts, conflict resolves to 'local'."""
    from app.services.sync_safety import check_lww_conflict
    from app.models.task import Task

    local = Task(
        id="lww-1",
        title="Local",
        status="todo",
        priority="medium",
        tags="[]",
        updated_at="2026-07-04T12:00:00.000Z",
    )
    decision = check_lww_conflict(local, "2026-07-04T10:00:00.000Z")
    assert decision == "local"


@pytest.mark.asyncio
async def test_check_lww_conflict_returns_remote_when_remote_newer(space_session):
    """If remote_ts > local updated_at, conflict resolves to 'remote'."""
    from app.services.sync_safety import check_lww_conflict
    from app.models.task import Task

    local = Task(
        id="lww-2",
        title="Local",
        status="todo",
        priority="medium",
        tags="[]",
        updated_at="2026-07-04T10:00:00.000Z",
    )
    decision = check_lww_conflict(local, "2026-07-04T12:00:00.000Z")
    assert decision == "remote"
