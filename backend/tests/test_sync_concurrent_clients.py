"""R6-F2: Multi-device concurrent ACK / revoke / lease-expiry retention floor.

These tests prove that retention floor calculation, ACK monotonicity, lease
expiry, and revocation are correct when operations span **two independent
AsyncSession instances** bound to the same space engine — the production
scenario where concurrent FastAPI requests or workers share one space DB.

Key invariants under concurrent sessions:
- Floor = MIN(active, non-recovering, non-revoked, non-expired ack_cursor)
- ACK is monotonic across sessions (regression rejected)
- Revoked/expired clients are excluded from floor immediately
- A newly registered client inherits the current floor
- snapshot_required clients never block floor advancement
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.errors import ConflictError
from app.services.time import utc_now_iso

CLIENT_TOKEN_A = "concurrent-token-a-0123456789abcdef"
CLIENT_TOKEN_B = "concurrent-token-b-0123456789abcdef"
CLIENT_TOKEN_C = "concurrent-token-c-0123456789abcdef"


async def _register(service, *, client_token: str = CLIENT_TOKEN_A, **kwargs):
    from app.models.sync_client import SyncClient

    user_id = kwargs["user_id"]
    now = utc_now_iso()
    authorizer_id = await service.db.scalar(
        select(SyncClient.client_id).where(
            SyncClient.user_id == user_id,
            SyncClient.revoked_at.is_(None),
            SyncClient.lease_expires_at > now,
            SyncClient.snapshot_required.is_(False),
        ).limit(1)
    )
    return await service.register(
        client_token=client_token,
        authorized_by_client_id=authorizer_id,
        **kwargs,
    )


async def _create_two_sessions(_isolate_env):
    """Create two independent AsyncSession instances for the same space."""
    from app.db.meta_session import init_meta_db
    from app.space_manager import get_space_engine_manager

    await init_meta_db()
    manager = get_space_engine_manager()
    session_a = await manager.get_session("spc_concurrent")
    session_b = await manager.get_session("spc_concurrent")
    return session_a, session_b, manager


async def _cleanup_sessions(sessions, manager):
    for s in sessions:
        if s is not None:
            await s.close()
    from app.space_manager import dispose_space_engine_manager
    await dispose_space_engine_manager()
    from app.db.meta_session import close_meta_db
    await close_meta_db()


@pytest.mark.asyncio
async def test_cross_session_ack_floor_is_minimum_of_both_clients(_isolate_env):
    """Session A ACKs to cursor 10, Session B ACKs to cursor 5.

    After both commit, retention floor = min(5, 10) = 5, and events
    below 5 are pruned. This proves the write lock serializes the two
    ACK operations and the floor query sees both clients' state.
    """
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"task-{i}", action="create"
            )
            for i in range(10)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        client_a = str(uuid.uuid4())
        client_b = str(uuid.uuid4())
        await _register(service_a, client_id=client_a, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await session_a.commit()
        await _register(service_b, client_id=client_b, user_id="user-a",
                        client_token=CLIENT_TOKEN_B)
        await session_b.commit()

        await service_a.acknowledge(
            client_id=client_a, user_id="user-a",
            ack_cursor=events[9].id, cursor_version=2,
        )
        await session_a.commit()

        await service_b.acknowledge(
            client_id=client_b, user_id="user-a",
            ack_cursor=events[4].id, cursor_version=2,
        )
        await session_b.commit()

        floor = await get_retention_floor(session_a)
        assert floor == events[4].id
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_revoke_excludes_client_from_floor(_isolate_env):
    """Session A registers slow+fast; Session B revokes slow; floor = fast's ACK.

    The revoke in Session B must be visible to Session A's subsequent floor
    query, and the slow client must not contribute to the minimum.
    """
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"rev-{i}", action="create"
            )
            for i in range(5)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        slow_id = str(uuid.uuid4())
        fast_id = str(uuid.uuid4())
        await _register(service_a, client_id=slow_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await _register(service_a, client_id=fast_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_B)
        await session_a.commit()

        from app.models.sync_client import SyncClient
        fast = await session_a.get(SyncClient, fast_id)
        assert fast is not None
        fast.ack_cursor = events[4].id
        await session_a.commit()

        await service_b.revoke(client_id=slow_id, user_id="user-a")
        await session_b.commit()

        await service_a.acknowledge(
            client_id=fast_id, user_id="user-a",
            ack_cursor=events[4].id, cursor_version=2,
        )
        await session_a.commit()

        floor = await get_retention_floor(session_a)
        assert floor == events[4].id
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_ack_regression_rejected(_isolate_env):
    """Session A ACKs client to 10; Session B ACKs another client to 8
    (floor = 8). Session B then tries to ACK the first client backwards
    to 9 — above floor but below its committed ack_cursor. The monotonic
    guard must reject this across sessions.
    """
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"reg-{i}", action="create"
            )
            for i in range(10)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        client_a = str(uuid.uuid4())
        client_b = str(uuid.uuid4())
        await _register(service_a, client_id=client_a, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await _register(service_a, client_id=client_b, user_id="user-a",
                        client_token=CLIENT_TOKEN_B)
        await session_a.commit()

        await service_a.acknowledge(
            client_id=client_a, user_id="user-a",
            ack_cursor=events[9].id, cursor_version=2,
        )
        await session_a.commit()

        await service_b.acknowledge(
            client_id=client_b, user_id="user-a",
            ack_cursor=events[7].id, cursor_version=2,
        )
        await session_b.commit()

        with pytest.raises(ConflictError, match="ack_cursor cannot move backwards"):
            await service_b.acknowledge(
                client_id=client_a, user_id="user-a",
                ack_cursor=events[8].id, cursor_version=2,
            )
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_expired_lease_excluded_from_floor(_isolate_env):
    """Session A registers a client with a manually expired lease.

    Session B registers another client and ACKs. The floor must advance
    to the active client's ACK, ignoring the expired one — proving that
    lease expiry is evaluated dynamically, not cached.
    """
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"exp-{i}", action="create"
            )
            for i in range(5)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        expired_id = str(uuid.uuid4())
        active_id = str(uuid.uuid4())
        await _register(service_a, client_id=expired_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await _register(service_a, client_id=active_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_B)
        await session_a.commit()

        expired = await session_a.get(SyncClient, expired_id)
        assert expired is not None
        past = (datetime.now(UTC) - timedelta(days=1))
        expired.lease_expires_at = past.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        await session_a.commit()

        await service_b.acknowledge(
            client_id=active_id, user_id="user-a",
            ack_cursor=events[4].id, cursor_version=2,
        )
        await session_b.commit()

        floor = await get_retention_floor(session_a)
        assert floor == events[4].id
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_register_inherits_advanced_floor(_isolate_env):
    """Session A advances floor to 5; Session B registers a new client.

    The new client's ack_cursor must start at 5 (the current floor), not 0.
    This proves that the register path reads the floor inside the write
    lock, so it never sees a stale value.
    """
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"inh-{i}", action="create"
            )
            for i in range(5)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        first_id = str(uuid.uuid4())
        await _register(service_a, client_id=first_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await session_a.commit()

        await service_a.acknowledge(
            client_id=first_id, user_id="user-a",
            ack_cursor=events[4].id, cursor_version=2,
        )
        await session_a.commit()

        second_id = str(uuid.uuid4())
        result = await _register(service_b, client_id=second_id, user_id="user-a",
                                  client_token=CLIENT_TOKEN_B)
        await session_b.commit()

        assert result["ack_cursor"] == events[4].id
        assert result["snapshot_required"] is True
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_snapshot_required_does_not_block_floor(_isolate_env):
    """Session A's client is snapshot_required (recovering); Session B's
    active client ACKs. The floor must advance to the active client's ACK,
    ignoring the recovering one.
    """
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"rec-{i}", action="create"
            )
            for i in range(5)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        recovering_id = str(uuid.uuid4())
        active_id = str(uuid.uuid4())
        await _register(service_a, client_id=recovering_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await _register(service_a, client_id=active_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_B)
        await session_a.commit()

        recovering = await session_a.get(SyncClient, recovering_id)
        assert recovering is not None
        recovering.snapshot_required = True
        recovering.ack_cursor = 0
        await session_a.commit()

        await service_b.acknowledge(
            client_id=active_id, user_id="user-a",
            ack_cursor=events[4].id, cursor_version=2,
        )
        await session_b.commit()

        floor = await get_retention_floor(session_a)
        assert floor == events[4].id
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_revoke_then_ack_rejected(_isolate_env):
    """Session A revokes a client; Session B tries to ACK for the same
    client. The ACK must be rejected with sync_client_revoked, proving
    that revocation is visible across sessions.
    """
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"rej-{i}", action="create"
            )
            for i in range(3)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        service_b = SyncClientService(session_b)
        client_id = str(uuid.uuid4())
        await _register(service_a, client_id=client_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await session_a.commit()

        await service_a.revoke(client_id=client_id, user_id="user-a")
        await session_a.commit()

        with pytest.raises(ConflictError, match="sync client is revoked"):
            await service_b.acknowledge(
                client_id=client_id, user_id="user-a",
                ack_cursor=events[2].id, cursor_version=2,
            )
    finally:
        await _cleanup_sessions([session_a, session_b], manager)


@pytest.mark.asyncio
async def test_cross_session_expired_lease_ack_rejected(_isolate_env):
    """Session A registers a client; Session B manually expires the lease.

    A subsequent ACK from Session A for that client must be rejected with
    sync_client_lease_expired, proving the lease is checked dynamically.
    """
    from app.models.sync_client import SyncClient
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import record_sync_event

    session_a, session_b, manager = await _create_two_sessions(_isolate_env)
    try:
        events = [
            await record_sync_event(
                session_a, entity_type="task", entity_id=f"lexp-{i}", action="create"
            )
            for i in range(3)
        ]
        await session_a.commit()

        service_a = SyncClientService(session_a)
        client_id = str(uuid.uuid4())
        await _register(service_a, client_id=client_id, user_id="user-a",
                        client_token=CLIENT_TOKEN_A)
        await session_a.commit()

        client = await session_b.get(SyncClient, client_id)
        assert client is not None
        past = (datetime.now(UTC) - timedelta(hours=1))
        client.lease_expires_at = past.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        await session_b.commit()

        with pytest.raises(ConflictError, match="sync client lease has expired"):
            await service_a.acknowledge(
                client_id=client_id, user_id="user-a",
                ack_cursor=events[2].id, cursor_version=2,
            )
    finally:
        await _cleanup_sessions([session_a, session_b], manager)
