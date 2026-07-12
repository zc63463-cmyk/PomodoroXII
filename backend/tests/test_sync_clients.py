from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.errors import ConflictError, NotFoundError, ValidationError
from app.services.time import utc_now


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
    assert advanced["retention_floor"] == second.id
    assert advanced["pruned_events"] == 2

    with pytest.raises(ConflictError) as regression:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=first.id, cursor_version=2
        )
    assert regression.value.error_type == "sync_ack_below_floor"
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


@pytest.mark.asyncio
async def test_ack_advances_floor_to_minimum_active_ack_and_prunes(space_session):
    from app.models.sync_audit_log import SyncAuditLog
    from app.models.sync_outbox import SyncOutbox
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    events = [
        await record_sync_event(
            space_session, entity_type="task", entity_id=f"task-{index}", action="create"
        )
        for index in range(1, 4)
    ]
    service = SyncClientService(space_session)
    slow_client = str(uuid.uuid4())
    fast_client = str(uuid.uuid4())
    await service.register(client_id=slow_client, user_id="user-a")
    await service.register(client_id=fast_client, user_id="user-a")

    first_ack = await service.acknowledge(
        client_id=fast_client,
        user_id="user-a",
        ack_cursor=events[-1].id,
        cursor_version=2,
    )
    assert first_ack["retention_floor"] == 0
    assert first_ack["pruned_events"] == 0

    second_ack = await service.acknowledge(
        client_id=slow_client,
        user_id="user-a",
        ack_cursor=events[1].id,
        cursor_version=2,
    )
    assert second_ack["retention_floor"] == events[1].id
    assert second_ack["pruned_events"] == 2
    assert await get_retention_floor(space_session) == events[1].id
    remaining_ids = list(await space_session.scalars(select(SyncOutbox.id).order_by(SyncOutbox.id)))
    assert remaining_ids == [events[-1].id]

    audit = (
        await space_session.execute(
            select(SyncAuditLog).where(
                SyncAuditLog.event_type == "retention_floor_advanced",
                SyncAuditLog.entity_id == str(events[1].id),
            )
        )
    ).scalar_one()
    assert '"active_client_count": 2' in audit.details
    assert '"reason": "active_client_min_ack"' in audit.details


@pytest.mark.asyncio
async def test_expired_revoked_and_snapshot_required_clients_do_not_block_floor(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import record_sync_event

    events = [
        await record_sync_event(
            space_session, entity_type="task", entity_id=f"edge-{index}", action="create"
        )
        for index in range(1, 4)
    ]
    service = SyncClientService(space_session)
    active_id = str(uuid.uuid4())
    expired_id = str(uuid.uuid4())
    revoked_id = str(uuid.uuid4())
    recovering_id = str(uuid.uuid4())
    for client_id in (active_id, expired_id, revoked_id, recovering_id):
        await service.register(client_id=client_id, user_id="user-a")

    expired = await space_session.get(SyncClient, expired_id)
    revoked = await space_session.get(SyncClient, revoked_id)
    recovering = await space_session.get(SyncClient, recovering_id)
    assert expired is not None and revoked is not None and recovering is not None
    expired.lease_expires_at = "2000-01-01T00:00:00Z"
    revoked.revoked_at = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
    recovering.snapshot_required = True
    await space_session.flush()

    result = await service.acknowledge(
        client_id=active_id,
        user_id="user-a",
        ack_cursor=events[-1].id,
        cursor_version=2,
    )
    assert result["retention_floor"] == events[-1].id
    assert result["active_client_count"] == 1
    assert result["pruned_events"] == 3


@pytest.mark.asyncio
async def test_snapshot_required_client_cannot_ack_floor_when_newer_events_exist(space_session):
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    first = await record_sync_event(
        space_session, entity_type="task", entity_id="floor", action="create"
    )
    await record_sync_event(
        space_session, entity_type="task", entity_id="newer", action="create"
    )
    await advance_retention_floor(space_session, floor=first.id)
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")

    with pytest.raises(ConflictError) as blocked:
        await service.acknowledge(
            client_id=client_id,
            user_id="user-a",
            ack_cursor=first.id,
            cursor_version=2,
        )
    assert blocked.value.error_type == "sync_snapshot_required"


@pytest.mark.asyncio
async def test_expired_client_renewal_below_advanced_floor_requires_snapshot(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    events = [
        await record_sync_event(
            space_session, entity_type="task", entity_id=f"renew-{index}", action="create"
        )
        for index in range(1, 3)
    ]
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")
    client = await space_session.get(SyncClient, client_id)
    assert client is not None
    client.lease_expires_at = "2000-01-01T00:00:00Z"
    await advance_retention_floor(space_session, floor=events[-1].id)

    renewed = await service.register(client_id=client_id, user_id="user-a")
    assert renewed["ack_cursor"] == events[-1].id
    assert renewed["snapshot_required"] is True


@pytest.mark.asyncio
async def test_snapshot_required_client_can_ack_when_floor_equals_current(space_session):
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    event = await record_sync_event(
        space_session, entity_type="task", entity_id="floor-equals-current", action="create"
    )
    await advance_retention_floor(space_session, floor=event.id)
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    registered = await service.register(client_id=client_id, user_id="user-a")
    assert registered["snapshot_required"] is True

    acknowledged = await service.acknowledge(
        client_id=client_id,
        user_id="user-a",
        ack_cursor=event.id,
        cursor_version=2,
    )
    assert acknowledged["ack_cursor"] == event.id
    renewed = await service.register(client_id=client_id, user_id="user-a")
    assert renewed["snapshot_required"] is False


@pytest.mark.asyncio
async def test_lease_expiration_boundary_is_strictly_greater_than_now(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import record_sync_event

    fixed_now = datetime(2026, 7, 12, 10, 0, 0, tzinfo=UTC)
    event = await record_sync_event(
        space_session, entity_type="task", entity_id="lease-boundary", action="create"
    )
    service = SyncClientService(space_session)
    expired_at_boundary = str(uuid.uuid4())
    active_after_boundary = str(uuid.uuid4())
    await service.register(client_id=expired_at_boundary, user_id="user-a")
    await service.register(client_id=active_after_boundary, user_id="user-a")
    first = await space_session.get(SyncClient, expired_at_boundary)
    second = await space_session.get(SyncClient, active_after_boundary)
    assert first is not None and second is not None
    first.lease_expires_at = fixed_now.strftime("%Y-%m-%dT%H:%M:%SZ")
    second.lease_expires_at = (fixed_now + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    second.ack_cursor = event.id
    await space_session.flush()

    maintenance = await service.advance_safe_retention_floor(
        evaluated_at=fixed_now.strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    assert maintenance["active_client_count"] == 1
    assert maintenance["retention_floor"] == event.id


@pytest.mark.asyncio
async def test_no_active_clients_never_advances_floor_or_prunes(space_session):
    from app.models.sync_client import SyncClient
    from app.models.sync_outbox import SyncOutbox
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    event = await record_sync_event(
        space_session, entity_type="task", entity_id="no-active", action="create"
    )
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")
    client = await space_session.get(SyncClient, client_id)
    assert client is not None
    client.lease_expires_at = "2000-01-01T00:00:00Z"
    await space_session.flush()

    maintenance = await service.advance_safe_retention_floor()
    assert maintenance == {
        "retention_floor": 0,
        "current_cursor": event.id,
        "active_client_count": 0,
        "pruned_events": 0,
    }
    assert await get_retention_floor(space_session) == 0
    assert list(await space_session.scalars(select(SyncOutbox.id))) == [event.id]
