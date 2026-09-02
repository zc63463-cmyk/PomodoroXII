"""S1 fail-closed tests for sync event ledger retention."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, func, select

from app.models.sync_audit_log import SyncAuditLog
from app.models.sync_outbox import SyncOutbox
from app.services.sync_outbox import (
    advance_retention_floor,
    get_ledger_stats,
    prune_sync_events,
    record_sync_event,
)


class _RetentionLease:
    def assert_fence(self, _scope: str) -> None:
        return None


class _RetentionScope:
    def __init__(self, session) -> None:
        self.scope = SimpleNamespace(space_id="space-a")
        self._session = session

    def session_factory(self):
        session = self._session

        class _SessionContext:
            async def __aenter__(self):
                return session

            async def __aexit__(self, *_args):
                return False

        return _SessionContext()

    @asynccontextmanager
    async def exclusive_space_resources(self, _purpose: str, _timeout: float):
        yield _RetentionLease()


async def _record_events(space_session, count: int) -> list[SyncOutbox]:
    return [
        await record_sync_event(
            space_session,
            entity_type="task",
            entity_id=f"t{index}",
            action="create",
            payload={"id": f"t{index}", "v": index},
            visible=True,
        )
        for index in range(1, count + 1)
    ]


@pytest.mark.asyncio
async def test_ledger_floor_and_prune_require_client_ack(space_session) -> None:
    from app.errors import RetentionAckRequiredError
    from app.models.sync_state import SyncState

    event = (await _record_events(space_session, 1))[0]
    with pytest.raises(RetentionAckRequiredError):
        await advance_retention_floor(space_session, floor=event.id)
    with pytest.raises(RetentionAckRequiredError):
        await prune_sync_events(space_session, before_id=event.id)

    assert await get_ledger_stats(space_session) == {
        "total_events": 1,
        "min_id": event.id,
        "max_id": event.id,
    }
    state = await space_session.get(SyncState, 1)
    assert state is not None
    assert state.retention_floor == 0
    audits = (
        await space_session.execute(
            select(SyncAuditLog).where(
                SyncAuditLog.event_type.in_(
                    ["retention_floor_advanced", "retention_pruned"]
                )
            )
        )
    ).scalars().all()
    assert audits == []


@pytest.mark.asyncio
async def test_retention_rejects_before_argument_validation(space_session) -> None:
    from app.errors import RetentionAckRequiredError

    with pytest.raises(RetentionAckRequiredError):
        await advance_retention_floor(space_session, floor=-1)
    with pytest.raises(RetentionAckRequiredError):
        await prune_sync_events(space_session, before_id=-1)


@pytest.mark.asyncio
async def test_get_ledger_stats_empty(space_session) -> None:
    assert await get_ledger_stats(space_session) == {
        "total_events": 0,
        "min_id": None,
        "max_id": None,
    }


@pytest.mark.asyncio
async def test_get_ledger_stats_populated(space_session) -> None:
    events = await _record_events(space_session, 2)
    assert await get_ledger_stats(space_session) == {
        "total_events": 2,
        "min_id": events[0].id,
        "max_id": events[1].id,
    }


@pytest.mark.asyncio
async def test_cursor_expired_read_uses_explicit_fixture_state(space_session) -> None:
    from app.errors import SyncCursorExpiredError
    from app.models.sync_state import SyncState
    from app.services.sync import SyncService

    events = await _record_events(space_session, 2)
    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.retention_floor = events[0].id
    await space_session.execute(
        delete(SyncOutbox).where(SyncOutbox.id <= events[0].id)
    )
    await space_session.flush()

    with pytest.raises(SyncCursorExpiredError) as raised:
        await SyncService(space_session).pull(cursor=0, limit=10)
    assert raised.value.floor == events[0].id
    assert raised.value.current_cursor == events[1].id


@pytest.mark.asyncio
async def test_ack_waterline_prunes_visible_ledger_and_linked_tombstones(
    space_session,
) -> None:
    from app.models.sync_client import SyncClient
    from app.models.sync_state import SyncState
    from app.models.tombstone import Tombstone
    from app.sync.retention import RetentionCoordinator

    events = await _record_events(space_session, 10)
    state = await space_session.get(SyncState, 1)
    assert state is not None
    assert state.current_cursor == events[-1].id
    space_session.add_all(
        [
            SyncClient(
                client_id="client-a",
                ack_sequence=5,
                catalog_hash="c" * 64,
                registered_at="2026-08-01T00:00:00.000Z",
                last_seen_at="2026-08-01T00:00:00.000Z",
                expires_at="2099-08-01T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            ),
            SyncClient(
                client_id="client-b",
                ack_sequence=8,
                catalog_hash="c" * 64,
                registered_at="2026-08-01T00:00:00.000Z",
                last_seen_at="2026-08-01T00:00:00.000Z",
                expires_at="2099-08-01T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            ),
        ]
    )
    space_session.add_all(
        [
            Tombstone(entity_type="task", entity_id="at-four", delete_sequence=4),
            Tombstone(entity_type="task", entity_id="at-six", delete_sequence=6),
            Tombstone(entity_type="task", entity_id="legacy", delete_sequence=None),
        ]
    )
    await space_session.flush()
    await space_session.commit()

    result = await RetentionCoordinator("c" * 64, 30).prune(
        _RetentionScope(space_session)
    )
    assert result.waterline == 5
    assert result.ledger_rows == 5
    assert result.tombstones == 1
    assert await space_session.scalar(select(func.count()).select_from(SyncOutbox)) == 5
    remaining_tombstones = (
        await space_session.execute(select(Tombstone).order_by(Tombstone.entity_id))
    ).scalars().all()
    assert {row.entity_id for row in remaining_tombstones} == {"at-six", "legacy"}
    state = await space_session.get(SyncState, 1)
    assert state is not None
    await space_session.refresh(state)
    assert state.retention_floor == 5
    assert state.current_cursor == 10


@pytest.mark.asyncio
async def test_prune_recreates_missing_state_from_allocated_high_watermark(
    space_session,
) -> None:
    from app.models.sync_client import SyncClient
    from app.models.sync_state import SyncState
    from app.sync.retention import RetentionCoordinator

    event = (await _record_events(space_session, 1))[0]
    state = await space_session.get(SyncState, 1)
    assert state is not None
    await space_session.delete(state)
    space_session.add(
        SyncClient(
            client_id="client-a",
            ack_sequence=event.id,
            catalog_hash="c" * 64,
            registered_at="2026-08-01T00:00:00.000Z",
            last_seen_at="2026-08-01T00:00:00.000Z",
            expires_at="2099-08-01T00:00:00.000Z",
            requires_recovery=False,
            recovery_generation=0,
        )
    )
    await space_session.flush()
    await space_session.commit()

    result = await RetentionCoordinator("c" * 64, 30).prune(
        _RetentionScope(space_session)
    )

    assert result.waterline == event.id
    state = await space_session.get(SyncState, 1)
    assert state is not None
    assert state.current_cursor == event.id
    assert state.retention_floor == event.id


@pytest.mark.asyncio
async def test_retention_invariant_is_raised_after_bounded_maintenance_commits(
    space_session,
) -> None:
    from app.models.sync_client import SyncClient
    from app.models.sync_state import SyncState
    from app.sync.retention import RetentionCoordinator

    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.current_cursor = 0
    space_session.add_all(
        [
            SyncClient(
                client_id=f"expired-client-{index:03d}",
                ack_sequence=2,
                catalog_hash="c" * 64,
                registered_at="2020-01-01T00:00:00.000Z",
                last_seen_at="2020-01-01T00:00:00.000Z",
                expires_at="2020-01-02T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
            for index in range(101)
        ]
    )
    await space_session.flush()
    await space_session.commit()

    with pytest.raises(RuntimeError, match="ack waterline exceeds allocated cursor"):
        await RetentionCoordinator("c" * 64, 30).prune(
            _RetentionScope(space_session)
        )

    assert await space_session.get(SyncClient, "expired-client-000") is None
    unprocessed = await space_session.get(SyncClient, "expired-client-100")
    assert unprocessed is not None
    assert unprocessed.requires_recovery is False


@pytest.mark.asyncio
async def test_expiry_maintenance_is_bounded_and_reaches_the_101st_client(
    space_session,
) -> None:
    from app.models.sync_client import SyncClient
    from app.sync.clients import SyncClientRegistry

    space_session.add_all(
        [
            SyncClient(
                client_id=f"client-{index:03d}",
                ack_sequence=3,
                catalog_hash="c" * 64,
                registered_at="2020-01-01T00:00:00.000Z",
                last_seen_at="2020-01-01T00:00:00.000Z",
                expires_at="2020-01-02T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
            for index in range(101)
        ]
    )
    await space_session.flush()
    registry = SyncClientRegistry(space_session, "c" * 64, 30, space_id="space-a")
    first = await registry.expire_inactive()
    assert len(first) == 100
    assert await registry.minimum_safe_retention_sequence() == 3
    second = await registry.expire_inactive()
    assert len(second) == 1
    assert await registry.minimum_safe_retention_sequence() is None


@pytest.mark.asyncio
async def test_prune_waterline_follows_the_slowest_client_not_the_fastest(
    space_session,
) -> None:
    """Retention follows the *minimum* ACK, never the maximum.

    A client that has been offline for a long time must hold the waterline
    back, so every event it has not consumed yet survives the sweep. Pruning
    to the fastest client would silently destroy unconsumed history.
    """
    from app.models.sync_client import SyncClient
    from app.sync.retention import RetentionCoordinator

    events = await _record_events(space_session, 10)
    allocated_ids = sorted(event.id for event in events)
    assert len(allocated_ids) == 10

    space_session.add_all(
        [
            SyncClient(
                client_id="slow-client",
                ack_sequence=3,
                catalog_hash="c" * 64,
                registered_at="2026-08-01T00:00:00.000Z",
                last_seen_at="2026-08-01T00:00:00.000Z",
                expires_at="2099-08-01T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            ),
            SyncClient(
                client_id="fast-client",
                ack_sequence=9,
                catalog_hash="c" * 64,
                registered_at="2026-08-01T00:00:00.000Z",
                last_seen_at="2026-08-01T00:00:00.000Z",
                expires_at="2099-08-01T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            ),
        ]
    )
    await space_session.flush()
    await space_session.commit()

    result = await RetentionCoordinator("c" * 64, 30).prune(
        _RetentionScope(space_session)
    )

    # The slow client decides the waterline, not the fast one.
    assert result.waterline == 3
    assert result.ledger_rows == 3

    remaining = (
        await space_session.execute(select(SyncOutbox).order_by(SyncOutbox.id))
    ).scalars().all()
    remaining_ids = sorted(row.id for row in remaining)

    # Every event the slow client has not ACKed yet is still on disk.
    assert remaining_ids == [event_id for event_id in allocated_ids if event_id > 3]
    assert 4 in remaining_ids
    assert 10 in remaining_ids


# --------------------------------------------------------------------------- #
# HTTP surface: POST /api/v1/sync/v2/retention/prune
# --------------------------------------------------------------------------- #


async def _space_headers(client) -> dict[str, str]:
    """Bootstrap auth, create a space, return space-token headers."""
    resp = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert resp.status_code == 200, resp.text
    master = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    resp = await client.post(
        "/api/v1/spaces", json={"name": "Retention Space"}, headers=master
    )
    assert resp.status_code == 201, resp.text
    space_id = resp.json()["id"]

    resp = await client.post(f"/api/v1/spaces/{space_id}/token", headers=master)
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['space_token']}"}


@pytest.mark.provisioned_space_storage
class TestRetentionPruneHTTP:
    """The scheduled retention entry point.

    Coordinator-level pruning is covered above. These cover the **HTTP
    contract** that an external scheduler depends on
    (``scripts/prune_sync_ledgers.py``): status code, response shape,
    auth requirement, and idempotency — none of which the coordinator
    tests exercise.
    """

    async def test_prune_returns_expected_shape(self, client) -> None:
        headers = await _space_headers(client)

        resp = await client.post("/api/v1/sync/v2/retention/prune", headers=headers)

        assert resp.status_code == 200, resp.text
        # An empty ledger prunes nothing, but must still report a coherent shape.
        assert {"waterline", "ledger_rows", "tombstones"} <= set(resp.json())

    async def test_prune_is_idempotent(self, client) -> None:
        """Running prune twice in a row must be safe — schedulers will."""
        headers = await _space_headers(client)

        first = await client.post("/api/v1/sync/v2/retention/prune", headers=headers)
        second = await client.post("/api/v1/sync/v2/retention/prune", headers=headers)

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert first.json() == second.json()

    async def test_prune_requires_space_token(self, client) -> None:
        resp = await client.post("/api/v1/sync/v2/retention/prune")

        assert resp.status_code in (401, 403), resp.text
