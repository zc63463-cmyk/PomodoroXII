"""Integration tests for v1 sync REST routes (Phase C C7).

Covers POST /sync/push, GET /sync/pull, GET /sync/full, GET /sync/status.
Auth model: requires space token (not master token).
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.provisioned_space_storage


async def _setup_login_and_space_token(client) -> tuple[str, str]:
    """Setup admin, login, create a space, issue a space token.

    Returns (master_token, space_token).
    """
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
        "/api/v1/spaces", json={"name": "Sync Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    space_token = resp.json()["space_token"]
    return master_token, space_token


def _make_event(
    entity_type: str = "habit",
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


# --------------------------------------------------------------------------- #
# C7: sync routes
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_push_endpoint_requires_space_token_401(client):
    """POST /sync/push without auth returns 401."""
    resp = await client.post(
        "/api/v1/sync/push", json={"events": []}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_push_endpoint_applies_events(client):
    """POST /sync/push with valid events returns applied list."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    resp = await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _make_event(
                    entity_id=eid,
                    action="create",
                    payload={
                        "id": eid,
                        "title": "Synced via HTTP",
                    },
                )
            ]
        },
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["applied"]) == 1
    assert data["errors"] == []
    assert data["applied"][0]["entity_id"] == eid


@pytest.mark.asyncio
async def test_pull_endpoint_returns_habits(client):
    """GET /sync/pull returns habits list."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    # Seed a habit via push.
    eid = uuid.uuid4().hex
    await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _make_event(
                    entity_id=eid,
                    action="create",
                    payload={
                        "id": eid, "title": "Pull me",
                    },
                )
            ]
        },
        headers=headers,
    )

    resp = await client.get("/api/v1/sync/pull", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    habit_ids = [t["id"] for t in data["habits"]]
    assert eid in habit_ids


@pytest.mark.asyncio
async def test_pull_endpoint_filters_by_since(client):
    """GET /sync/pull?since filters out older rows."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    old_id = uuid.uuid4().hex
    await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _make_event(
                    entity_id=old_id,
                    action="create",
                    payload={
                        "id": old_id, "title": "Old",
                    },
                    client_updated_at="2026-07-04T08:00:00.000Z",
                )
            ]
        },
        headers=headers,
    )

    new_id = uuid.uuid4().hex
    await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _make_event(
                    entity_id=new_id,
                    action="create",
                    payload={
                        "id": new_id, "title": "New",
                    },
                    client_updated_at="2026-07-04T12:00:00.000Z",
                )
            ]
        },
        headers=headers,
    )

    resp = await client.get(
        "/api/v1/sync/pull?since=2026-07-04T10:00:00.000Z",
        headers=headers,
    )
    assert resp.status_code == 200
    habit_ids = [t["id"] for t in resp.json()["habits"]]
    assert old_id not in habit_ids
    assert new_id in habit_ids


@pytest.mark.asyncio
async def test_full_endpoint_returns_all_tombstones_ignoring_since(client):
    """GET /sync/full returns all tombstones regardless of since."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    # Create a habit via habit route, then DELETE via habit route (which
    # writes a tombstone). Sync push delete also writes a tombstone.
    resp = await client.post(
        "/api/v1/habits",
        json={"title": "To delete via habit route"},
        headers=headers,
    )
    assert resp.status_code == 201
    habit_id = resp.json()["id"]

    resp = await client.delete(f"/api/v1/habits/{habit_id}", headers=headers)
    assert resp.status_code in (200, 204)

    resp = await client.get(
        "/api/v1/sync/full?since=2099-01-01T00:00:00.000Z",
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    tomb_ids = [t["entity_id"] for t in data["tombstones"]]
    assert habit_id in tomb_ids
    assert data["is_full"] is True


@pytest.mark.asyncio
async def test_status_endpoint_returns_counts(client):
    """GET /sync/status returns entity_counts + tombstone_count."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    # Push 3 habits.
    for i in range(3):
        eid = uuid.uuid4().hex
        await client.post(
            "/api/v1/sync/push",
            json={
                "events": [
                    _make_event(
                        entity_id=eid,
                        action="create",
                        payload={
                            "id": eid, "title": f"T{i}",
                        },
                    )
                ]
            },
            headers=headers,
        )

    resp = await client.get("/api/v1/sync/status", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["entity_counts"]["habits"] == 3
    assert "tombstone_count" in data
    assert "server_time" in data

@pytest.mark.asyncio
async def test_space_token_cannot_prune_sync_ledger(client):
    """普通 space token 不得拥有任何公开账本删除能力。"""
    _, space_token = await _setup_login_and_space_token(client)
    response = await client.delete(
        "/api/v1/sync/events?before_id=1",
        headers={"Authorization": f"Bearer {space_token}"},
    )
    assert response.status_code in (404, 405)


@pytest.mark.asyncio
async def test_cursor_expired_http_error_has_stable_recovery_fields(space_session):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import delete

    from app.errors import register_exception_handlers
    from app.models.sync_outbox import SyncOutbox
    from app.models.sync_state import SyncState
    from app.routes.v1 import sync as sync_routes
    from app.services.sync_outbox import record_sync_event

    event_row = await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="expired-http",
        action="create",
        visible=True,
    )
    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.retention_floor = event_row.id
    await space_session.execute(
        delete(SyncOutbox).where(SyncOutbox.id <= event_row.id)
    )
    await space_session.flush()

    async def database_override():
        yield space_session

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(sync_routes.router, prefix="/api/v1/sync")
    app.dependency_overrides[sync_routes.get_space_db] = database_override
    app.dependency_overrides[sync_routes.get_file_system] = lambda: None
    app.dependency_overrides[sync_routes.get_space_context] = lambda: {
        "space_id": "spc_test"
    }
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as local:
        response = await local.get("/api/v1/sync/pull?cursor=0")
    assert response.status_code == 409
    assert response.json() == {
        "detail": "Sync cursor expired; perform a full sync",
        "error_type": "sync_cursor_expired",
        "floor": event_row.id,
        "current_cursor": event_row.id,
        "recovery_action": "full_sync",
    }


@pytest.mark.asyncio
async def test_missing_snapshot_http_error_has_stable_recovery_fields(client):
    _, space_token = await _setup_login_and_space_token(client)
    response = await client.get(
        "/api/v1/sync/full?cursor=0&snapshot_token=already-pruned&snapshot_offset=1",
        headers={"Authorization": f"Bearer {space_token}"},
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Sync snapshot expired; restart full sync",
        "error_type": "sync_snapshot_expired",
        "recovery_action": "restart_full_sync",
    }


@pytest.mark.asyncio
async def test_push_endpoint_returns_conflict_for_lww(client):
    """POST /sync/push with older client_ts should return conflict."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    # Initial create at 12:00.
    await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _make_event(
                    entity_id=eid,
                    action="create",
                    payload={
                        "id": eid, "title": "Original",
                    },
                    client_updated_at="2026-07-04T12:00:00.000Z",
                )
            ]
        },
        headers=headers,
    )
    # Older update at 10:00 should conflict (local wins).
    resp = await client.post(
        "/api/v1/sync/push",
        json={
            "events": [
                _make_event(
                    entity_id=eid,
                    action="update",
                    payload={"title": "Older update should not win"},
                    client_updated_at="2026-07-04T10:00:00.000Z",
                )
            ]
        },
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    # LWW resolved to local — conflict reported.
    assert len(data["conflicts"]) == 1
    assert data["conflicts"][0]["resolution"] == "local"
