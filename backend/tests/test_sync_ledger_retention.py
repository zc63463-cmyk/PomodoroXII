"""H2-E tests for sync event ledger retention (prune + stats)."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.sync_outbox import SyncOutbox
from app.services.sync_outbox import get_ledger_stats, prune_sync_events, record_sync_event


@pytest.mark.asyncio
async def test_prune_removes_events_up_to_before_id(space_session):
    """prune_sync_events(before_id=N) removes all events with id <= N."""
    await record_sync_event(
        space_session, entity_type="task", entity_id="t1", action="create",
        payload={"v": 1},
    )
    e2 = await record_sync_event(
        space_session, entity_type="task", entity_id="t2", action="create",
        payload={"v": 2},
    )
    e3 = await record_sync_event(
        space_session, entity_type="task", entity_id="t3", action="create",
        payload={"v": 3},
    )

    pruned = await prune_sync_events(space_session, before_id=e2.id)
    assert pruned == 2

    remaining = (
        await space_session.execute(select(SyncOutbox).order_by(SyncOutbox.id))
    ).scalars().all()
    assert len(remaining) == 1
    assert remaining[0].id == e3.id


@pytest.mark.asyncio
async def test_prune_zero_before_id_removes_nothing(space_session):
    """prune_sync_events(before_id=0) removes nothing (id=0 doesn't exist)."""
    await record_sync_event(
        space_session, entity_type="task", entity_id="t1", action="create",
    )
    pruned = await prune_sync_events(space_session, before_id=0)
    assert pruned == 0


@pytest.mark.asyncio
async def test_prune_all_events(space_session):
    """prune_sync_events with a very large before_id removes everything."""
    await record_sync_event(
        space_session, entity_type="task", entity_id="t1", action="create",
    )
    await record_sync_event(
        space_session, entity_type="note", entity_id="n1", action="create",
    )

    pruned = await prune_sync_events(space_session, before_id=999999)
    assert pruned == 2

    remaining = (
        await space_session.execute(select(SyncOutbox))
    ).scalars().all()
    assert len(remaining) == 0


@pytest.mark.asyncio
async def test_prune_rejects_negative_before_id(space_session):
    """prune_sync_events rejects negative before_id."""
    with pytest.raises(ValueError, match="before_id must be >= 0"):
        await prune_sync_events(space_session, before_id=-1)


@pytest.mark.asyncio
async def test_get_ledger_stats_empty(space_session):
    """get_ledger_stats on empty ledger returns zeros and null min/max."""
    stats = await get_ledger_stats(space_session)
    assert stats["total_events"] == 0
    assert stats["min_id"] is None
    assert stats["max_id"] is None


@pytest.mark.asyncio
async def test_get_ledger_stats_populated(space_session):
    """get_ledger_stats returns correct counts and min/max after inserts."""
    e1 = await record_sync_event(
        space_session, entity_type="task", entity_id="t1", action="create",
    )
    e2 = await record_sync_event(
        space_session, entity_type="task", entity_id="t2", action="update",
    )

    stats = await get_ledger_stats(space_session)
    assert stats["total_events"] == 2
    assert stats["min_id"] == e1.id
    assert stats["max_id"] == e2.id


@pytest.mark.asyncio
async def test_prune_then_pull_cursor_still_works(space_session):
    """After pruning old events, cursor pull with a newer cursor still works."""
    from app.services.sync import SyncService

    e1 = await record_sync_event(
        space_session, entity_type="task", entity_id="t1", action="create",
        payload={"id": "t1", "title": "first"},
    )
    await record_sync_event(
        space_session, entity_type="task", entity_id="t2", action="create",
        payload={"id": "t2", "title": "second"},
    )
    await record_sync_event(
        space_session, entity_type="task", entity_id="t3", action="create",
        payload={"id": "t3", "title": "third"},
    )

    # Prune everything up to e1 (keep e2 and e3).
    await prune_sync_events(space_session, before_id=e1.id)

    # Pull with cursor=e1.id should return e2 and e3.
    svc = SyncService(space_session, fs=None)
    page = await svc.pull(cursor=e1.id, limit=100)
    task_ids = [t["id"] for t in page.get("tasks", [])]
    assert set(task_ids) == {"t2", "t3"}
    assert page["has_more"] is False
