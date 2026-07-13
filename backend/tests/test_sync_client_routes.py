from __future__ import annotations

import uuid

import pytest

from tests.test_sync_routes import _setup_login_and_space_token


@pytest.mark.asyncio
async def test_sync_client_list_and_revoke_routes(client):
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    first_id, second_id = sorted((str(uuid.uuid4()), str(uuid.uuid4())))
    for client_id, display_name in ((second_id, "Second"), (first_id, "First")):
        registered = await client.post(
            "/api/v1/sync/clients",
            json={"client_id": client_id, "display_name": display_name},
            headers=headers,
        )
        assert registered.status_code == 200

    listed = await client.get("/api/v1/sync/clients", headers=headers)
    assert listed.status_code == 200
    assert [item["client_id"] for item in listed.json()["clients"]] == [first_id, second_id]
    assert set(listed.json()["clients"][0]) == {
        "client_id", "display_name", "ack_cursor", "last_seen_at", "lease_expires_at",
        "created_at", "snapshot_required", "revoked_at", "status",
    }

    revoked = await client.delete(f"/api/v1/sync/clients/{first_id}", headers=headers)
    assert revoked.status_code == 200
    repeated = await client.delete(f"/api/v1/sync/clients/{first_id}", headers=headers)
    assert repeated.status_code == 200
    assert repeated.json() == revoked.json()
    assert revoked.json()["client_id"] == first_id
    assert revoked.json()["revoked_at"]

    missing = await client.delete(
        f"/api/v1/sync/clients/{uuid.uuid4()}", headers=headers
    )
    assert missing.status_code == 404
    assert missing.json()["error_type"] == "sync_client_not_found"


@pytest.mark.asyncio
async def test_revoked_client_is_rejected_by_register_ack_full_continuation_and_proof(client):
    from app.models.sync_client import SyncClient
    from app.services.sync_outbox import advance_retention_floor, get_current_cursor
    from app.space_manager import get_space_engine_manager

    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    token_payload = __import__(
        "app.auth.security", fromlist=["decode_access_token"]
    ).decode_access_token(space_token)
    space_id = token_payload["space_id"]
    pushed = await client.post(
        "/api/v1/sync/push",
        json={
            "events": [{
                "entity_type": "task", "entity_id": uuid.uuid4().hex, "action": "create",
                "payload": {}, "client_updated_at": "2026-07-13T00:00:00.000Z",
            }]
        },
        headers=headers,
    )
    assert pushed.status_code == 200
    session = await get_space_engine_manager().get_session(space_id)
    try:
        await advance_retention_floor(session, floor=await get_current_cursor(session))
        await session.commit()
    finally:
        await session.close()

    client_id = str(uuid.uuid4())
    registered = await client.post(
        "/api/v1/sync/clients", json={"client_id": client_id}, headers=headers
    )
    assert registered.status_code == 200
    session = await get_space_engine_manager().get_session(space_id)
    try:
        sync_client = await session.get(SyncClient, client_id)
        assert sync_client is not None
        sync_client.snapshot_required = True
        await session.commit()
    finally:
        await session.close()
    first = await client.get(
        "/api/v1/sync/full",
        params={"cursor": 0, "limit": 1, "client_id": client_id},
        headers=headers,
    )
    assert first.status_code == 200
    recovery = first.json()
    continuation = recovery.get("recovery_continuation")
    proof = recovery.get("recovery_proof")
    assert continuation or proof

    revoked = await client.delete(f"/api/v1/sync/clients/{client_id}", headers=headers)
    assert revoked.status_code == 200

    registration = await client.post(
        "/api/v1/sync/clients", json={"client_id": client_id}, headers=headers
    )
    assert registration.status_code == 409
    assert registration.json()["error_type"] == "sync_client_revoked"
    ack = await client.post(
        "/api/v1/sync/ack",
        json={
            "client_id": client_id,
            "ack_cursor": recovery["next_cursor"],
            "cursor_version": 2,
            **({"recovery_proof": proof} if proof else {}),
        },
        headers=headers,
    )
    assert ack.status_code == 409
    assert ack.json()["error_type"] == "sync_client_revoked"

    full_params = {"cursor": 0, "limit": 1, "client_id": client_id}
    if continuation:
        full_params.update({
            "snapshot_token": recovery["snapshot_token"],
            "snapshot_offset": recovery["snapshot_offset"],
            "recovery_continuation": continuation,
        })
    full = await client.get("/api/v1/sync/full", params=full_params, headers=headers)
    assert full.status_code == 409
    assert full.json()["error_type"] == "sync_client_revoked"
    legacy_full = await client.get(
        "/api/v1/sync/full", params={"client_id": client_id}, headers=headers
    )
    assert legacy_full.status_code == 409
    assert legacy_full.json()["error_type"] == "sync_client_revoked"


@pytest.mark.asyncio
async def test_sync_client_routes_validate_client_id_length(client):
    _, space_token = await _setup_login_and_space_token(client)
    response = await client.delete(
        "/api/v1/sync/clients/short",
        headers={"Authorization": f"Bearer {space_token}"},
    )
    assert response.status_code == 422
