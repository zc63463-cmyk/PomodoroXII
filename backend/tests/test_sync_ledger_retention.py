"""S1 fail-closed tests for sync event ledger retention."""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from app.models.sync_audit_log import SyncAuditLog
from app.models.sync_outbox import SyncOutbox
from app.services.sync_outbox import (
    advance_retention_floor,
    get_ledger_stats,
    prune_sync_events,
    record_sync_event,
)


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
