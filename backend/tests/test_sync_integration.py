"""End-to-end Sync v2 integration tests across HTTP, protocol, and storage."""

from __future__ import annotations

import base64
import json
import uuid

import pytest

pytestmark = pytest.mark.provisioned_space_storage


async def _setup_sync_client(client, client_id: str = "integration-client"):
    setup = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert setup.status_code in (200, 201)
    login = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    master = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "Integration Space"}, headers=master
    )
    token = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token", headers=master
    )
    headers = {"Authorization": f"Bearer {token.json()['space_token']}"}

    recovery = await client.get(
        "/api/v1/sync/v2/recover", params={"client_id": client_id}, headers=headers
    )
    assert recovery.status_code == 200, recovery.text
    page = recovery.json()
    while page["has_more"]:
        recovery = await client.get(
            "/api/v1/sync/v2/recover",
            params={"client_id": client_id, "page_token": page["next_page_token"]},
            headers=headers,
        )
        assert recovery.status_code == 200, recovery.text
        page = recovery.json()
    acknowledged = await client.post(
        "/api/v1/sync/v2/ack",
        json={"client_id": client_id, "cursor": page["waterline_cursor"]},
        headers=headers,
    )
    assert acknowledged.status_code == 200, acknowledged.text
    return headers, client_id


def _make_event(
    *,
    entity_type: str = "habit",
    action: str = "create",
    entity_id: str | None = None,
    payload: dict | None = None,
    expected_version: int | None = None,
    client_updated_at: str = "2026-07-16T10:00:00.000Z",
) -> dict:
    return {
        "entity_type": entity_type,
        "entity_id": entity_id or uuid.uuid4().hex,
        "action": action,
        "payload": payload or {},
        "expected_version": expected_version,
        "client_updated_at": client_updated_at,
        "operation_id": f"op-{uuid.uuid4().hex}",
    }


async def _push(client, headers, client_id: str, events):
    response = await client.post(
        "/api/v1/sync/v2/push",
        json={"client_id": client_id, "batch_id": f"batch-{uuid.uuid4().hex}", "events": events},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _pull(client, headers, client_id: str, *, cursor: str | None = None, limit: int = 100):
    params = {"client_id": client_id, "limit": str(limit)}
    if cursor is not None:
        params["cursor"] = cursor
    response = await client.get("/api/v1/sync/v2/pull", params=params, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def test_full_sync_roundtrip_create_pull(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Roundtrip"})],
    )

    first = await _pull(client, headers, client_id)
    assert entity_id in {event["entity_id"] for event in first["events"]}
    assert first["next_cursor"]
    second = await _pull(client, headers, client_id, cursor=first["next_cursor"])
    assert entity_id not in {event["entity_id"] for event in second["events"]}


async def test_quick_note_sync_roundtrip_preserves_array_tags(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    created = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_type="quickNote",
                entity_id=entity_id,
                payload={"id": entity_id, "content": "Synced", "tags": ["sync", "multi-device"]},
            )
        ],
    )
    assert created["errors"] == []
    updated = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_type="quickNote",
                entity_id=entity_id,
                action="update",
                expected_version=1,
                payload={"content": "Updated", "tags": ["synced"]},
                client_updated_at="2026-07-16T12:00:00.000Z",
            )
        ],
    )
    assert updated["errors"] == []
    pulled = await _pull(client, headers, client_id)
    update = next(
        event
        for event in pulled["events"]
        if event["entity_id"] == entity_id and event["action"] == "update"
    )
    assert update["payload"]["content"] == "Updated"
    assert update["payload"]["tags"] == ["synced"]


async def test_full_sync_roundtrip_update_lww(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Original"})],
    )
    updated = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                action="update",
                expected_version=0,
                payload={"title": "Updated Title"},
                client_updated_at="2026-07-16T12:00:00.000Z",
            )
        ],
    )
    assert updated["applied"][0]["resolution"] == "remote"


async def test_sync_roundtrip_delete_via_habit_route_creates_tombstone(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Delete"})],
    )
    deleted = await client.delete(f"/api/v1/habits/{entity_id}", headers=headers)
    assert deleted.status_code in (200, 204)
    pulled = await _pull(client, headers, client_id)
    assert any(
        event["entity_id"] == entity_id and event["action"] == "delete"
        for event in pulled["events"]
    )


async def test_sync_roundtrip_delete_via_push_writes_tombstone(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Delete"})],
    )
    deleted = await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, action="delete", expected_version=1)],
    )
    assert deleted["errors"] == []
    assert deleted["applied"][0]["entity_id"] == entity_id


