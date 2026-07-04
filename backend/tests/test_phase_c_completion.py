"""Phase C completion tests — closing the test-coverage gaps identified by audit.

Audit found these gaps (P1/P2):
- P1: 6 entities (session/habit/reflection/schedule/timeBlock/quickNote)
       REST DELETE → pull tombstone — only task had integration coverage
- P1: push note delete → tombstone + pull — only create was tested
- P2: BaseService.delete + entity_type → tombstone — no unit test
- P2: HTTP-level tombstone conflict (create/update after delete)

This file closes all four gaps. No code changes needed — the implementation
is correct; these tests provide regression proof.
"""
from __future__ import annotations

import uuid

import pytest


# --------------------------------------------------------------------------- #
# Shared HTTP helpers (mirror test_sync_integration.py patterns)
# --------------------------------------------------------------------------- #

async def _setup_login_and_space_token(client) -> str:
    """Setup admin, login, create a space, return a space token."""
    resp = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert resp.status_code in (200, 201)
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert resp.status_code == 200
    master_token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post(
        "/api/v1/spaces", json={"name": "Phase C Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    return resp.json()["space_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# Minimal create payloads for each entity type (matching schema requirements).
_CREATE_PAYLOADS: dict[str, dict] = {
    "sessions": {"type": "work", "duration": 25, "completed": True, "started_at": "2026-07-04T10:00:00Z"},
    "habits": {"title": "Test Habit"},
    "reflections": {"date": "2026-07-04", "content": "Test reflection"},
    "schedules": {"title": "Test Schedule", "due_at": "2099-01-01T10:00:00Z"},
    "time-blocks": {"title": "Test Block", "date": "2026-07-04", "start_time": "10:00", "end_time": "11:00"},
    "quick-notes": {"content": "Test quick note"},
}

# Maps URL path segment → (sync entity_type, sync pull_key).
_ENTITY_INFO: dict[str, tuple[str, str]] = {
    "sessions": ("session", "sessions"),
    "habits": ("habit", "habits"),
    "reflections": ("reflection", "reflections"),
    "schedules": ("schedule", "schedules"),
    "time-blocks": ("timeBlock", "timeBlocks"),
    "quick-notes": ("quickNote", "quickNotes"),
}


# --------------------------------------------------------------------------- #
# P1: Parametrized 6-entity REST DELETE → pull tombstone
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("route_segment", list(_ENTITY_INFO.keys()))
@pytest.mark.asyncio
async def test_rest_delete_writes_tombstone_visible_in_pull(client, route_segment):
    """REST DELETE on each of the 6 entities should write a tombstone that
    is visible in a subsequent sync pull.

    This is the parametrized regression test that closes the P1 gap:
    only task had this coverage before; now session/habit/reflection/
    schedule/timeBlock/quickNote all have it.
    """
    entity_type, pull_key = _ENTITY_INFO[route_segment]
    token = await _setup_login_and_space_token(client)
    h = _headers(token)

    # 1. Create entity via REST POST.
    resp = await client.post(
        f"/api/v1/{route_segment}",
        json=_CREATE_PAYLOADS[route_segment],
        headers=h,
    )
    assert resp.status_code == 201, f"CREATE failed: {resp.text}"
    entity_id = resp.json()["id"]

    # 2. Delete via REST DELETE.
    resp = await client.delete(f"/api/v1/{route_segment}/{entity_id}", headers=h)
    assert resp.status_code in (200, 204), f"DELETE failed: {resp.text}"

    # 3. Pull — tombstone must be present.
    resp = await client.get("/api/v1/sync/pull?since=&limit=100", headers=h)
    assert resp.status_code == 200
    data = resp.json()

    tomb_ids = [t["entity_id"] for t in data["tombstones"]]
    assert entity_id in tomb_ids, (
        f"Tombstone for {entity_type} '{entity_id}' not found in pull. "
        f"Tombstones: {tomb_ids}"
    )

    # 4. Verify the entity row is gone from pull results.
    row_ids = [r["id"] for r in data.get(pull_key, [])]
    assert entity_id not in row_ids, (
        f"{entity_type} '{entity_id}' should be deleted but still in pull.{pull_key}"
    )

    # 5. Verify tombstone entity_type matches.
    tomb_entry = next(t for t in data["tombstones"] if t["entity_id"] == entity_id)
    assert tomb_entry["entity_type"] == entity_type, (
        f"Tombstone entity_type mismatch: expected '{entity_type}', "
        f"got '{tomb_entry['entity_type']}'"
    )


# --------------------------------------------------------------------------- #
# P1: push note delete → tombstone + pull (service layer with fs fixture)
# --------------------------------------------------------------------------- #

async def _make_fs_for_sync(tmp_path):
    """Helper: create a FileSystem instance for sync tests."""
    from app.file_system.api import get_file_system

    return await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )


@pytest.mark.asyncio
async def test_push_note_delete_writes_tombstone_and_pull_returns_it(space_session, tmp_path):
    """push(note, delete) should write a tombstone via sync layer (not NoteService)
    and the tombstone must be visible in pull.

    Closes P1 gap: the existing note sync test only covered create.
    This verifies the _push_note_event delete path (sync.py:375-380) where
    NoteService(sync_mode=True).delete() skips tombstone and the sync layer
   补写 it.
    """
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs_for_sync(tmp_path)
    svc = SyncService(space_session, fs)
    eid = "push-note-delete-1"

    # 1. push create note.
    result = await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid,
            "title": "Will be deleted via push",
            "content": "Goodbye world",
            "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert result["errors"] == []

    # 2. push delete note.
    result = await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "delete",
        "payload": {},
        "client_updated_at": "2026-07-04T12:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert result["errors"] == []

    # 3. Tombstone must exist.
    tomb = await TombstoneService(space_session).exists("note", eid)
    assert tomb is not None, "Tombstone not written for push note delete"
    assert tomb.entity_type == "note"
    assert tomb.entity_id == eid

    # 4. Pull must return the tombstone.
    pull_result = await svc.pull(since="", limit=100)
    tomb_ids = [t["entity_id"] for t in pull_result["tombstones"]]
    assert eid in tomb_ids, "Tombstone not visible in pull after push note delete"

    # 5. Note must not appear in pull notes list.
    note_ids = [n["id"] for n in pull_result.get("notes", [])]
    assert eid not in note_ids, "Deleted note still appears in pull"


# --------------------------------------------------------------------------- #
# P2: BaseService.delete + entity_type → tombstone (unit test)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_base_service_delete_writes_tombstone_when_entity_type_set(space_session):
    """BaseService.delete should create a tombstone when entity_type is set.

    Closes P2 gap: existing test_base_service.py uses a TaskService without
    entity_type, so the _ensure_tombstone mechanism was never unit-tested.
    """
    from app.services.base import BaseService
    from app.services.tombstone import TombstoneService
    from app.models.task import Task

    class SyncedTaskService(BaseService):
        model = Task
        entity_type = "task"

    svc = SyncedTaskService(space_session)
    task_id = uuid.uuid4().hex
    await svc.create({
        "id": task_id,
        "title": "Will be tombstoned",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })

    # Delete — should write tombstone because entity_type is set.
    await svc.delete(task_id)

    tomb = await TombstoneService(space_session).exists("task", task_id)
    assert tomb is not None, "Tombstone not created by BaseService.delete"
    assert tomb.entity_type == "task"
    assert tomb.entity_id == task_id


@pytest.mark.asyncio
async def test_base_service_delete_skips_tombstone_when_entity_type_unset(space_session):
    """BaseService.delete should NOT create a tombstone when entity_type is None.

    Ensures the entity_type guard works both ways — only sync-participating
    entities get tombstones.
    """
    from app.services.base import BaseService
    from app.services.tombstone import TombstoneService
    from app.models.task import Task

    class PlainTaskService(BaseService):
        model = Task
        # entity_type intentionally unset (None)

    svc = PlainTaskService(space_session)
    task_id = uuid.uuid4().hex
    await svc.create({
        "id": task_id,
        "title": "No tombstone",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    await svc.delete(task_id)

    tomb = await TombstoneService(space_session).exists("task", task_id)
    assert tomb is None, "Tombstone should not be created when entity_type is None"


# --------------------------------------------------------------------------- #
# P2: HTTP-level tombstone conflict (create/update after delete)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_http_push_after_rest_delete_returns_tombstone_conflict(client):
    """REST delete a task → push create with same id → conflict resolution=tombstone.

    Closes P2 gap: service-layer tombstone conflict was tested but not the
    HTTP-level roundtrip through /api/v1/sync/push.
    """
    token = await _setup_login_and_space_token(client)
    h = _headers(token)

    # 1. Create task via REST.
    resp = await client.post(
        "/api/v1/tasks",
        json={"title": "To be deleted"},
        headers=h,
    )
    assert resp.status_code == 201
    task_id = resp.json()["id"]

    # 2. Delete via REST (writes tombstone).
    resp = await client.delete(f"/api/v1/tasks/{task_id}", headers=h)
    assert resp.status_code in (200, 204)

    # 3. push create with same id → should get conflict_tombstone.
    resp = await client.post(
        "/api/v1/sync/push",
        json={"events": [{
            "entity_type": "task",
            "entity_id": task_id,
            "action": "create",
            "payload": {
                "id": task_id,
                "title": "Resurrected",
                "status": "todo",
                "priority": "medium",
                "tags": "[]",
            },
            "client_updated_at": "2026-07-04T15:00:00.000Z",
        }]},
        headers=h,
    )
    assert resp.status_code == 200
    data = resp.json()
    tombstone_conflicts = [
        c for c in data["conflicts"] if c.get("resolution") == "tombstone"
    ]
    assert len(tombstone_conflicts) == 1, (
        f"Expected 1 tombstone conflict, got: {data['conflicts']}"
    )
    assert tombstone_conflicts[0]["entity_id"] == task_id


@pytest.mark.asyncio
async def test_http_push_update_after_rest_delete_returns_tombstone_conflict(client):
    """REST delete a task → push update (upsert) with same id → conflict_tombstone.

    Tests the upsert path: when row is missing but tombstone exists, update
    must not recreate the row.
    """
    token = await _setup_login_and_space_token(client)
    h = _headers(token)

    # 1. Create + delete via REST.
    resp = await client.post(
        "/api/v1/tasks",
        json={"title": "Gone"},
        headers=h,
    )
    task_id = resp.json()["id"]
    await client.delete(f"/api/v1/tasks/{task_id}", headers=h)

    # 2. push update with same id.
    resp = await client.post(
        "/api/v1/sync/push",
        json={"events": [{
            "entity_type": "task",
            "entity_id": task_id,
            "action": "update",
            "payload": {"title": "Resurrected via update"},
            "client_updated_at": "2026-07-04T15:00:00.000Z",
        }]},
        headers=h,
    )
    assert resp.status_code == 200
    data = resp.json()
    tombstone_conflicts = [
        c for c in data["conflicts"] if c.get("resolution") == "tombstone"
    ]
    assert len(tombstone_conflicts) == 1

    # 3. Verify task was NOT recreated.
    resp = await client.get(f"/api/v1/tasks/{task_id}", headers=h)
    assert resp.status_code == 404, "Task should not be resurrected"


# --------------------------------------------------------------------------- #
# P2: strip_client_fields — explicit version-not-overwritten test
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_push_update_does_not_overwrite_version_from_client(space_session):
    """push update with version=N should not overwrite DB version.

    The client may send version in the payload; strip_client_fields must
    remove it so the server-side version counter is authoritative.
    """
    from app.services.sync import SyncService
    from app.models.task import Task

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex

    # Create with version=1.
    await svc.push([{
        "entity_type": "task",
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid, "title": "V1", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    row = await space_session.get(Task, eid)
    assert row.version == 1

    # Update with version=999 in payload — must be stripped.
    await svc.push([{
        "entity_type": "task",
        "entity_id": eid,
        "action": "update",
        "payload": {"title": "V2", "version": 999},
        "client_updated_at": "2026-07-04T12:00:00.000Z",
    }])
    row = await space_session.get(Task, eid)
    assert row.title == "V2"
    assert row.version == 2, (
        f"version should be 2 (server-incremented), not {row.version}"
    )
