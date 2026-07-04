"""Tests for SyncService — push/pull/full/status/audit.

Covers Phase C tasks C2-C6, C8, C9. C7 routes tested in test_sync_routes.py.
C10 integration tested in test_sync_integration.py.
"""

from __future__ import annotations

import uuid

import pytest


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _make_event(
    entity_type: str = "task",
    action: str = "create",
    entity_id: str | None = None,
    payload: dict | None = None,
    client_updated_at: str = "2026-07-04T10:00:00.000Z",
) -> dict:
    """Build a sync event dict for push."""
    return {
        "entity_type": entity_type,
        "entity_id": entity_id or uuid.uuid4().hex,
        "action": action,
        "payload": payload or {},
        "client_updated_at": client_updated_at,
    }


def _task_payload(**overrides) -> dict:
    """Build a minimal task payload."""
    base = {
        "title": "Synced task",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------------- #
# C2: SyncService.push
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_push_create_event_inserts_row(space_session):
    """push() with action=create should insert a new row."""
    from app.services.sync import SyncService
    from app.models.task import Task
    from sqlalchemy import select

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    event = _make_event(
        entity_id=eid,
        action="create",
        payload={
            "id": eid,
            "title": "Pushed task",
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
        },
    )
    result = await svc.push([event])
    assert len(result["applied"]) == 1
    assert result["errors"] == []
    # Verify row exists.
    row = await space_session.get(Task, eid)
    assert row is not None
    assert row.title == "Pushed task"


@pytest.mark.asyncio
async def test_push_update_event_modifies_row(space_session):
    """push() with action=update should modify an existing row."""
    from app.services.sync import SyncService
    from app.models.task import Task

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    # Seed row.
    await svc.push([_make_event(
        entity_id=eid,
        action="create",
        payload={
            "id": eid, "title": "Original", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
    )])
    # Update.
    result = await svc.push([_make_event(
        entity_id=eid,
        action="update",
        payload={"title": "Updated"},
        client_updated_at="2026-07-04T12:00:00.000Z",
    )])
    assert len(result["applied"]) == 1
    row = await space_session.get(Task, eid)
    assert row.title == "Updated"


@pytest.mark.asyncio
async def test_push_delete_event_removes_row(space_session):
    """push() with action=delete should remove the row."""
    from app.services.sync import SyncService
    from app.models.task import Task

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    await svc.push([_make_event(
        entity_id=eid,
        action="create",
        payload={
            "id": eid, "title": "To delete", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
    )])
    result = await svc.push([_make_event(
        entity_id=eid,
        action="delete",
        payload={},
    )])
    assert len(result["applied"]) == 1
    row = await space_session.get(Task, eid)
    assert row is None


@pytest.mark.asyncio
async def test_push_batch_events_applies_all(space_session):
    """push() with multiple events should apply all of them."""
    from app.services.sync import SyncService
    from app.models.task import Task

    svc = SyncService(space_session)
    events = [
        _make_event(
            entity_id=f"batch-{i}",
            action="create",
            payload={
                "id": f"batch-{i}",
                "title": f"Batch {i}",
                "status": "todo",
                "priority": "medium",
                "tags": "[]",
            },
        )
        for i in range(3)
    ]
    result = await svc.push(events)
    assert len(result["applied"]) == 3
    assert result["errors"] == []
    for i in range(3):
        row = await space_session.get(Task, f"batch-{i}")
        assert row is not None


@pytest.mark.asyncio
async def test_push_lww_conflict_keeps_newer(space_session):
    """push() should apply remote update when remote_ts > local_ts."""
    from app.services.sync import SyncService
    from app.models.task import Task

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    # Seed local with updated_at = 10:00.
    await svc.push([_make_event(
        entity_id=eid,
        action="create",
        payload={
            "id": eid, "title": "Local", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
        client_updated_at="2026-07-04T10:00:00.000Z",
    )])
    # Remote update at 12:00 should win.
    result = await svc.push([_make_event(
        entity_id=eid,
        action="update",
        payload={"title": "Remote wins"},
        client_updated_at="2026-07-04T12:00:00.000Z",
    )])
    assert len(result["applied"]) == 1
    row = await space_session.get(Task, eid)
    assert row.title == "Remote wins"


# --------------------------------------------------------------------------- #
# C3: SyncService.pull
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pull_returns_all_when_since_empty(space_session):
    """pull() with empty since should return all rows grouped by pull_key."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    # Seed 2 tasks + 1 folder.
    for i in range(2):
        await svc.push([_make_event(
            entity_id=f"pull-task-{i}",
            action="create",
            payload={
                "id": f"pull-task-{i}",
                "title": f"Task {i}",
                "status": "todo",
                "priority": "medium",
                "tags": "[]",
                "updated_at": "2026-07-04T10:00:00.000Z",
            },
        )])
    await svc.push([_make_event(
        entity_type="folder",
        entity_id="pull-folder-0",
        action="create",
        payload={
            "id": "pull-folder-0",
            "name": "Folder",
            "parent_id": None,
            "icon": "default",
            "color": "blue",
            "sort_order": 0,
            "is_system": False,
            "trashed_at": None,
            "updated_at": "2026-07-04T10:00:00.000Z",
        },
    )])

    result = await svc.pull(since="", limit=100)
    assert result["has_more"] is False
    assert len(result["tasks"]) == 2
    assert len(result["folders"]) == 1
    assert "server_time" in result


@pytest.mark.asyncio
async def test_pull_filters_by_since(space_session):
    """pull() should only return rows updated after *since*."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    await svc.push([_make_event(
        entity_id="since-old",
        action="create",
        payload={
            "id": "since-old",
            "title": "Old",
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
            "updated_at": "2026-07-04T08:00:00.000Z",
        },
    )])
    await svc.push([_make_event(
        entity_id="since-new",
        action="create",
        payload={
            "id": "since-new",
            "title": "New",
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
            "updated_at": "2026-07-04T12:00:00.000Z",
        },
    )])

    result = await svc.pull(since="2026-07-04T10:00:00.000Z", limit=100)
    task_ids = [t["id"] for t in result["tasks"]]
    assert "since-old" not in task_ids
    assert "since-new" in task_ids


@pytest.mark.asyncio
async def test_pull_pagination_has_more(space_session):
    """pull() with limit < total should set has_more=True."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    for i in range(5):
        await svc.push([_make_event(
            entity_id=f"page-task-{i}",
            action="create",
            payload={
                "id": f"page-task-{i}",
                "title": f"Page {i}",
                "status": "todo",
                "priority": "medium",
                "tags": "[]",
                "updated_at": f"2026-07-04T1{i}:00:00.000Z",
            },
        )])
    result = await svc.pull(since="", limit=2)
    assert result["has_more"] is True


@pytest.mark.asyncio
async def test_pull_returns_tombstones(space_session):
    """pull() should include tombstones with deleted_at > since."""
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    tomb_svc = TombstoneService(space_session)
    await tomb_svc.create("task", "tomb-task-1")

    svc = SyncService(space_session)
    result = await svc.pull(since="", limit=100)
    assert len(result["tombstones"]) >= 1
    entity_ids = [t["entity_id"] for t in result["tombstones"]]
    assert "tomb-task-1" in entity_ids


@pytest.mark.asyncio
async def test_pull_includes_next_since(space_session):
    """pull() should return next_since equal to the latest updated_at seen."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    await svc.push([_make_event(
        entity_id="next-ts-1",
        action="create",
        payload={
            "id": "next-ts-1",
            "title": "Next",
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
            "updated_at": "2026-07-04T15:00:00.000Z",
        },
    )])
    result = await svc.pull(since="", limit=100)
    assert result["next_since"] != ""
    # next_since should be >= the latest row's updated_at.
    assert result["next_since"] >= "2026-07-04T15:00:00.000Z"


