from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.errors import ConflictError, NotFoundError, ValidationError


@pytest.mark.asyncio
async def test_register_validates_uuid_and_uses_floor(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    event = await record_sync_event(
        space_session, entity_type="task", entity_id="seed", action="create"
    )
    await advance_retention_floor(space_session, floor=event.id)
    service = SyncClientService(space_session)
    with pytest.raises(ValidationError, match="UUID"):
        await service.register(client_id="not-a-uuid", user_id="user-a")

    client_id = str(uuid.uuid4())
    result = await service.register(client_id=client_id, user_id="user-a")
    row = await space_session.get(SyncClient, client_id)
    assert result["ack_cursor"] == event.id
    assert result["snapshot_required"] is True
    assert row is not None and row.ack_cursor == event.id
    assert row.snapshot_required is True


@pytest.mark.asyncio
async def test_register_is_user_scoped_revoked_and_quota_limited(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService

    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")
    with pytest.raises(ConflictError) as owner_error:
        await service.register(client_id=client_id, user_id="user-b")
    assert owner_error.value.error_type == "sync_client_owner_conflict"

    row = await space_session.get(SyncClient, client_id)
    assert row is not None
    row.revoked_at = "2026-07-12T00:00:00Z"
    await space_session.flush()
    with pytest.raises(ConflictError) as revoked_error:
        await service.register(client_id=client_id, user_id="user-a")
    assert revoked_error.value.error_type == "sync_client_revoked"

    for _ in range(20):
        await service.register(client_id=str(uuid.uuid4()), user_id="quota-user")
    with pytest.raises(ConflictError) as quota_error:
        await service.register(client_id=str(uuid.uuid4()), user_id="quota-user")
    assert quota_error.value.error_type == "sync_client_quota_exceeded"


@pytest.mark.asyncio
async def test_ack_boundaries_monotonic_idempotent_and_renews_lease(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    first = await record_sync_event(
        space_session, entity_type="task", entity_id="one", action="create"
    )
    second = await record_sync_event(
        space_session, entity_type="task", entity_id="two", action="create"
    )
    await advance_retention_floor(space_session, floor=first.id)
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    registered = await service.register(client_id=client_id, user_id="user-a")

    with pytest.raises(ValidationError):
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=first.id, cursor_version=1
        )
    with pytest.raises(ConflictError) as below:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=first.id - 1, cursor_version=2
        )
    assert below.value.error_type == "sync_ack_below_floor"
    with pytest.raises(ConflictError) as above:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=second.id + 1, cursor_version=2
        )
    assert above.value.error_type == "sync_ack_above_current"

    with pytest.raises(ConflictError) as snapshot_required:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=first.id, cursor_version=2
        )
    assert snapshot_required.value.error_type == "sync_snapshot_required"

    advanced = await service.acknowledge(
        client_id=client_id, user_id="user-a", ack_cursor=second.id, cursor_version=2
    )
    row = await space_session.get(SyncClient, client_id)
    assert row is not None and row.snapshot_required is False
    repeated = await service.acknowledge(
        client_id=client_id, user_id="user-a", ack_cursor=second.id, cursor_version=2
    )
    assert repeated["ack_cursor"] == second.id
    assert repeated["lease_expires_at"] >= registered["lease_expires_at"]
    assert advanced["retention_floor"] == first.id

    with pytest.raises(ConflictError) as regression:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=first.id, cursor_version=2
        )
    assert regression.value.error_type == "sync_ack_regression"
    row = await space_session.get(SyncClient, client_id)
    assert row is not None and row.ack_cursor == second.id


@pytest.mark.asyncio
async def test_ack_rejects_cross_user_missing_and_revoked_clients(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    event = await record_sync_event(
        space_session, entity_type="task", entity_id="seed", action="create"
    )
    await advance_retention_floor(space_session, floor=event.id)
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")
    for unauthorized_cursor in (event.id - 1, event.id + 1):
        with pytest.raises(NotFoundError) as unauthorized:
            await service.acknowledge(
                client_id=client_id,
                user_id="user-b",
                ack_cursor=unauthorized_cursor,
                cursor_version=2,
            )
        assert unauthorized.value.error_type == "sync_client_not_found"

    row = (await space_session.execute(
        select(SyncClient).where(SyncClient.client_id == client_id)
    )).scalar_one()
    row.revoked_at = "2026-07-12T00:00:00Z"
    await space_session.flush()
    with pytest.raises(ConflictError) as revoked:
        await service.acknowledge(
            client_id=client_id,
            user_id="user-a",
            ack_cursor=event.id + 1,
            cursor_version=2,
        )
    assert revoked.value.error_type == "sync_client_revoked"
