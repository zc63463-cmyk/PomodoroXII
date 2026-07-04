"""End-to-end sync integration tests (Phase C C10).

Tests the full sync flow across HTTP layer + Service layer + DB layer:
- POST /api/v1/sync/push
- GET  /api/v1/sync/pull
- GET  /api/v1/sync/full
- GET  /api/v1/sync/status

Auth: each test sets up admin, logs in, creates a space, and issues a
space token via _setup_login_and_space_token.
"""
from __future__ import annotations

import uuid

import pytest


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
        "/api/v1/spaces", json={"name": "Integration Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    return resp.json()["space_token"]


def _make_event(
    entity_type: str = "task",
    action: str = "create",
    entity_id: str | None = None,
    payload: dict | None = None,
    client_updated_at: str = "2026-07-04T10:00:00.000Z",
) -> dict:
    return {
        "entity_type": entity_type,
        "entity_id": entity_id or uuid.uuid4().hex,
        "action": action,
        "payload": payload or {},
        "client_updated_at": client_updated_at,
    }


async def _push(client, headers, events):
    """Helper: POST /sync/push and return JSON."""
    resp = await client.post(
        "/api/v1/sync/push", json={"events": events}, headers=headers
    )
    assert resp.status_code == 200, f"push failed: {resp.text}"
    return resp.json()


# --------------------------------------------------------------------------- #
# C10: end-to-end sync integration
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_full_sync_roundtrip_create_pull(client):
    """push 1 task → pull returns it → next_since advances."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    await _push(client, headers, [
        _make_event(
            entity_id=eid, action="create",
            payload={
                "id": eid, "title": "Roundtrip Task", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
            client_updated_at="2026-07-04T10:00:00.000Z",
        )
    ])

    # Initial pull returns the task.
    resp = await client.get(
        "/api/v1/sync/pull?since=&limit=100", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    task_ids = [t["id"] for t in data["tasks"]]
    assert eid in task_ids
    first_next_since = data["next_since"]
    assert first_next_since >= "2026-07-04T10:00:00.000Z"

    # Pull with since=first_next_since should not return the task again.
    resp = await client.get(
        f"/api/v1/sync/pull?since={first_next_since}&limit=100",
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    task_ids = [t["id"] for t in data["tasks"]]
    assert eid not in task_ids


@pytest.mark.asyncio
async def test_full_sync_roundtrip_update_lww(client):
    """push create → push update (newer ts) → pull reflects new title."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    await _push(client, headers, [
        _make_event(
            entity_id=eid, action="create",
            payload={
                "id": eid, "title": "Original", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
            client_updated_at="2026-07-04T10:00:00.000Z",
        )
    ])
    # Newer update at 12:00 should overwrite.
    await _push(client, headers, [
        _make_event(
            entity_id=eid, action="update",
            payload={"title": "Updated Title"},
            client_updated_at="2026-07-04T12:00:00.000Z",
        )
    ])

    resp = await client.get("/api/v1/sync/pull?since=&limit=100", headers=headers)
    data = resp.json()
    tasks = {t["id"]: t for t in data["tasks"]}
    assert tasks[eid]["title"] == "Updated Title"


@pytest.mark.asyncio
async def test_sync_roundtrip_delete_via_task_route_creates_tombstone(client):
    """Create task via push → delete via task route → pull returns tombstone."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    await _push(client, headers, [
        _make_event(
            entity_id=eid, action="create",
            payload={
                "id": eid, "title": "Will be deleted", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        )
    ])
    # Delete via task route (writes tombstone).
    resp = await client.delete(f"/api/v1/tasks/{eid}", headers=headers)
    assert resp.status_code in (200, 204)

    resp = await client.get("/api/v1/sync/pull?since=&limit=100", headers=headers)
    data = resp.json()
    tomb_ids = [t["entity_id"] for t in data["tombstones"]]
    assert eid in tomb_ids
    # Task row should be gone from pull results.
    task_ids = [t["id"] for t in data["tasks"]]
    assert eid not in task_ids


@pytest.mark.asyncio
async def test_sync_roundtrip_delete_via_push_writes_tombstone(client):
    """Create task via push → delete via push → pull returns tombstone."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    await _push(client, headers, [
        _make_event(
            entity_id=eid, action="create",
            payload={
                "id": eid, "title": "Will be deleted", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        )
    ])
    await _push(client, headers, [
        _make_event(entity_id=eid, action="delete", payload={}),
    ])

    resp = await client.get("/api/v1/sync/pull?since=&limit=100", headers=headers)
    data = resp.json()
    tomb_ids = [t["entity_id"] for t in data["tombstones"]]
    assert eid in tomb_ids
    task_ids = [t["id"] for t in data["tasks"]]
    assert eid not in task_ids