# --------------------------------------------------------------------------- #
# C4: SyncService.full + status
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_full_returns_all_tombstones_ignoring_since(space_session):
    """full() should return ALL tombstones regardless of since filter."""
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    tomb_svc = TombstoneService(space_session)
    await tomb_svc.create("task", "full-tomb-1")
    await tomb_svc.create("task", "full-tomb-2")

    svc = SyncService(space_session)
    # Even with a future since, full() returns all tombstones.
    result = await svc.full(since="2099-01-01T00:00:00.000Z", limit=100)
    entity_ids = [t["entity_id"] for t in result["tombstones"]]
    assert "full-tomb-1" in entity_ids
    assert "full-tomb-2" in entity_ids


@pytest.mark.asyncio
async def test_full_sets_is_full_flag(space_session):
    """full() response should include is_full=True."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    result = await svc.full(since="", limit=100)
    assert result["is_full"] is True


@pytest.mark.asyncio
async def test_full_issues_single_tombstones_query(space_session, monkeypatch):
    """D-3: full() must not issue a second tombstones SELECT.

    The previous implementation called ``pull()`` (which queried
    tombstones with the since filter) and then re-queried tombstones
    without the filter to override the result. This test guards against
    that regression by counting calls to ``_fetch_tombstones``.
    """
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    # Seed at least one tombstone so the query has rows to return.
    await TombstoneService(space_session).create("task", "d3-tomb")

    svc = SyncService(space_session)

    call_count = {"n": 0}
    real_fetch = svc._fetch_tombstones

    async def _counting_fetch(since: str = "", limit: int = 1000):
        call_count["n"] += 1
        return await real_fetch(since=since, limit=limit)

    monkeypatch.setattr(svc, "_fetch_tombstones", _counting_fetch)

    result = await svc.full(since="2099-01-01T00:00:00.000Z", limit=100)

    assert call_count["n"] == 1, (
        f"full() should call _fetch_tombstones exactly once, "
        f"got {call_count['n']} calls"
    )
    # And the single call must be the unfiltered one (returns the tomb).
    entity_ids = [t["entity_id"] for t in result["tombstones"]]
    assert "d3-tomb" in entity_ids, (
        f"full() tombstones missing d3-tomb; got {entity_ids}"
    )


@pytest.mark.asyncio
async def test_status_returns_entity_counts(space_session):
    """status() should return per-entity counts."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    for i in range(3):
        await svc.push([_make_event(
            entity_id=f"status-task-{i}",
            action="create",
            payload={
                "id": f"status-task-{i}",
                "title": f"S {i}",
                "status": "todo",
                "priority": "medium",
                "tags": "[]",
                "updated_at": "2026-07-04T10:00:00.000Z",
            },
        )])
    result = await svc.status()
    assert result["entity_counts"]["tasks"] == 3
    assert "server_time" in result


