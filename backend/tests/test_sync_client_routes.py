from __future__ import annotations

import uuid

import pytest

from tests.test_sync_routes import _make_event, _setup_login_and_space_token


def _device_headers(space_token: str, client_id: str, client_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {space_token}",
        "X-Sync-Client-Id": client_id,
        "X-Sync-Client-Token": client_token,
    }


def _registration_body(
    client_id: str,
    client_token: str,
    display_name: str | None = None,
) -> dict[str, str]:
    body = {"client_id": client_id, "client_token": client_token}
    if display_name is not None:
        body["display_name"] = display_name
    return body


@pytest.mark.asyncio
async def test_sync_client_registration_stores_client_token_without_returning_it(client):
    _, space_token = await _setup_login_and_space_token(client)
    auth_headers = {"Authorization": f"Bearer {space_token}"}
    client_id = str(uuid.uuid4())
    client_token = "first-client-token-0123456789abcdef"

    created = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(client_id, client_token),
        headers=auth_headers,
    )
    assert created.status_code == 200
    assert "client_token" not in created.json()

    renewed = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(client_id, client_token),
        headers=auth_headers,
    )
    assert renewed.status_code == 200
    assert "client_token" not in renewed.json()

    wrong = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(client_id, "wrong-client-token-0123456789abcdef"),
        headers=auth_headers,
    )
    assert wrong.status_code == 401
    assert wrong.json()["error_type"] == "sync_client_credentials_invalid"


@pytest.mark.asyncio
async def test_sync_routes_reject_missing_wrong_and_impersonated_device_credentials(client):
    _, space_token = await _setup_login_and_space_token(client)
    auth_headers = {"Authorization": f"Bearer {space_token}"}
    first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
    first_token = "first-client-token-0123456789abcdef"
    second_token = "second-client-token-0123456789abcdef"
    await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(first_id, first_token),
        headers=auth_headers,
    )
    first_headers = _device_headers(space_token, first_id, first_token)
    second = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(second_id, second_token),
        headers=first_headers,
    )
    assert second.status_code == 200
    payload = {"events": [_make_event()]}

    missing = await client.post("/api/v1/sync/push", json=payload, headers=auth_headers)
    wrong = await client.post(
        "/api/v1/sync/push",
        json=payload,
        headers=_device_headers(space_token, first_id, "wrong-token"),
    )
    impersonated = await client.post(
        "/api/v1/sync/push",
        json=payload,
        headers=_device_headers(space_token, second_id, first_token),
    )

    for response in (missing, wrong, impersonated):
        assert response.status_code == 401
        assert response.json()["error_type"] == "sync_client_credentials_invalid"


@pytest.mark.asyncio
async def test_revoked_and_recovering_clients_cannot_push(client):
    from app.models.sync_client import SyncClient
    from app.services.sync_outbox import advance_retention_floor, get_current_cursor
    from app.space_manager import get_space_engine_manager

    _, space_token = await _setup_login_and_space_token(client)
    auth_headers = {"Authorization": f"Bearer {space_token}"}
    first_id = str(uuid.uuid4())
    first_token = "first-client-token-0123456789abcdef"
    await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(first_id, first_token),
        headers=auth_headers,
    )
    first_headers = _device_headers(space_token, first_id, first_token)
    recovering_id = str(uuid.uuid4())
    recovering_token = "recovering-client-token-0123456789abcdef"
    await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(recovering_id, recovering_token),
        headers=first_headers,
    )
    revoked = await client.delete(f"/api/v1/sync/clients/{first_id}", headers=first_headers)
    assert revoked.status_code == 200

    revoked_push = await client.post(
        "/api/v1/sync/push", json={"events": [_make_event()]}, headers=first_headers
    )
    assert revoked_push.status_code == 409
    assert revoked_push.json()["error_type"] == "sync_client_revoked"

    token_payload = __import__(
        "app.auth.security", fromlist=["decode_access_token"]
    ).decode_access_token(space_token)
    session = await get_space_engine_manager().get_session(token_payload["space_id"])
    try:
        await advance_retention_floor(session, floor=await get_current_cursor(session))
        await session.commit()
    finally:
        await session.close()

    recovering_headers = _device_headers(space_token, recovering_id, recovering_token)
    session = await get_space_engine_manager().get_session(token_payload["space_id"])
    try:
        row = await session.get(SyncClient, recovering_id)
        assert row is not None
        row.snapshot_required = True
        await session.commit()
    finally:
        await session.close()

    recovering_push = await client.post(
        "/api/v1/sync/push", json={"events": [_make_event()]}, headers=recovering_headers
    )
    assert recovering_push.status_code == 409
    assert recovering_push.json()["error_type"] == "sync_client_recovery_required"

    unauthorized_child = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(
            str(uuid.uuid4()), "unauthorized-child-token-0123456789abcdef"
        ),
        headers=recovering_headers,
    )
    assert unauthorized_child.status_code == 409
    assert unauthorized_child.json()["error_type"] == "sync_client_recovery_required"


