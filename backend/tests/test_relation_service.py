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
