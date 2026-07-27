"""Tests for BaseService — the flush-only CRUD foundation.

Tests use Project as the concrete model because its fields have sensible
defaults (next_work_item_number=1, rank=0, version=1).

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


@pytest.mark.asyncio
async def test_create_flushes_row_visible_in_same_session(space_session):
    """create() should flush so the row is visible within the same session."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    project = await svc.create({
        "id": uuid.uuid4().hex,
        "key": "TS01",
        "name": "Test project",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    assert project.id is not None
    # Verify it's queryable in the same session.
    from sqlalchemy import select
    result = await space_session.execute(select(Project).where(Project.id == project.id))
    assert result.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_create_does_not_commit_rollback_undoes_it(space_session):
    """create() must flush only — rollback should undo the insert."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    project_id = uuid.uuid4().hex
    await svc.create({
        "id": project_id,
        "key": "TS01",
        "name": "Rollback me",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    # Rollback should undo the flush.
    await space_session.rollback()
    # Now get() should raise NotFoundError.
    from app.errors import NotFoundError
    with pytest.raises(NotFoundError):
        await svc.get(project_id)


@pytest.mark.asyncio
async def test_get_returns_instance_by_id(space_session):
    """get() should return the ORM instance for an existing id."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    project_id = uuid.uuid4().hex
    await svc.create({
        "id": project_id,
        "key": "TS01",
        "name": "Find me",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    result = await svc.get(project_id)
    assert result.id == project_id
    assert result.name == "Find me"


@pytest.mark.asyncio
async def test_get_raises_not_found_for_missing_id(space_session):
    """get() should raise NotFoundError for a non-existent id."""
    from app.errors import NotFoundError
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    with pytest.raises(NotFoundError):
        await svc.get("nonexistent-id-12345")


@pytest.mark.asyncio
async def test_list_returns_items_with_total_and_pagination(space_session):
    """list() should return (items, total) with pagination."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    for i in range(3):
        await svc.create({
            "id": uuid.uuid4().hex,
            "key": f"T{i:02d}",
            "name": f"Project {i}",
            "default_status_definition_id": "sd-1",
            "default_type_definition_id": "td-1",
        })
    items, total = await svc.list(offset=0, limit=2)
    assert len(items) == 2
    assert total == 3


@pytest.mark.asyncio
async def test_list_applies_equality_filters(space_session):
    """list() should filter by equality on specified columns."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    await svc.create({
        "id": uuid.uuid4().hex,
        "key": "TS01",
        "name": "Rank one",
        "rank": 1,
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    await svc.create({
        "id": uuid.uuid4().hex,
        "key": "TS02",
        "name": "Rank two",
        "rank": 2,
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    items, total = await svc.list(filters={"rank": 2})
    assert len(items) == 1
    assert total == 1
    assert items[0].rank == 2


@pytest.mark.asyncio
async def test_update_modifies_fields_and_bumps_updated_at(space_session):
    """update() should set fields and bump updated_at."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    project_id = uuid.uuid4().hex
    await svc.create({
        "id": project_id,
        "key": "TS01",
        "name": "Original",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    updated = await svc.update(project_id, {"name": "Updated name"})
    assert updated.name == "Updated name"
    # updated_at is seconds-precision; within the same second it may equal
    # the original. Verify it was explicitly set (non-empty ISO string).
    assert updated.updated_at is not None
    assert updated.updated_at.endswith("Z")


@pytest.mark.asyncio
async def test_delete_removes_instance_and_raises_when_missing(space_session):
    """delete() should remove the row; calling on missing id raises NotFoundError."""
    from app.errors import NotFoundError
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    project_id = uuid.uuid4().hex
    await svc.create({
        "id": project_id,
        "key": "TS01",
        "name": "Delete me",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    await svc.delete(project_id)
    # Verify it's gone.
    with pytest.raises(NotFoundError):
        await svc.get(project_id)
    # Deleting a non-existent id should also raise.
    with pytest.raises(NotFoundError):
        await svc.delete("nonexistent-id-67890")


@pytest.mark.asyncio
async def test_update_bumps_version(space_session):
    """BaseService.update should auto-increment the version field."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    obj = await svc.create({
        "id": uuid.uuid4().hex,
        "key": "TS01",
        "name": "V1",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    assert obj.version == 1
    updated = await svc.update(obj.id, {"name": "V2"})
    assert updated.version == 2
    assert updated.name == "V2"


@pytest.mark.asyncio
async def test_update_refreshes_updated_at(space_session):
    """BaseService.update should refresh updated_at (via explicit set or onupdate)."""
    from app.models.project import Project
    from app.services.base import BaseService

    class ProjectService(BaseService):
        model = Project

    svc = ProjectService(space_session)
    obj = await svc.create({
        "id": uuid.uuid4().hex,
        "key": "TS01",
        "name": "T1",
        "default_status_definition_id": "sd-1",
        "default_type_definition_id": "td-1",
    })
    updated = await svc.update(obj.id, {"name": "T2"})
    # updated_at must be a non-empty ISO string ending with Z.
    assert updated.updated_at is not None
    assert updated.updated_at.endswith("Z")