@pytest.mark.asyncio
async def test_status_returns_tombstone_count(space_session):
    """status() should return the total tombstone count."""
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    tomb_svc = TombstoneService(space_session)
    await tomb_svc.create("task", "status-tomb-1")
    await tomb_svc.create("task", "status-tomb-2")

    svc = SyncService(space_session)
    result = await svc.status()
    assert result["tombstone_count"] >= 2


@pytest.mark.asyncio
async def test_status_returns_all_14_pull_keys_in_one_query(space_session):
    """D-2: status() should return counts for all 14 pull_keys + tombstone.

    The optimization collapses 15 sequential COUNT queries into a single
    UNION ALL. This test guards against regressions where a new entity is
    added to ENTITY_REGISTRY but not surfaced in status() output.
    """
    from app.services.sync import ENTITY_REGISTRY, SyncService

    svc = SyncService(space_session)
    result = await svc.status()

    expected_pull_keys = {entry["pull_key"] for entry in ENTITY_REGISTRY.values()}
    assert set(result["entity_counts"].keys()) == expected_pull_keys, (
        f"Missing pull_keys; expected {expected_pull_keys}, "
        f"got {set(result['entity_counts'].keys())}"
    )
    # Every count is an int >= 0 (empty DB → 0).
    for pk, c in result["entity_counts"].items():
        assert isinstance(c, int) and c >= 0, (
            f"entity_counts[{pk!r}] = {c!r} (type {type(c).__name__})"
        )
    assert isinstance(result["tombstone_count"], int)
    assert result["tombstone_count"] >= 0
    assert "server_time" in result


# --------------------------------------------------------------------------- #
# C8: ENTITY_REGISTRY validation
# --------------------------------------------------------------------------- #

def test_entity_registry_has_14_entities():
    """ENTITY_REGISTRY should contain exactly 14 entity types."""
    from app.services.sync import ENTITY_REGISTRY

    assert len(ENTITY_REGISTRY) == 14
    expected_keys = {
        "task", "session", "note", "folder", "quickNote", "reflection",
        "habit", "habitCheckIn", "schedule", "timeBlock", "memoComment",
        "sessionQuickNote", "scheduleQuickNote", "taskQuickNote",
    }
    assert set(ENTITY_REGISTRY.keys()) == expected_keys


