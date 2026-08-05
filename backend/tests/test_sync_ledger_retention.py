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
    registry = SyncClientRegistry(space_session, "c" * 64, 30)
    first = await registry.expire_inactive()
    assert len(first) == 100
    assert await registry.minimum_safe_retention_sequence() == 3
    second = await registry.expire_inactive()
    assert len(second) == 1
    assert await registry.minimum_safe_retention_sequence() is None
