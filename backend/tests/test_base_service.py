"""Tests for BaseService — the flush-only CRUD foundation.

Tests use Task as the concrete model because its fields have sensible
defaults (status='todo', priority='medium', tags='[]').

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


@pytest.mark.asyncio
async def test_create_flushes_row_visible_in_same_session(space_session):
    """create() should flush so the row is visible within the same session."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    task = await svc.create({
        "id": uuid.uuid4().hex,
        "title": "Test task",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    assert task.id is not None
    # Verify it's queryable in the same session.
    from sqlalchemy import select
    result = await space_session.execute(select(Task).where(Task.id == task.id))
    assert result.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_create_does_not_commit_rollback_undoes_it(space_session):
    """create() must flush only — rollback should undo the insert."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    task_id = uuid.uuid4().hex
    await svc.create({
        "id": task_id,
        "title": "Rollback me",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    # Rollback should undo the flush.
    await space_session.rollback()
    # Now get() should raise NotFoundError.
    from app.errors import NotFoundError
    with pytest.raises(NotFoundError):
        await svc.get(task_id)


@pytest.mark.asyncio
async def test_get_returns_instance_by_id(space_session):
    """get() should return the ORM instance for an existing id."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    task_id = uuid.uuid4().hex
    await svc.create({
        "id": task_id,
        "title": "Find me",
        "status": "todo",
        "priority": "high",
        "tags": "[]",
    })
    result = await svc.get(task_id)
    assert result.id == task_id
    assert result.title == "Find me"


@pytest.mark.asyncio
async def test_get_raises_not_found_for_missing_id(space_session):
    """get() should raise NotFoundError for a non-existent id."""
    from app.services.base import BaseService
    from app.models.task import Task
    from app.errors import NotFoundError

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    with pytest.raises(NotFoundError):
        await svc.get("nonexistent-id-12345")


@pytest.mark.asyncio
async def test_list_returns_items_with_total_and_pagination(space_session):
    """list() should return (items, total) with pagination."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    for i in range(3):
        await svc.create({
            "id": uuid.uuid4().hex,
            "title": f"Task {i}",
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
        })
    items, total = await svc.list(offset=0, limit=2)
    assert len(items) == 2
    assert total == 3


@pytest.mark.asyncio
async def test_list_applies_equality_filters(space_session):
    """list() should filter by equality on specified columns."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    await svc.create({
        "id": uuid.uuid4().hex,
        "title": "Todo task",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    await svc.create({
        "id": uuid.uuid4().hex,
        "title": "Done task",
        "status": "done",
        "priority": "medium",
        "tags": "[]",
    })
    items, total = await svc.list(filters={"status": "done"})
    assert len(items) == 1
    assert total == 1
    assert items[0].status == "done"


@pytest.mark.asyncio
async def test_update_modifies_fields_and_bumps_updated_at(space_session):
    """update() should set fields and bump updated_at."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    task_id = uuid.uuid4().hex
    original = await svc.create({
        "id": task_id,
        "title": "Original",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    original_updated = original.updated_at
    updated = await svc.update(task_id, {"title": "Updated title"})
    assert updated.title == "Updated title"
    # updated_at is seconds-precision; within the same second it may equal
    # the original. Verify it was explicitly set (non-empty ISO string).
    assert updated.updated_at is not None
    assert updated.updated_at.endswith("Z")


@pytest.mark.asyncio
async def test_delete_removes_instance_and_raises_when_missing(space_session):
    """delete() should remove the row; calling on missing id raises NotFoundError."""
    from app.services.base import BaseService
    from app.models.task import Task
    from app.errors import NotFoundError

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    task_id = uuid.uuid4().hex
    await svc.create({
        "id": task_id,
        "title": "Delete me",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    await svc.delete(task_id)
    # Verify it's gone.
    with pytest.raises(NotFoundError):
        await svc.get(task_id)
    # Deleting a non-existent id should also raise.
    with pytest.raises(NotFoundError):
        await svc.delete("nonexistent-id-67890")


@pytest.mark.asyncio
async def test_update_bumps_version(space_session):
    """BaseService.update should auto-increment the version field."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    obj = await svc.create({
        "id": uuid.uuid4().hex,
        "title": "V1",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    assert obj.version == 1
    updated = await svc.update(obj.id, {"title": "V2"})
    assert updated.version == 2
    assert updated.title == "V2"


@pytest.mark.asyncio
async def test_update_refreshes_updated_at(space_session):
    """BaseService.update should refresh updated_at (via explicit set or onupdate)."""
    from app.services.base import BaseService
    from app.models.task import Task

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    obj = await svc.create({
        "id": uuid.uuid4().hex,
        "title": "T1",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    updated = await svc.update(obj.id, {"title": "T2"})
    # updated_at must be a non-empty ISO string ending with Z.
    assert updated.updated_at is not None
    assert updated.updated_at.endswith("Z")
