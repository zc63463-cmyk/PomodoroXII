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
    assert below.value.error_type == "sync_recovery_proof_required"
    with pytest.raises(ConflictError) as above:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=second.id + 1, cursor_version=2
        )
    assert above.value.error_type == "sync_recovery_proof_required"

    with pytest.raises(ConflictError) as snapshot_required:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=first.id, cursor_version=2
        )
    assert snapshot_required.value.error_type == "sync_recovery_proof_required"

    row = await space_session.get(SyncClient, client_id)
    assert row is not None
    row.snapshot_required = False
    await space_session.flush()
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
async def test_ack_rejects_expired_lease_without_mutating_client_or_floor(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    event = await record_sync_event(
        space_session, entity_type="task", entity_id="expired-ack", action="create"
    )
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")
    row = await space_session.get(SyncClient, client_id)
    assert row is not None
    row.lease_expires_at = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
    original_ack = row.ack_cursor
    original_seen = row.last_seen_at
    original_floor = await get_retention_floor(space_session)
    await space_session.flush()

    with pytest.raises(ConflictError) as expired:
        await service.acknowledge(
            client_id=client_id,
            user_id="user-a",
            space_id="space-a",
            ack_cursor=event.id,
            cursor_version=2,
        )

    assert expired.value.error_type == "sync_client_lease_expired"
    await space_session.refresh(row)
    assert row.ack_cursor == original_ack
    assert row.last_seen_at == original_seen
    assert row.lease_expires_at <= utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
    assert await get_retention_floor(space_session) == original_floor


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
    assert blocked.value.error_type == "sync_recovery_proof_required"


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
@pytest.mark.parametrize("cursor_position", ["floor", "floor_plus_one", "current"])
async def test_snapshot_required_client_rejects_bare_ack_at_every_valid_cursor(
    space_session, cursor_position
):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import advance_retention_floor, record_sync_event

    events = [
        await record_sync_event(
            space_session,
            entity_type="task",
            entity_id=f"proof-required-{index}",
            action="create",
        )
        for index in range(3)
    ]
    await advance_retention_floor(space_session, floor=events[0].id)
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    registered = await service.register(client_id=client_id, user_id="user-a")
    assert registered["snapshot_required"] is True
    cursors = {
        "floor": events[0].id,
        "floor_plus_one": events[0].id + 1,
        "current": events[-1].id,
    }

    with pytest.raises(ConflictError) as blocked:
        await service.acknowledge(
            client_id=client_id,
            user_id="user-a",
            space_id="space-a",
            ack_cursor=cursors[cursor_position],
            cursor_version=2,
        )

    assert blocked.value.error_type == "sync_recovery_proof_required"
    row = await space_session.get(SyncClient, client_id)
    assert row is not None
    assert row.ack_cursor == events[0].id
    assert row.snapshot_required is True


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


@pytest.mark.asyncio
async def test_list_clients_is_user_scoped_stably_sorted_and_reports_status(space_session):
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService

    service = SyncClientService(space_session)
    client_ids = [str(uuid.uuid4()) for _ in range(5)]
    for client_id in client_ids:
        await service.register(client_id=client_id, user_id="user-a", display_name=client_id[-4:])
    await service.register(client_id=str(uuid.uuid4()), user_id="user-b", display_name="hidden")

    active, expired, recovering, revoked, tie = [
        await space_session.get(SyncClient, client_id) for client_id in client_ids
    ]
    assert all(row is not None for row in (active, expired, recovering, revoked, tie))
    active.created_at = "2026-01-01T00:00:00Z"
    expired.created_at = "2026-01-02T00:00:00Z"
    expired.lease_expires_at = "2000-01-01T00:00:00Z"
    recovering.created_at = "2026-01-03T00:00:00Z"
    recovering.snapshot_required = True
    revoked.created_at = "2026-01-04T00:00:00Z"
    revoked.revoked_at = "2026-01-05T00:00:00Z"
    tie.created_at = active.created_at
    await space_session.flush()

    result = await service.list_clients(user_id="user-a")

    assert [item["client_id"] for item in result] == sorted(
        client_ids, key=lambda value: (
            "2026-01-01T00:00:00Z" if value in (active.client_id, tie.client_id) else {
                expired.client_id: "2026-01-02T00:00:00Z",
                recovering.client_id: "2026-01-03T00:00:00Z",
                revoked.client_id: "2026-01-04T00:00:00Z",
            }[value],
            value,
        )
    )
    assert {item["status"] for item in result} == {
        "active", "expired", "recovering", "revoked"
    }
    assert all(
        set(item) == {
            "client_id", "display_name", "ack_cursor", "last_seen_at",
            "lease_expires_at", "created_at", "snapshot_required", "revoked_at", "status",
        }
        for item in result
    )
    assert "hidden" not in {item["display_name"] for item in result}


@pytest.mark.asyncio
async def test_revoke_is_owner_scoped_idempotent_and_blocks_client_lifecycle(space_session):
    from app.services.sync_clients import SyncClientService

    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")

    for requester in ("user-b", "user-a"):
        target = client_id if requester == "user-b" else str(uuid.uuid4())
        with pytest.raises(NotFoundError) as missing:
            await service.revoke(client_id=target, user_id=requester)
        assert missing.value.error_type == "sync_client_not_found"

    revoked = await service.revoke(client_id=client_id, user_id="user-a")
    repeated = await service.revoke(client_id=client_id, user_id="user-a")
    assert repeated == revoked
    assert revoked["revoked_at"]

    with pytest.raises(ConflictError) as register_error:
        await service.register(client_id=client_id, user_id="user-a")
    assert register_error.value.error_type == "sync_client_revoked"
    with pytest.raises(ConflictError) as ack_error:
        await service.acknowledge(
            client_id=client_id, user_id="user-a", ack_cursor=0, cursor_version=2
        )
    assert ack_error.value.error_type == "sync_client_revoked"
    with pytest.raises(ConflictError) as full_error:
        await service.validate_snapshot_client(client_id=client_id, user_id="user-a")
    assert full_error.value.error_type == "sync_client_revoked"
    with pytest.raises(ConflictError) as proof_error:
        await service.validate_snapshot_client(
            client_id=client_id, user_id="user-a", require_recovery=True
        )
    assert proof_error.value.error_type == "sync_client_revoked"


@pytest.mark.asyncio
async def test_revoke_slow_client_advances_floor_and_prunes_in_same_transaction(space_session):
    from app.models.sync_client import SyncClient
    from app.models.sync_outbox import SyncOutbox
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    events = [
        await record_sync_event(
            space_session, entity_type="task", entity_id=f"revoke-{index}", action="create"
        )
        for index in range(3)
    ]
    service = SyncClientService(space_session)
    slow_id, fast_id = str(uuid.uuid4()), str(uuid.uuid4())
    await service.register(client_id=slow_id, user_id="user-a")
    await service.register(client_id=fast_id, user_id="user-a")
    fast = await space_session.get(SyncClient, fast_id)
    assert fast is not None
    fast.ack_cursor = events[-1].id
    await space_session.flush()

    result = await service.revoke(client_id=slow_id, user_id="user-a")

    assert result["retention_floor"] == events[-1].id
    assert result["active_client_count"] == 1
    assert result["pruned_events"] == 3
    assert await get_retention_floor(space_session) == events[-1].id
    assert list(await space_session.scalars(select(SyncOutbox.id))) == []


@pytest.mark.asyncio
async def test_revoke_last_active_client_does_not_advance_floor_or_delete_unbound_snapshot(
    space_session,
):
    from app.models.sync_state import SyncSnapshot, SyncSnapshotChunk
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    event = await record_sync_event(
        space_session, entity_type="task", entity_id="last-revoked", action="create"
    )
    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())
    await service.register(client_id=client_id, user_id="user-a")
    token = str(uuid.uuid4())
    space_session.add(
        SyncSnapshot(
            token=token, cursor=event.id, status="ready", expires_at="2099-01-01T00:00:00Z"
        )
    )
    space_session.add(
        SyncSnapshotChunk(
            snapshot_token=token, chunk_index=0, item_start=0, item_count=0,
            compressed_payload=b"", uncompressed_bytes=0, compressed_bytes=0,
            checksum="0" * 64,
        )
    )
    await space_session.flush()

    result = await service.revoke(client_id=client_id, user_id="user-a")

    assert result["retention_floor"] == 0
    assert result["active_client_count"] == 0
    assert result["pruned_events"] == 0
    assert await get_retention_floor(space_session) == 0
    assert await space_session.get(SyncSnapshot, token) is not None
    assert await space_session.get(SyncSnapshotChunk, (token, 0)) is not None