@pytest.mark.asyncio
async def test_sync_client_list_and_revoke_routes(client):
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    first_id, second_id = sorted((str(uuid.uuid4()), str(uuid.uuid4())))
    second_token = "second-client-token-0123456789abcdef"
    second = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(second_id, second_token, "Second"),
        headers=headers,
    )
    assert second.status_code == 200
    device_headers = _device_headers(space_token, second_id, second_token)
    first = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(
            first_id, "first-client-token-0123456789abcdef", "First"
        ),
        headers=device_headers,
    )
    assert first.status_code == 200

    listed = await client.get("/api/v1/sync/clients", headers=device_headers)
    assert listed.status_code == 200
    assert [item["client_id"] for item in listed.json()["clients"]] == [second_id, first_id]
    assert set(listed.json()["clients"][0]) == {
        "client_id", "display_name", "ack_cursor", "last_seen_at", "lease_expires_at",
        "created_at", "snapshot_required", "revoked_at", "status",
    }

    revoked = await client.delete(f"/api/v1/sync/clients/{first_id}", headers=device_headers)
    assert revoked.status_code == 200
    repeated = await client.delete(
        f"/api/v1/sync/clients/{first_id}", headers=device_headers
    )
    assert repeated.status_code == 200
    assert repeated.json() == revoked.json()
    assert revoked.json()["client_id"] == first_id
    assert revoked.json()["revoked_at"]

    missing = await client.delete(
        f"/api/v1/sync/clients/{uuid.uuid4()}", headers=device_headers
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
    authorizer_id = str(uuid.uuid4())
    authorizer_token = "authorizer-client-token-0123456789abcdef"
    await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(authorizer_id, authorizer_token),
        headers=headers,
    )
    authorizer_headers = _device_headers(space_token, authorizer_id, authorizer_token)
    pushed = await client.post(
        "/api/v1/sync/push",
        json={
            "events": [{
                "entity_type": "task", "entity_id": uuid.uuid4().hex, "action": "create",
                "payload": {}, "client_updated_at": "2026-07-13T00:00:00.000Z",
            }]
        },
        headers=authorizer_headers,
    )
    assert pushed.status_code == 200
    session = await get_space_engine_manager().get_session(space_id)
    try:
        await advance_retention_floor(session, floor=await get_current_cursor(session))
        await session.commit()
    finally:
        await session.close()

    client_id = str(uuid.uuid4())
    client_token = "revoked-client-token-0123456789abcdef"
    registered = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(client_id, client_token),
        headers=authorizer_headers,
    )
    assert registered.status_code == 200
    revoked_headers = _device_headers(space_token, client_id, client_token)
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
        headers=revoked_headers,
    )
    assert first.status_code == 200
    recovery = first.json()
    continuation = recovery.get("recovery_continuation")
    proof = recovery.get("recovery_proof")
    assert continuation or proof

    revoked = await client.delete(
        f"/api/v1/sync/clients/{client_id}", headers=authorizer_headers
    )
    assert revoked.status_code == 200

    registration = await client.post(
        "/api/v1/sync/clients",
        json=_registration_body(client_id, client_token),
        headers=revoked_headers,
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
        headers=revoked_headers,
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
    full = await client.get(
        "/api/v1/sync/full", params=full_params, headers=revoked_headers
    )
    assert full.status_code == 409
    assert full.json()["error_type"] == "sync_client_revoked"
    legacy_full = await client.get(
        "/api/v1/sync/full", params={"client_id": client_id}, headers=revoked_headers
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
