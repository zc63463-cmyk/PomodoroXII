from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select


def _task_event(entity_id: str, title: str) -> dict:
    return {
        "entity_type": "task",
        "entity_id": entity_id,
        "action": "create",
        "payload": {
            "id": entity_id,
            "title": title,
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
        },
        "client_updated_at": "2026-07-12T12:00:00.000Z",
    }


async def _space_headers(client) -> tuple[dict[str, str], str]:
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code in (200, 201)
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "H2-F5 Lifecycle"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    return {"Authorization": f"Bearer {token.json()['space_token']}"}, space_id


@pytest.mark.asyncio
async def test_h2f5_multi_device_ack_floor_and_expired_cursor_http_lifecycle(client):
    headers, _ = await _space_headers(client)
    entity_ids = [f"h2f5-{index}-{uuid.uuid4().hex[:8]}" for index in range(3)]
    pushed = await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _task_event(entity_id, f"Lifecycle {index}")
                for index, entity_id in enumerate(entity_ids)
            ]
        },
        headers=headers,
    )
    assert pushed.status_code == 200
    assert len(pushed.json()["applied"]) == 3

    current = await client.get("/api/v1/sync/pull?cursor=0&limit=10", headers=headers)
    assert current.status_code == 200
    current_cursor = current.json()["next_cursor"]
    assert current_cursor >= 3

    slow_client = str(uuid.uuid4())
    fast_client = str(uuid.uuid4())
    for client_id in (slow_client, fast_client):
        registered = await client.post(
            "/api/v1/sync/clients",
            json={"client_id": client_id},
            headers=headers,
        )
        assert registered.status_code == 200
        assert registered.json()["ack_cursor"] == 0
        assert registered.json()["snapshot_required"] is False

    fast_ack = await client.post(
        "/api/v1/sync/ack",
        json={"client_id": fast_client, "ack_cursor": current_cursor, "cursor_version": 2},
        headers=headers,
    )
    assert fast_ack.status_code == 200
    assert fast_ack.json()["retention_floor"] == 0

    slow_ack_cursor = current_cursor - 1
    slow_ack = await client.post(
        "/api/v1/sync/ack",
        json={"client_id": slow_client, "ack_cursor": slow_ack_cursor, "cursor_version": 2},
        headers=headers,
    )
    assert slow_ack.status_code == 200
    assert slow_ack.json()["retention_floor"] == slow_ack_cursor

    expired = await client.get("/api/v1/sync/pull?cursor=0&limit=10", headers=headers)
    assert expired.status_code == 409
    assert expired.json()["error_type"] == "sync_cursor_expired"
    assert expired.json()["floor"] == slow_ack_cursor
    assert expired.json()["recovery_action"] == "full_sync"


@pytest.mark.asyncio
async def test_h2f5_snapshot_damage_returns_stable_http_recovery_and_reclaims_on_expiry(client):
    from app.models.sync_state import SyncSnapshot, SyncSnapshotChunk
    from app.space_manager import get_space_engine_manager

    headers, space_id = await _space_headers(client)
    events = [
        _task_event(f"damage-{index}-{uuid.uuid4().hex[:8]}", f"Damage {index}")
        for index in range(3)
    ]
    pushed = await client.post(
        "/api/v1/sync/push", json={"events": events}, headers=headers
    )
    assert pushed.status_code == 200

    first = await client.get("/api/v1/sync/full?cursor=0&limit=1", headers=headers)
    assert first.status_code == 200
    snapshot_token = first.json()["snapshot_token"]
    snapshot_offset = first.json()["snapshot_offset"]

    session = await get_space_engine_manager().get_session(space_id)
    try:
        chunk = await session.scalar(
            select(SyncSnapshotChunk)
            .where(
                SyncSnapshotChunk.snapshot_token == snapshot_token,
                SyncSnapshotChunk.item_start <= snapshot_offset,
            )
            .order_by(SyncSnapshotChunk.item_start.desc())
            .limit(1)
        )
        assert chunk is not None
        chunk.checksum = "0" * 64
        await session.commit()
    finally:
        await session.close()

    damaged = await client.get(
        "/api/v1/sync/full",
        params={
            "cursor": 0,
            "limit": 1,
            "snapshot_token": snapshot_token,
            "snapshot_offset": snapshot_offset,
        },
        headers=headers,
    )
    assert damaged.status_code == 409
    assert damaged.json() == {
        "detail": "Sync snapshot expired; restart full sync",
        "error_type": "sync_snapshot_expired",
        "recovery_action": "restart_full_sync",
    }

    session = await get_space_engine_manager().get_session(space_id)
    try:
        snapshot = await session.get(SyncSnapshot, snapshot_token)
        assert snapshot is not None
        snapshot.expires_at = "2000-01-01T00:00:00Z"
        await session.commit()
    finally:
        await session.close()

    expired = await client.get(
        "/api/v1/sync/full",
        params={
            "cursor": 0,
            "limit": 1,
            "snapshot_token": snapshot_token,
            "snapshot_offset": 0,
        },
        headers=headers,
    )
    assert expired.status_code == 409

    session = await get_space_engine_manager().get_session(space_id)
    try:
        assert await session.get(SyncSnapshot, snapshot_token) is None
        remaining = await session.scalar(
            select(func.count()).select_from(SyncSnapshotChunk).where(
                SyncSnapshotChunk.snapshot_token == snapshot_token
            )
        )
        assert remaining == 0
    finally:
        await session.close()


@pytest.mark.asyncio
async def test_h2f5_snapshot_capacity_crosses_500_item_chunk_boundary_over_http(client):
    from app.models.sync_state import SyncSnapshot, SyncSnapshotChunk
    from app.models.task import Task
    from app.space_manager import get_space_engine_manager

    headers, space_id = await _space_headers(client)
    seed_session = await get_space_engine_manager().get_session(space_id)
    try:
        seed_session.add_all(
            [Task(id=f"capacity-{index:04d}", title=f"Capacity {index}") for index in range(501)]
        )
        await seed_session.commit()
    finally:
        await seed_session.close()

    first_response = await client.get(
        "/api/v1/sync/full", params={"cursor": 0, "limit": 500}, headers=headers
    )
    assert first_response.status_code == 200
    first = first_response.json()
    assert first["has_more"] is True
    assert len(first["tasks"]) == 500
    token = first["snapshot_token"]

    second_response = await client.get(
        "/api/v1/sync/full",
        params={
            "cursor": 0,
            "limit": 500,
            "snapshot_token": token,
            "snapshot_offset": first["snapshot_offset"],
        },
        headers=headers,
    )
    assert second_response.status_code == 200
    second = second_response.json()
    assert second["has_more"] is False
    assert len(second["tasks"]) == 1
    assert second["next_cursor"] == first["next_cursor"]

    inspect_session = await get_space_engine_manager().get_session(space_id)
    try:
        snapshot = await inspect_session.get(SyncSnapshot, token)
        assert snapshot is not None
        assert snapshot.item_count == 501
        assert snapshot.chunk_count == 2
        chunk_counts = list(
            await inspect_session.scalars(
                select(SyncSnapshotChunk.item_count)
                .where(SyncSnapshotChunk.snapshot_token == token)
                .order_by(SyncSnapshotChunk.chunk_index)
            )
        )
        assert chunk_counts == [500, 1]
    finally:
        await inspect_session.close()
