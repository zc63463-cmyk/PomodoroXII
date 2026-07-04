"""Tests for CascadeService — BFS descendant traversal and cascade soft-delete.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


async def _make_folder(session, name: str, parent_id: str | None = None) -> str:
    """Helper: create a folder and return its id."""
    from app.models.folder import Folder

    fid = uuid.uuid4().hex
    session.add(Folder(
        id=fid, name=name, parent_id=parent_id,
        sort_order=0, is_system=False,
    ))
    await session.flush()
    return fid


@pytest.mark.asyncio
async def test_get_descendant_ids_collects_multi_level_bfs(space_session):
    """get_descendant_ids() should collect all descendants via BFS."""
    from app.services.cascade import CascadeService

    svc = CascadeService(space_session)
    root = await _make_folder(space_session, "root")
    child = await _make_folder(space_session, "child", parent_id=root)
    grandchild = await _make_folder(space_session, "grandchild", parent_id=child)

    descendants = await svc.get_descendant_ids(root)
    assert len(descendants) == 2
    assert child in descendants
    assert grandchild in descendants


@pytest.mark.asyncio
async def test_get_descendant_ids_skips_trashed_subtrees(space_session):
    """get_descendant_ids() should not traverse into trashed folders."""
    from app.services.cascade import CascadeService
    from app.services.time import utc_now_iso

    svc = CascadeService(space_session)
    root = await _make_folder(space_session, "root")
    child = await _make_folder(space_session, "child", parent_id=root)
    grandchild = await _make_folder(space_session, "grandchild", parent_id=child)

    # Trash the child — grandchild should not be collected.
    from app.models.folder import Folder
    child_obj = await space_session.get(Folder, child)
    child_obj.trashed_at = utc_now_iso()
    await space_session.flush()

    descendants = await svc.get_descendant_ids(root)
    assert child in descendants  # child itself is still a descendant of root
    assert grandchild not in descendants  # but its subtree is skipped


@pytest.mark.asyncio
async def test_soft_delete_folder_cascades_to_descendants(space_session):
    """soft_delete_folder() should set trashed_at on all descendants."""
    from app.models.folder import Folder
    from app.services.cascade import CascadeService

    svc = CascadeService(space_session)
    root = await _make_folder(space_session, "root")
    child = await _make_folder(space_session, "child", parent_id=root)
    grandchild = await _make_folder(space_session, "grandchild", parent_id=child)

    result = await svc.soft_delete_folder(root)
    assert root in result["trashed_folder_ids"]
    assert child in result["trashed_folder_ids"]
    assert grandchild in result["trashed_folder_ids"]

    # Verify all have trashed_at set.
    for fid in [root, child, grandchild]:
        folder = await space_session.get(Folder, fid)
        assert folder.trashed_at is not None


@pytest.mark.asyncio
async def test_soft_delete_folder_clears_notes_folder_id(space_session):
    """soft_delete_folder() should set notes.folder_id = None in the subtree."""
    from app.models.note import Note
    from app.services.cascade import CascadeService

    svc = CascadeService(space_session)
    root = await _make_folder(space_session, "root")
    child = await _make_folder(space_session, "child", parent_id=root)

    # Create a note in the child folder.
    note_id = uuid.uuid4().hex
    space_session.add(Note(
        id=note_id, title="Test", content_hash="abc", word_count=2,
        folder_id=child, status="active",
    ))
    await space_session.flush()

    await svc.soft_delete_folder(root)
    note = await space_session.get(Note, note_id)
    assert note.folder_id is None


@pytest.mark.asyncio
async def test_soft_delete_folder_clears_quick_notes_folder_id(space_session):
    """soft_delete_folder() should set quick_notes.folder_id = None in the subtree."""
    from app.models.quick_note import QuickNote
    from app.services.cascade import CascadeService

    svc = CascadeService(space_session)
    root = await _make_folder(space_session, "root")

    # Create a quick note in the root folder.
    qn_id = uuid.uuid4().hex
    space_session.add(QuickNote(
        id=qn_id, content="Test", folder_id=root,
    ))
    await space_session.flush()

    await svc.soft_delete_folder(root)
    qn = await space_session.get(QuickNote, qn_id)
    assert qn.folder_id is None


@pytest.mark.asyncio
async def test_soft_delete_folder_raises_not_found(space_session):
    """soft_delete_folder() should raise NotFoundError for non-existent id."""
    from app.errors import NotFoundError
    from app.services.cascade import CascadeService

    svc = CascadeService(space_session)
    with pytest.raises(NotFoundError):
        await svc.soft_delete_folder("nonexistent-folder-id")


@pytest.mark.asyncio
async def test_cascade_delete_task_removes_junction_links(space_session):
    """delete_task_cascade() should remove task_quick_notes rows for the task."""
    from sqlalchemy import select

    from app.models.task import Task
    from app.models.task_quick_note import TaskQuickNote
    from app.services.cascade import CascadeService

    svc = CascadeService(space_session)

    # Create a task and a junction row.
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    space_session.add(Task(
        id=task_id, title="Test", status="todo", priority="medium", tags="[]",
    ))
    space_session.add(TaskQuickNote(
        id=uuid.uuid4().hex, task_id=task_id, quick_note_id=qn_id,
    ))
    await space_session.flush()

    await svc.delete_task_cascade(task_id)

    # Junction row should be gone.
    result = await space_session.execute(
        select(TaskQuickNote).where(TaskQuickNote.task_id == task_id)
    )
    assert result.scalar_one_or_none() is None
    # Task itself should be gone.
    assert await space_session.get(Task, task_id) is None