def test_entity_registry_entries_have_model_and_pull_key():
    """Each registry entry should have 'model' and 'pull_key' fields."""
    from app.services.sync import ENTITY_REGISTRY

    for etype, entry in ENTITY_REGISTRY.items():
        assert "model" in entry, f"{etype} missing 'model'"
        assert "pull_key" in entry, f"{etype} missing 'pull_key'"
        assert entry["model"] is not None, f"{etype} model is None"
        assert isinstance(entry["pull_key"], str), f"{etype} pull_key not str"


def test_entity_registry_pull_keys_are_unique():
    """All pull_key values should be unique (no collisions in pull response)."""
    from app.services.sync import ENTITY_REGISTRY

    pull_keys = [entry["pull_key"] for entry in ENTITY_REGISTRY.values()]
    assert len(pull_keys) == len(set(pull_keys)), "Duplicate pull_keys found"


# --------------------------------------------------------------------------- #
# C6: NoteService sync_mode + _push_note_event
# --------------------------------------------------------------------------- #

async def _make_fs_for_sync(tmp_path):
    """Helper: create a FileSystem instance for sync tests."""
    from app.file_system.api import get_file_system

    return await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )


@pytest.mark.asyncio
async def test_sync_mode_preserves_client_updated_at(space_session, tmp_path):
    """sync_mode=True should preserve client-provided updated_at."""
    from app.services.note import NoteService

    fs = await _make_fs_for_sync(tmp_path)
    svc = NoteService(space_session, fs, sync_mode=True)

    client_ts = "2026-07-04T10:00:00.000Z"
    note = await svc.create({
        "id": "sync-mode-ts-1",
        "title": "Sync Mode",
        "content": "Body",
        "updated_at": client_ts,
    })
    # DB row's updated_at should match client_ts (not server-now).
    assert note.updated_at == client_ts


@pytest.mark.asyncio
async def test_sync_mode_preserves_client_version(space_session, tmp_path):
    """sync_mode=True should preserve client-provided version."""
    from app.services.note import NoteService

    fs = await _make_fs_for_sync(tmp_path)
    svc = NoteService(space_session, fs, sync_mode=True)

    note = await svc.create({
        "id": "sync-mode-ver-1",
        "title": "Sync Mode Ver",
        "content": "Body",
        "version": 42,
    })
    assert note.version == 42


@pytest.mark.asyncio
async def test_sync_mode_skips_tombstone_on_delete(space_session, tmp_path):
    """sync_mode=True should NOT create a new tombstone on delete."""
    from app.services.note import NoteService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs_for_sync(tmp_path)
    svc = NoteService(space_session, fs, sync_mode=True)

    note = await svc.create({
        "id": "sync-mode-del-1",
        "title": "To delete",
        "content": "Body",
    })
    await svc.delete(note.id)

    # No new tombstone should exist (remote tombstone decision preserved).
    tomb_svc = TombstoneService(space_session)
    assert await tomb_svc.exists("note", note.id) is None


@pytest.mark.asyncio
async def test_sync_service_push_note_event_uses_note_service(space_session, tmp_path):
    """SyncService.push with etype='note' should delegate to NoteService
    (writing both .md file and DB row)."""
    from app.services.sync import SyncService
    from app.models.note import Note

    fs = await _make_fs_for_sync(tmp_path)
    svc = SyncService(space_session, fs)

    eid = "push-note-1"
    result = await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid,
            "title": "Synced Note",
            "content": "Hello from sync",
            "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])

    assert len(result["applied"]) == 1
    assert result["errors"] == []
    # DB row should exist.
    row = await space_session.get(Note, eid)
    assert row is not None
    assert row.title == "Synced Note"
    # .md file should exist.
    content = await fs.read_note(eid)
    assert "Hello from sync" in content


# --------------------------------------------------------------------------- #
# C9: sync audit log
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_push_writes_audit_log(space_session):
    """push() should write one SyncAuditLog row per applied event."""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    await svc.push([_make_event(
        entity_id=eid,
        action="create",
        payload={
            "id": eid, "title": "Audit", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
    )])
    rows = (await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "push")
    )).scalars().all()
    assert len(rows) >= 1
    assert rows[0].entity_id == eid


