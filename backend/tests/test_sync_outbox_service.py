"""Tests for the H2-A sync event ledger (sync_outbox service).

Verifies:
- record_sync_event appends one row per call.
- Repeated mutations produce distinct events (no dedup).
- Transaction rollback also rolls back ledger rows.
- payload with NaN is rejected (strict JSON).
- BaseService create/update/delete append events when entity_type is set.
- BaseService skips events when record_sync_events=False (sync_mode).
- flush=False defers the flush to the caller.
"""
from __future__ import annotations

import json
from math import nan

import pytest
from sqlalchemy import select

from app.models.sync_outbox import SyncOutbox
from app.models.task import Task
from app.services.base import BaseService
from app.services.sync_outbox import record_sync_event


@pytest.mark.asyncio
async def test_record_sync_event_appends_one_row(space_session):
    """A single call must produce exactly one ledger row."""
    await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="tsk_test_001",
        action="create",
        payload={"title": "Test Task"},
    )
    rows = (
        await space_session.execute(select(SyncOutbox))
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].entity_type == "task"
    assert rows[0].entity_id == "tsk_test_001"
    assert rows[0].action == "create"
    assert json.loads(rows[0].payload)["title"] == "Test Task"


@pytest.mark.asyncio
async def test_record_sync_event_keeps_repeated_mutations_as_distinct_events(space_session):
    """Two mutations on the same entity must produce two separate rows."""
    await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="tsk_dup",
        action="create",
        payload={"title": "First"},
    )
    await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="tsk_dup",
        action="update",
        payload={"title": "Second"},
    )
    rows = (
        await space_session.execute(
            select(SyncOutbox).where(SyncOutbox.entity_id == "tsk_dup")
        )
    ).scalars().all()
    assert len(rows) == 2
    assert rows[0].action == "create"
    assert rows[1].action == "update"


@pytest.mark.asyncio
async def test_record_sync_event_rejects_nan_in_payload(space_session):
    """NaN must be rejected — it is not valid JSON."""
    with pytest.raises(ValueError, match="Out of range float"):
        await record_sync_event(
            space_session,
            entity_type="task",
            entity_id="tsk_nan",
            action="create",
            payload={"score": nan},
        )


@pytest.mark.asyncio
async def test_record_sync_event_flush_false_does_not_assign_id_until_caller_flushes(
    space_session,
):
    """flush=False must defer ID assignment to the caller's flush."""
    event = await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="tsk_noflush",
        action="create",
        flush=False,
    )
    # Without flush, the DB has not assigned an id yet.
    assert event.id is None

    await space_session.flush()
    assert event.id is not None

    rows = (
        await space_session.execute(
            select(SyncOutbox).where(SyncOutbox.entity_id == "tsk_noflush")
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].id is not None


@pytest.mark.asyncio
async def test_base_service_mutations_append_create_update_delete_events(space_session):
    """BaseService CRUD must append create/update/delete events."""

    class _TaskService(BaseService):
        model = Task
        entity_type = "task"

    svc = _TaskService(space_session)
    obj = await svc.create({"id": "tsk_crud", "title": "CRUD Test"})
    assert obj.id == "tsk_crud"

    await svc.update("tsk_crud", {"title": "Updated"})
    await svc.delete("tsk_crud")

    rows = (
        await space_session.execute(
            select(SyncOutbox)
            .where(SyncOutbox.entity_id == "tsk_crud")
            .order_by(SyncOutbox.id.asc())
        )
    ).scalars().all()
    assert len(rows) == 3
    assert rows[0].action == "create"
    assert rows[1].action == "update"
    assert rows[2].action == "delete"


@pytest.mark.asyncio
async def test_base_service_skips_events_when_record_sync_events_false(space_session):
    """sync_mode (record_sync_events=False) must not write ledger events."""

    class _TaskService(BaseService):
        model = Task
        entity_type = "task"

    svc = _TaskService(space_session, record_sync_events=False)
    await svc.create({"id": "tsk_silent", "title": "Silent"})

    rows = (
        await space_session.execute(
            select(SyncOutbox).where(SyncOutbox.entity_id == "tsk_silent")
        )
    ).scalars().all()
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_rollback_rolls_back_ledger_rows(space_session):
    """If the surrounding transaction rolls back, ledger rows must disappear."""
    async with space_session.begin_nested() as savepoint:
        await record_sync_event(
            space_session,
            entity_type="task",
            entity_id="tsk_rb",
            action="create",
            payload={"title": "Rollback Me"},
        )
        await savepoint.rollback()

    rows = (
        await space_session.execute(
            select(SyncOutbox).where(SyncOutbox.entity_id == "tsk_rb")
        )
    ).scalars().all()
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_record_sync_event_payload_is_sorted_and_utf8_safe(space_session):
    """payload JSON must use sort_keys and ensure_ascii=False."""
    await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="tsk_utf8",
        action="create",
        payload={"z": "last", "a": "first", "unicode": "你好世界"},
    )
    row = (
        await space_session.execute(
            select(SyncOutbox).where(SyncOutbox.entity_id == "tsk_utf8")
        )
    ).scalars().first()
    raw = row.payload
    assert raw.index('"a"') < raw.index('"unicode"') < raw.index('"z"')
    assert "你好世界" in raw