async def test_sync_status_reflects_visible_events(client):
    headers, client_id = await _setup_sync_client(client)
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=f"status-habit-{index}", payload={"id": f"status-habit-{index}", "title": f"S{index}"})
            for index in range(3)
        ],
    )
    response = await client.get(
        "/api/v1/sync/v2/status", params={"client_id": client_id}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["visible_event_count"] >= 3
    assert response.json()["registered"] is True


async def test_new_client_recovery_excludes_deleted_entities(client):
    headers, _client_id = await _setup_sync_client(client)
    tombstone_ids = []
    for index in range(2):
        created = await client.post(
            "/api/v1/habits", json={"title": f"Tombstone {index}"}, headers=headers
        )
        assert created.status_code == 201, created.text
        entity_id = created.json()["id"]
        deleted = await client.delete(f"/api/v1/habits/{entity_id}", headers=headers)
        assert deleted.status_code in (200, 204)
        tombstone_ids.append(entity_id)

    recovery_client = "recovery-client"
    page_token = None
    records = []
    while True:
        params = {"client_id": recovery_client}
        if page_token is not None:
            params["page_token"] = page_token
        response = await client.get("/api/v1/sync/v2/recover", params=params, headers=headers)
        assert response.status_code == 200, response.text
        page = response.json()
        decoded = base64.b64decode(page["payload_jsonl_base64"])
        records.extend(json.loads(line) for line in decoded.splitlines())
        if not page["has_more"]:
            break
        page_token = page["next_page_token"]
    recovered_ids = {
        record["entity_id"]
        for record in records
        if record.get("entity_type") == "habit"
    }
    assert set(tombstone_ids).isdisjoint(recovered_ids)


async def test_sync_handles_mixed_batch(client):
    headers, client_id = await _setup_sync_client(client)
    update_id, delete_id = uuid.uuid4().hex, uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=update_id, payload={"id": update_id, "title": "Update"}),
            _make_event(entity_id=delete_id, payload={"id": delete_id, "title": "Delete"}),
        ],
    )
    new_id = uuid.uuid4().hex
    result = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=update_id, action="update", expected_version=1, payload={"title": "Updated"}),
            _make_event(entity_id=delete_id, action="delete", expected_version=1),
            _make_event(entity_id=new_id, payload={"id": new_id, "title": "New"}),
        ],
    )
    assert len(result["applied"]) == 3
    assert result["errors"] == []


async def test_sync_push_unknown_entity_returns_error(client):
    headers, client_id = await _setup_sync_client(client)
    result = await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_type="invalidEntity", entity_id="x", payload={"id": "x"})],
    )
    assert len(result["errors"]) == 1
    assert result["errors"][0]["entity_type"] == "invalidEntity"


async def test_sync_pagination_uses_opaque_cursor(client):
    headers, client_id = await _setup_sync_client(client)
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=f"page-{index}", payload={"id": f"page-{index}", "title": f"Page {index}"})
            for index in range(5)
        ],
    )
    first = await _pull(client, headers, client_id, limit=2)
    assert first["has_more"] is True
    assert len(first["events"]) == 2
    assert isinstance(first["next_cursor"], str)
    assert not first["next_cursor"].isdigit()
    second = await _pull(client, headers, client_id, cursor=first["next_cursor"], limit=2)
    assert {item["operation_id"] for item in first["events"]}.isdisjoint(
        {item["operation_id"] for item in second["events"]}
    )


async def test_sync_push_rejects_stale_update_with_lww_conflict(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                payload={"id": entity_id, "title": "Original"},
                client_updated_at="2026-07-16T12:00:00.000Z",
            )
        ],
    )
    stale = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                action="update",
                expected_version=0,
                payload={"title": "Stale"},
                client_updated_at="2026-07-16T10:00:00.000Z",
            )
        ],
    )
    assert stale["conflicts"][0]["resolution"] == "local"


async def test_cursor_advances_without_duplicates_for_tied_timestamps(client):
    headers, client_id = await _setup_sync_client(client)
    entity_ids = [uuid.uuid4().hex for _ in range(3)]
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                payload={"id": entity_id, "title": f"Tie {index}"},
                client_updated_at="2026-07-16T10:00:00.000Z",
            )
            for index, entity_id in enumerate(entity_ids)
        ],
    )
    first = await _pull(client, headers, client_id, limit=2)
    second = await _pull(client, headers, client_id, cursor=first["next_cursor"], limit=2)
    returned_ids = [event["entity_id"] for event in (*first["events"], *second["events"])]
    assert set(returned_ids) == set(entity_ids)
    assert len(returned_ids) == len(set(returned_ids))