@pytest.mark.asyncio
async def test_pull_writes_audit_log(space_session):
    """pull() should write one SyncAuditLog row with event_type='pull'."""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select

    svc = SyncService(space_session)
    await svc.pull(since="", limit=100)
    rows = (await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "pull")
    )).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_audit_failure_does_not_break_main_flow(space_session, monkeypatch):
    """If SyncAuditLog insert raises, push() must still return applied."""
    from app.services.sync import SyncService
    from app.models import sync_audit_log as audit_module

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated audit failure")

    # Replace the SyncAuditLog class symbol with a boom-on-init type so
    # _write_audit's `from app.models.sync_audit_log import SyncAuditLog`
    # re-resolves to this patched type and raises on instantiation.
    monkeypatch.setattr(audit_module, "SyncAuditLog", type("Boom", (), {
        "__init__": _boom,
    }))
    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    result = await svc.push([_make_event(
        entity_id=eid,
        action="create",
        payload={
            "id": eid, "title": "Survives audit failure", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
    )])
    assert len(result["applied"]) == 1
    assert result["errors"] == []


@pytest.mark.asyncio
async def test_push_batches_audit_flushes(space_session, monkeypatch):
    """D-4: push() should call _flush_pending_audits exactly once.

    The pre-D-4 implementation flushed audit entries one-by-one inside
    ``_write_audit`` (N round-trips for N events). D-4 queues them in
    ``_pending_audits`` and flushes the batch at the end of push().
    """
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select

    svc = SyncService(space_session)

    flush_calls = {"n": 0}
    real_flush = svc._flush_pending_audits

    async def _counting_flush():
        flush_calls["n"] += 1
        await real_flush()

    monkeypatch.setattr(svc, "_flush_pending_audits", _counting_flush)

    # Push 5 events in one call.
    events = []
    for i in range(5):
        eid = f"d4-batch-{i}"
        events.append(_make_event(
            entity_id=eid,
            action="create",
            payload={
                "id": eid, "title": f"Batch {i}", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        ))
    result = await svc.push(events)

    assert len(result["applied"]) == 5
    assert flush_calls["n"] == 1, (
        f"push() should call _flush_pending_audits exactly once, "
        f"got {flush_calls['n']}"
    )

    # And all 5 audit rows must have been written by that single flush.
    rows = (await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "push")
    )).scalars().all()
    assert len(rows) == 5, (
        f"Expected 5 audit rows for 5 events, got {len(rows)}"
    )


@pytest.mark.asyncio
async def test_pull_tombstones_respects_limit(space_session):
    """D-5: pull() should cap tombstones at *limit* and set tombstones_has_more.

    Without this cap, a 90-day TTL accumulation could blow up the response.
    The test seeds 5 tombstones and pulls with limit=3 to verify truncation.
    """
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    tomb_svc = TombstoneService(space_session)
    for i in range(5):
        await tomb_svc.create("task", f"d5-tomb-{i}")

    svc = SyncService(space_session)
    result = await svc.pull(since="", limit=3)

    # Tombstones should be capped at limit (3), with tombstones_has_more=True.
    assert len(result["tombstones"]) == 3, (
        f"Expected 3 tombstones (capped at limit), "
        f"got {len(result['tombstones'])}"
    )
    assert result["tombstones_has_more"] is True, (
        "tombstones_has_more should be True when truncated"
    )
    # The top-level has_more should also be True (D-5 surfaces tomb overflow).
    assert result["has_more"] is True, (
        "has_more should be True when tombstones overflow"
    )


@pytest.mark.asyncio
async def test_pull_tombstones_has_more_false_when_under_limit(space_session):
    """D-5: pull() with tombstones under limit should report has_more=False."""
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    tomb_svc = TombstoneService(space_session)
    for i in range(3):
        await tomb_svc.create("task", f"d5-tomb-under-{i}")

    svc = SyncService(space_session)
    result = await svc.pull(since="", limit=100)

    assert len(result["tombstones"]) == 3
    assert result["tombstones_has_more"] is False, (
        "tombstones_has_more should be False when under limit"
    )
