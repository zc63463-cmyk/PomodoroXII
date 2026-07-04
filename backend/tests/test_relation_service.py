"""Tests for RelationService -- link/unlink quick notes to parents.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


@pytest.mark.asyncio
async def test_link_to_task(space_session):
    """link() should create a TaskQuickNote junction row."""
    from app.services.relation import RelationService

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    link = await svc.link("task", task_id, qn_id)
    assert link.task_id == task_id
    assert link.quick_note_id == qn_id


@pytest.mark.asyncio
async def test_link_is_idempotent(space_session):
    """link() called twice should return the same row, not create a duplicate."""
    from app.services.relation import RelationService

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    first = await svc.link("task", task_id, qn_id)
    second = await svc.link("task", task_id, qn_id)
    assert second.id == first.id

    items = await svc.list_quick_notes("task", task_id)
    assert len(items) == 1


@pytest.mark.asyncio
async def test_unlink_removes_row(space_session):
    """unlink() should remove the junction row."""
    from app.services.relation import RelationService
    from app.models.task_quick_note import TaskQuickNote
    from sqlalchemy import select

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    await svc.link("task", task_id, qn_id)
    await svc.unlink("task", task_id, qn_id)

    res = await space_session.execute(
        select(TaskQuickNote).where(
            TaskQuickNote.task_id == task_id,
            TaskQuickNote.quick_note_id == qn_id,
        )
    )
    assert res.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_unlink_writes_tombstone_for_task_relation(space_session):
    """unlink() should write a tombstone so sync pull propagates the deletion."""
    from app.services.relation import RelationService
    from app.services.tombstone import TombstoneService

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    link = await svc.link("task", task_id, qn_id)
    await svc.unlink("task", task_id, qn_id)

    tomb = await TombstoneService(space_session).exists("taskQuickNote", link.id)
    assert tomb is not None, "Tombstone not created for unlinked taskQuickNote"
    assert tomb.entity_type == "taskQuickNote"
    assert tomb.entity_id == link.id


@pytest.mark.asyncio
async def test_unlink_writes_tombstone_for_session_relation(space_session):
    """unlink() should write a tombstone for sessionQuickNote."""
    from app.services.relation import RelationService
    from app.services.tombstone import TombstoneService

    svc = RelationService(space_session)
    session_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    link = await svc.link("session", session_id, qn_id)
    await svc.unlink("session", session_id, qn_id)

    tomb = await TombstoneService(space_session).exists("sessionQuickNote", link.id)
    assert tomb is not None, "Tombstone not created for unlinked sessionQuickNote"


@pytest.mark.asyncio
async def test_unlink_writes_tombstone_for_schedule_relation(space_session):
    """unlink() should write a tombstone for scheduleQuickNote."""
    from app.services.relation import RelationService
    from app.services.tombstone import TombstoneService

    svc = RelationService(space_session)
    schedule_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    link = await svc.link("schedule", schedule_id, qn_id)
    await svc.unlink("schedule", schedule_id, qn_id)

    tomb = await TombstoneService(space_session).exists("scheduleQuickNote", link.id)
    assert tomb is not None, "Tombstone not created for unlinked scheduleQuickNote"


@pytest.mark.asyncio
async def test_unlink_is_idempotent_no_tombstone_when_row_missing(space_session):
    """unlink() on a non-existent row should not raise (no tombstone to write)."""
    from app.services.relation import RelationService
    from app.services.tombstone import TombstoneService

    svc = RelationService(space_session)
    # Unlink something that was never linked — should not raise.
    await svc.unlink("task", uuid.uuid4().hex, uuid.uuid4().hex)
    # No tombstone should exist for random ids.
    tomb = await TombstoneService(space_session).exists("taskQuickNote", "nonexistent")
    assert tomb is None


@pytest.mark.asyncio
async def test_list_for_task(space_session):
    """list_quick_notes() should return all junction rows for a task."""
    from app.services.relation import RelationService

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex

    await svc.link("task", task_id, uuid.uuid4().hex)
    await svc.link("task", task_id, uuid.uuid4().hex)

    items = await svc.list_quick_notes("task", task_id)
    assert len(items) == 2


@pytest.mark.asyncio
async def test_link_to_session(space_session):
    """link() should create a SessionQuickNote junction row."""
    from app.services.relation import RelationService

    svc = RelationService(space_session)
    session_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    link = await svc.link("session", session_id, qn_id)
    assert link.session_id == session_id
    assert link.quick_note_id == qn_id
