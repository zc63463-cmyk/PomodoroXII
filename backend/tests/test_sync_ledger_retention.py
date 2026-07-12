"""H2-E tests for sync event ledger retention (prune + stats)."""
from __future__ import annotations

import pytest
from sqlalchemy import event, select

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
        )
        for index in range(1, count + 1)
    ]


@pytest.mark.asyncio
async def test_prune_removes_events_up_to_persisted_floor(space_session):
    events = await _record_events(space_session, 3)
    await advance_retention_floor(space_session, floor=events[1].id)

    pruned = await prune_sync_events(space_session, before_id=events[1].id)

    assert pruned == 2
    remaining = (
        await space_session.execute(select(SyncOutbox).order_by(SyncOutbox.id))
    ).scalars().all()
    assert [event.id for event in remaining] == [events[2].id]
    audits = (
        await space_session.execute(
            select(SyncAuditLog).where(
                SyncAuditLog.event_type.in_([
                    "retention_floor_advanced",
                    "retention_pruned",
                ])
            )
        )
    ).scalars().all()
    assert [audit.event_type for audit in audits] == [
        "retention_floor_advanced",
        "retention_pruned",
    ]


@pytest.mark.asyncio
async def test_prune_zero_before_id_removes_nothing(space_session):
    await _record_events(space_session, 1)
    await advance_retention_floor(space_session, floor=0)
    assert await prune_sync_events(space_session, before_id=0) == 0


@pytest.mark.asyncio
async def test_prune_all_events_uses_current_cursor_not_arbitrary_large_value(space_session):
    events = await _record_events(space_session, 2)
    current_cursor = events[-1].id
    await advance_retention_floor(space_session, floor=current_cursor)

    assert await prune_sync_events(space_session, before_id=current_cursor) == 2
    assert (await space_session.execute(select(SyncOutbox))).scalars().all() == []


@pytest.mark.asyncio
async def test_prune_rejects_negative_before_id(space_session):
    with pytest.raises(ValueError, match="before_id must be >= 0"):
        await prune_sync_events(space_session, before_id=-1)


@pytest.mark.asyncio
async def test_prune_fails_closed_before_floor_is_advanced(space_session):
    await _record_events(space_session, 1)
    with pytest.raises(ValueError, match="persisted retention floor"):
        await prune_sync_events(space_session, before_id=1)


@pytest.mark.asyncio
async def test_prune_rejects_before_id_above_persisted_floor(space_session):
    await _record_events(space_session, 2)
    await advance_retention_floor(space_session, floor=1)
    with pytest.raises(ValueError, match="persisted retention floor"):
        await prune_sync_events(space_session, before_id=2)


@pytest.mark.asyncio
async def test_advance_retention_floor_rejects_above_current_cursor(space_session):
    event_row = (await _record_events(space_session, 1))[0]
    with pytest.raises(ValueError, match="exceeds current cursor"):
        await advance_retention_floor(space_session, floor=event_row.id + 1)


@pytest.mark.asyncio
async def test_advance_retention_floor_rejects_moving_backwards(space_session):
    events = await _record_events(space_session, 2)
    await advance_retention_floor(space_session, floor=events[-1].id)
    with pytest.raises(ValueError, match="must not move backwards"):
        await advance_retention_floor(space_session, floor=events[0].id)


@pytest.mark.asyncio
async def test_get_ledger_stats_empty(space_session):
    assert await get_ledger_stats(space_session) == {
        "total_events": 0,
        "min_id": None,
        "max_id": None,
    }


@pytest.mark.asyncio
async def test_get_ledger_stats_populated(space_session):
    events = await _record_events(space_session, 2)
    stats = await get_ledger_stats(space_session)
    assert stats == {
        "total_events": 2,
        "min_id": events[0].id,
        "max_id": events[1].id,
    }


@pytest.mark.asyncio
async def test_prune_then_pull_cursor_still_works(space_session):
    from app.services.sync import SyncService

    events = await _record_events(space_session, 3)
    await advance_retention_floor(space_session, floor=events[0].id)
    await prune_sync_events(space_session, before_id=events[0].id)

    page = await SyncService(space_session).pull(cursor=events[0].id, limit=100)
    assert {item["id"] for item in page["tasks"]} == {"t2", "t3"}


@pytest.mark.asyncio
async def test_prune_uses_bulk_delete_and_stats_use_one_query(space_session):
    await _record_events(space_session, 20)
    await advance_retention_floor(space_session, floor=10)
    statements: list[str] = []
    bind = space_session.get_bind()

    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.strip().upper())

    event.listen(bind, "before_cursor_execute", capture)
    try:
        pruned = await prune_sync_events(space_session, before_id=10)
        stats = await get_ledger_stats(space_session)
    finally:
        event.remove(bind, "before_cursor_execute", capture)

    assert pruned == 10
    assert stats["total_events"] == 10
    assert sum(statement.startswith("DELETE FROM SYNC_OUTBOX") for statement in statements) == 1
    assert sum(
        statement.startswith("SELECT") and "COUNT(SYNC_OUTBOX.ID)" in statement
        for statement in statements
    ) == 1


@pytest.mark.asyncio
async def test_pull_below_persisted_floor_returns_cursor_expired(space_session):
    from app.errors import SyncCursorExpiredError
    from app.services.sync import SyncService

    event_row = (await _record_events(space_session, 1))[0]
    await advance_retention_floor(space_session, floor=event_row.id)
    await prune_sync_events(space_session, before_id=event_row.id)

    with pytest.raises(SyncCursorExpiredError) as raised:
        await SyncService(space_session).pull(cursor=0, limit=10)

    assert raised.value.floor == event_row.id
    assert raised.value.current_cursor == event_row.id
    assert raised.value.recovery_action == "full_sync"