@pytest.mark.asyncio
async def test_sync_status_reflects_pushed_events(client):
    """push 3 tasks → status returns tasks=3."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    events = [
        _make_event(
            entity_id=f"status-task-{i}", action="create",
            payload={
                "id": f"status-task-{i}", "title": f"S{i}", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        )
        for i in range(3)
    ]
    await _push(client, headers, events)

    resp = await client.get("/api/v1/sync/status", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["entity_counts"]["tasks"] == 3
    assert data["tombstone_count"] == 0


@pytest.mark.asyncio
async def test_sync_full_returns_all_tombstones_ignoring_since(client):
    """2 tombstones created → full(since=future) returns both."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    tomb_ids = []
    for i in range(2):
        resp = await client.post(
            "/api/v1/tasks",
            json={"title": f"To tombstone {i}"},
            headers=headers,
        )
        assert resp.status_code == 201
        tid = resp.json()["id"]
        resp = await client.delete(f"/api/v1/tasks/{tid}", headers=headers)
        assert resp.status_code in (200, 204)
        tomb_ids.append(tid)

    resp = await client.get(
        "/api/v1/sync/full?since=2099-01-01T00:00:00.000Z", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    returned_ids = {t["entity_id"] for t in data["tombstones"]}
    for tid in tomb_ids:
        assert tid in returned_ids
    assert data["is_full"] is True


@pytest.mark.asyncio
async def test_sync_handles_mixed_batch(client):
    """A single push batch with create + update + delete applies all."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    # Seed two tasks first.
    keep_id = uuid.uuid4().hex
    update_id = uuid.uuid4().hex
    delete_id = uuid.uuid4().hex
    await _push(client, headers, [
        _make_event(
            entity_id=keep_id, action="create",
            payload={
                "id": keep_id, "title": "Keep", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        ),
        _make_event(
            entity_id=update_id, action="create",
            payload={
                "id": update_id, "title": "Update Me", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        ),
        _make_event(
            entity_id=delete_id, action="create",
            payload={
                "id": delete_id, "title": "Delete Me", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
        ),
    ])

    # Mixed batch: 1 update + 1 delete + 1 create.
    new_id = uuid.uuid4().hex
    data = await _push(client, headers, [
        _make_event(
            entity_id=update_id, action="update",
            payload={"title": "Updated in mixed batch"},
            client_updated_at="2026-07-04T15:00:00.000Z",
        ),
        _make_event(entity_id=delete_id, action="delete"),
        _make_event(
            entity_id=new_id, action="create",
            payload={
                "id": new_id, "title": "New in mixed batch", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
            client_updated_at="2026-07-04T15:00:00.000Z",
        ),
    ])
    assert len(data["applied"]) == 3
    assert data["errors"] == []

    # Verify final state via pull.
    resp = await client.get("/api/v1/sync/pull?since=&limit=100", headers=headers)
    data = resp.json()
    tasks = {t["id"]: t for t in data["tasks"]}
    assert tasks[update_id]["title"] == "Updated in mixed batch"
    assert delete_id not in tasks
    assert new_id in tasks


@pytest.mark.asyncio
async def test_sync_push_unknown_entity_returns_error(client):
    """push entity_type='invalid' → errors contains the event."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    data = await _push(client, headers, [
        _make_event(
            entity_type="invalidEntity", entity_id="x", action="create",
            payload={"id": "x"},
        )
    ])
    assert len(data["errors"]) == 1
    assert data["errors"][0]["entity_type"] == "invalidEntity"
    assert data["applied"] == []


@pytest.mark.asyncio
async def test_sync_pagination_has_more(client):
    """push 5 tasks → pull(limit=2) → has_more=True."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    events = [
        _make_event(
            entity_id=f"page-{i}", action="create",
            payload={
                "id": f"page-{i}", "title": f"Page {i}", "status": "todo",
                "priority": "medium", "tags": "[]",
            },
            client_updated_at=f"2026-07-04T1{i}:00:00.000Z",
        )
        for i in range(5)
    ]
    await _push(client, headers, events)

    resp = await client.get(
        "/api/v1/sync/pull?since=&limit=2", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["has_more"] is True
    assert len(data["tasks"]) == 2
