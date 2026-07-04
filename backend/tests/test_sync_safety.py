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


def test_normalize_timestamp_truncates_microseconds_to_milliseconds():
    """Microsecond-precision (6 digits) should be truncated to 3-digit ms.

    Ensures ``2026-07-04T10:00:00.123456Z`` and ``2026-07-04T10:00:00.123Z``
    normalize to the same canonical string so lexicographic comparison
    (sync cursor) treats them as equal.
    """
    from app.services.sync_safety import normalize_timestamp

    assert normalize_timestamp("2026-07-04T10:00:00.123456Z") == "2026-07-04T10:00:00.123Z"
    assert normalize_timestamp("2026-07-04T10:00:00.999999Z") == "2026-07-04T10:00:00.999Z"


def test_normalize_timestamp_handles_plus_offset():
    """+00:00 suffix should be normalized to Z with millisecond padding."""
    from app.services.sync_safety import normalize_timestamp

    assert normalize_timestamp("2026-07-04T10:00:00+00:00") == "2026-07-04T10:00:00.000Z"


def test_normalize_timestamp_handles_no_z_suffix():
    """Bare ISO datetime (no Z) should be normalized to .000Z form."""
    from app.services.sync_safety import normalize_timestamp

    assert normalize_timestamp("2026-07-04T10:00:00") == "2026-07-04T10:00:00.000Z"


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
    from app.models.task import Task
    from app.services.sync_safety import serialize_entity

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
    from app.models.task import Task
    from app.services.sync_safety import serialize_entity

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
    from app.models.task import Task
    from app.services.sync_safety import check_lww_conflict

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
    from app.models.task import Task
    from app.services.sync_safety import check_lww_conflict

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


# --------------------------------------------------------------------------- #
# strip_client_fields (C2)
# --------------------------------------------------------------------------- #

def test_strip_client_fields_removes_generic_and_protected():
    """strip_client_fields should drop synced/_dirty/id/created_at/version."""
    from app.services.sync_safety import strip_client_fields

    data = {
        "title": "Keep",
        "synced": True,
        "_dirty": True,
        "_etag": "abc",
        "id": "client-id",
        "created_at": "2020-01-01T00:00:00.000Z",
        "version": 5,
    }
    stripped = strip_client_fields(data, "task")
    assert stripped == {"title": "Keep"}
    assert data["title"] == "Keep"  # original unchanged


def test_strip_client_fields_removes_entity_specific_task_fields():
    """Task payloads should drop actual_pomodoros."""
    from app.services.sync_safety import strip_client_fields

    stripped = strip_client_fields(
        {"title": "T", "actual_pomodoros": 3},
        "task",
    )
    assert stripped == {"title": "T"}


def test_strip_client_fields_removes_quick_note_client_fields():
    """quickNote payloads should drop archive_file_path and migrated_to_note_id."""
    from app.services.sync_safety import strip_client_fields

    stripped = strip_client_fields(
        {
            "content": "memo",
            "archive_file_path": "/tmp/x",
            "migrated_to_note_id": "n1",
        },
        "quickNote",
    )
    assert stripped == {"content": "memo"}


# --------------------------------------------------------------------------- #
# check_folder_circular_ref (C3)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_check_folder_circular_ref_self_parent(space_session):
    """Setting parent_id to self should be circular."""
    from app.services.sync_safety import check_folder_circular_ref

    fid = "folder-self"
    assert await check_folder_circular_ref(space_session, fid, fid) is True


@pytest.mark.asyncio
async def test_check_folder_circular_ref_detects_cycle_in_chain(space_session):
    """Traversing parent chain should detect when folder becomes ancestor."""
    from app.models.folder import Folder
    from app.services.sync_safety import check_folder_circular_ref

    a = Folder(id="fa", name="A", parent_id=None)
    b = Folder(id="fb", name="B", parent_id="fa")
    space_session.add_all([a, b])
    await space_session.flush()

    assert await check_folder_circular_ref(space_session, "fa", "fb") is True
    assert await check_folder_circular_ref(space_session, "fc", "fb") is False


@pytest.mark.asyncio
async def test_check_folder_circular_ref_none_parent_is_safe(space_session):
    """parent_id=None should never be circular."""
    from app.services.sync_safety import check_folder_circular_ref

    assert await check_folder_circular_ref(space_session, "any", None) is False
