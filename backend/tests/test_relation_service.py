"""Tests for RelationService -- link/unlink quick notes to schedules.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


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
