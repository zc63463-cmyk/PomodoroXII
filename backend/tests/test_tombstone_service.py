"""Tests for TombstoneService — idempotent deletion tracking.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


@pytest.mark.asyncio
async def test_create_writes_tombstone_with_entity_type_and_id(space_session):
    """create() should insert a tombstone row with the given type and id."""
    from app.models.tombstone import Tombstone
    from app.services.tombstone import TombstoneService

    svc = TombstoneService(space_session)
    entity_id = uuid.uuid4().hex
    tomb = await svc.create("task", entity_id)
    assert tomb.entity_type == "task"
    assert tomb.entity_id == entity_id
    assert tomb.deleted_at is not None
    assert tomb.deleted_at.endswith("Z")


@pytest.mark.asyncio
async def test_create_is_idempotent_duplicate_does_not_raise(space_session):
    """create() on the same (type, id) should return existing, not raise."""
    from app.models.tombstone import Tombstone
    from app.services.tombstone import TombstoneService

    svc = TombstoneService(space_session)
    entity_id = uuid.uuid4().hex
    first = await svc.create("note", entity_id)
    # Second call should not raise IntegrityError.
    second = await svc.create("note", entity_id)
    assert second.id == first.id


@pytest.mark.asyncio
async def test_exists_returns_true_for_recorded_entity(space_session):
    """exists() should return the tombstone for a recorded entity."""
    from app.services.tombstone import TombstoneService

    svc = TombstoneService(space_session)
    entity_id = uuid.uuid4().hex
    await svc.create("task", entity_id)
    result = await svc.exists("task", entity_id)
    assert result is not None
    assert result.entity_id == entity_id


@pytest.mark.asyncio
async def test_exists_returns_false_for_unknown_entity(space_session):
    """exists() should return None for an unknown entity."""
    from app.services.tombstone import TombstoneService

    svc = TombstoneService(space_session)
    result = await svc.exists("task", "nonexistent-entity-id")
    assert result is None


@pytest.mark.asyncio
async def test_cleanup_expired_removes_old_tombstones_returns_count(space_session):
    """cleanup_expired() should remove tombstones older than TTL and return count."""
    from datetime import timedelta

    from app.models.tombstone import Tombstone
    from app.services.time import utc_now
    from app.services.tombstone import TombstoneService

    svc = TombstoneService(space_session)
    # Insert a tombstone with deleted_at 100 days ago.
    old_time = (utc_now() - timedelta(days=100)).strftime("%Y-%m-%dT%H:%M:%SZ")
    old_tomb = Tombstone(entity_type="task", entity_id=uuid.uuid4().hex, deleted_at=old_time)
    space_session.add(old_tomb)
    await space_session.flush()
    # Insert a recent one.
    await svc.create("note", uuid.uuid4().hex)
    # Cleanup with default TTL (90 days).
    count = await svc.cleanup_expired()
    assert count == 1


@pytest.mark.asyncio
async def test_cleanup_expired_keeps_recent_tombstones(space_session):
    """cleanup_expired() should not remove tombstones within the TTL window."""
    from app.services.tombstone import TombstoneService

    svc = TombstoneService(space_session)
    # Insert a recent tombstone.
    await svc.create("task", uuid.uuid4().hex)
    count = await svc.cleanup_expired()
    assert count == 0
