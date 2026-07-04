"""Tests for TaskService (P3.1: tags list→JSON conversion in update)."""
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_task_service_create_converts_tags_list_to_json(space_session):
    """create() should convert tags list to JSON string."""
    from app.models.task import Task
    from app.services.task import TaskService

    svc = TaskService(space_session)
    obj = await svc.create({"title": "T", "tags": ["a", "b"]})
    assert obj.tags == '["a", "b"]'
    row = await space_session.get(Task, obj.id)
    assert row.tags == '["a", "b"]'


@pytest.mark.asyncio
async def test_task_service_update_converts_tags_list_to_json(space_session):
    """update() should convert tags list to JSON string before applying."""
    from app.models.task import Task
    from app.services.task import TaskService

    svc = TaskService(space_session)
    obj = await svc.create({"title": "Original", "tags": ["a", "b"]})
    await space_session.commit()
    await space_session.refresh(obj)

    # Update with tags as list — should be converted to JSON string.
    updated = await svc.update(obj.id, {"tags": ["x", "y", "z"]})
    await space_session.commit()
    await space_session.refresh(updated)

    assert updated.tags == '["x", "y", "z"]'
    row = await space_session.get(Task, obj.id)
    assert row.tags == '["x", "y", "z"]'


@pytest.mark.asyncio
async def test_task_service_update_preserves_tags_as_string(space_session):
    """update() with tags already as string should pass through unchanged."""
    from app.services.task import TaskService

    svc = TaskService(space_session)
    obj = await svc.create({"title": "T", "tags": '["keep"]'})
    updated = await svc.update(obj.id, {"title": "Renamed"})
    # tags should still be the original string.
    assert updated.tags == '["keep"]'
    assert updated.title == "Renamed"
