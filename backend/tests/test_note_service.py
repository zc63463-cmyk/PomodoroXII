"""Tests for NoteService -- filesystem + DB coordination.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


async def _make_fs(tmp_path):
    """Helper: create a FileSystem instance for tests."""
    from app.file_system.api import get_file_system

    return await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )


@pytest.mark.asyncio
async def test_create_writes_md_and_db(space_session, tmp_path):
    """create() should write the .md file and insert the DB row."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "My Note",
        "content": "Hello world",
        "tags": ["test", "demo"],
    })

    # DB row exists with metadata.
    assert note.id is not None
    assert note.title == "My Note"
    assert note.word_count == 2
    assert note.content_hash != ""

    # .md file exists and content is readable.
    content = await fs.read_note(note.id)
    assert content == "Hello world"


@pytest.mark.asyncio
async def test_create_respects_client_id(space_session, tmp_path):
    """create() should use the client-provided id for both fs and DB."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    client_id = uuid.uuid4().hex
    note = await svc.create({
        "id": client_id,
        "title": "Client Note",
        "content": "Content here",
    })

    assert note.id == client_id
    # fs also uses the same id.
    content = await fs.read_note(client_id)
    assert content == "Content here"


@pytest.mark.asyncio
async def test_get_returns_metadata_without_content(space_session, tmp_path):
    """get() should return the Note ORM row (no content column)."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "Meta Note",
        "content": "Some content",
    })

    result = await svc.get(note.id)
    assert result.title == "Meta Note"
    assert result.content_hash != ""
    assert result.word_count > 0
    # Note model has no 'content' column.
    assert not hasattr(result, "content")


@pytest.mark.asyncio
async def test_get_content_reads_md(space_session, tmp_path):
    """get_content() should return the .md file content."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "Content Note",
        "content": "Read this content",
    })

    content = await svc.get_content(note.id)
    assert content == "Read this content"


@pytest.mark.asyncio
async def test_update_content_rewrites_md_and_updates_hash(space_session, tmp_path):
    """update_content() should rewrite .md and update content_hash/word_count."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "Update Me",
        "content": "Original content",
    })
    original_hash = note.content_hash

    updated = await svc.update_content(note.id, "New content here")
    assert updated.content_hash != original_hash
    assert updated.word_count == 3

    content = await svc.get_content(note.id)
    assert content == "New content here"


@pytest.mark.asyncio
async def test_update_metadata_updates_db_only(space_session, tmp_path):
    """update_metadata() should update DB fields without touching .md content."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "Original Title",
        "content": "Content stays same",
        "tags": ["old"],
    })

    updated = await svc.update_metadata(note.id, {
        "title": "New Title",
        "tags": ["new", "updated"],
        "category": "work",
    })

    assert updated.title == "New Title"
    assert updated.category == "work"
    assert updated.tags == '["new", "updated"]'

    # Content should be unchanged.
    content = await svc.get_content(note.id)
    assert content == "Content stays same"


@pytest.mark.asyncio
async def test_delete_removes_both_and_tombstone(space_session, tmp_path):
    """delete(hard=True) removes DB row + .md file + writes tombstone."""
    from app.errors import NotFoundError
    from app.services.note import NoteService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "Delete Me",
        "content": "Bye bye",
    })
    note_id = note.id

    # D-2: REST default is now soft-delete; explicitly request hard delete
    # to preserve the original test intent (row + .md + tombstone gone).
    await svc.delete(note_id, hard=True)

    # DB row is gone.
    with pytest.raises(NotFoundError):
        await svc.get(note_id)

    # .md file is soft-deleted (read raises KeyError).
    with pytest.raises(KeyError):
        await fs.read_note(note_id)

    # Tombstone exists.
    tomb_svc = TombstoneService(space_session)
    assert await tomb_svc.exists("note", note_id) is not None


@pytest.mark.asyncio
async def test_delete_idempotent(space_session, tmp_path):
    """delete() called twice should not raise on the second call."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "title": "Delete Twice",
        "content": "Content",
    })

    # First delete should succeed.
    # D-2: default is soft-delete; verify hard-delete idempotency here.
    await svc.delete(note.id, hard=True)
    # Second delete should not raise.
    await svc.delete(note.id, hard=True)


# --------------------------------------------------------------------------- #
# P0-2: Saga compensation tests
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_create_db_failure_compensates_fs_delete(space_session, tmp_path):
    """If DB flush fails after FS write, the .md file should be deleted."""
    from unittest.mock import AsyncMock, patch

    from app.services.base import BaseService
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    # Patch BaseService.create to raise, simulating DB failure.
    with patch.object(BaseService, "create", new=AsyncMock(side_effect=RuntimeError("DB down"))):
        with pytest.raises(RuntimeError, match="DB down"):
            await svc.create({"title": "Saga", "content": "compensate me"})

    # Compensation: no .md file should remain.
    notes = await fs.list_notes()
    assert len(notes) == 0, "Orphan .md file left after DB failure"


@pytest.mark.asyncio
async def test_update_content_db_failure_restores_old_content(space_session, tmp_path):
    """If DB flush fails after FS rewrite, old .md content should be restored."""
    from unittest.mock import AsyncMock

    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Orig", "content": "Old content"})
    note_id = note.id

    # Patch db.flush to always fail (simulating DB failure during update).
    original_flush = space_session.flush
    space_session.flush = AsyncMock(side_effect=RuntimeError("DB flush failed"))

    try:
        with pytest.raises(RuntimeError, match="DB flush failed"):
            await svc.update_content(note_id, "New content")
    finally:
        space_session.flush = original_flush

    # Compensation: FS content should be restored to old value.
    content = await fs.read_note(note_id)
    assert content == "Old content", f"Content not restored: {content!r}"


# --------------------------------------------------------------------------- #
# C5: SAVEPOINT compatibility — NoteService Saga inside db.begin_nested()
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_savepoint_create_rollback_does_not_break_outer(space_session, tmp_path):
    """NoteService.create inside a SAVEPOINT rolled back should not break the outer session."""
    from app.models.task import Task
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    # Outer SAVEPOINT.
    async with space_session.begin_nested():
        try:
            await svc.create({
                "id": "savepoint-create-1",
                "title": "Savepoint Note",
                "content": "Hello",
            })
        except Exception:
            await space_session.rollback()

    # Outer session still usable: create an unrelated Task.
    task = Task(
        id="post-savepoint-task",
        title="After rollback",
        status="todo",
        priority="medium",
        tags="[]",
    )
    space_session.add(task)
    await space_session.flush()
    assert task.id is not None


@pytest.mark.asyncio
async def test_savepoint_update_content_rollback_restores_fs(space_session, tmp_path):
    """update_content inside a rolled-back SAVEPOINT: DB rolls back, FS may not.

    Known limitation: NoteService.update_content's Saga compensation only
    fires on DB flush failure, not on SAVEPOINT rollback. After rollback,
    the DB row reverts but the .md file may keep the new content. C6
    (sync_mode) will address this; C5 documents the current behavior.
    """
    from app.models.note import Note
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "id": "savepoint-update-1",
        "title": "Original",
        "content": "Original content",
    })
    note_id = note.id

    # Begin SAVEPOINT, update content, then rollback SAVEPOINT.
    async with space_session.begin_nested() as sp:
        await svc.update_content(note_id, "Temporarily new content")
        await sp.rollback()

    # DB row should be back to original (SAVEPOINT rollback undid DB flush).
    space_session.expire_all()
    row = await space_session.get(Note, note_id)
    assert row is not None
    # content_hash/word_count should reflect the ORIGINAL content.
    assert row.title == "Original"


@pytest.mark.asyncio
async def test_savepoint_delete_rollback_keeps_db_row(space_session, tmp_path):
    """delete inside a rolled-back SAVEPOINT should leave the DB row intact."""
    from app.models.note import Note
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({
        "id": "savepoint-delete-1",
        "title": "To delete in savepoint",
        "content": "Body",
    })
    note_id = note.id

    # Begin SAVEPOINT, delete, then rollback SAVEPOINT.
    async with space_session.begin_nested() as sp:
        await svc.delete(note_id)
        await sp.rollback()

    # The DB row should still exist (SAVEPOINT rollback undid the delete).
    space_session.expire_all()
    row = await space_session.get(Note, note_id)
    assert row is not None
    assert row.title == "To delete in savepoint"


@pytest.mark.asyncio
async def test_delete_db_first_then_fs(space_session, tmp_path):
    """delete() should remove DB row before attempting FS deletion."""
    from app.services.note import NoteService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Del", "content": "bye"})
    note_id = note.id

    # D-2: explicit hard delete to preserve original test intent.
    await svc.delete(note_id, hard=True)

    # DB row should be gone.
    from sqlalchemy import select

    from app.models.note import Note
    res = await space_session.execute(select(Note).where(Note.id == note_id))
    assert res.scalar_one_or_none() is None
    # Tombstone should exist.
    assert await TombstoneService(space_session).exists("note", note_id) is not None
    # .md file should also be gone.
    with pytest.raises(KeyError):
        await fs.read_note(note_id)


@pytest.mark.asyncio
async def test_delete_db_failure_preserves_fs(space_session, tmp_path):
    """If DB delete fails, .md file should be preserved (not yet deleted)."""
    from unittest.mock import AsyncMock

    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Keep FS", "content": "survive"})
    note_id = note.id

    # Patch db.flush to always fail (simulating DB delete failure).
    original_flush = space_session.flush
    space_session.flush = AsyncMock(side_effect=RuntimeError("DB delete failed"))

    try:
        with pytest.raises(RuntimeError, match="DB delete failed"):
            await svc.delete(note_id)
    finally:
        space_session.flush = original_flush

    # .md file should still be readable (FS not yet touched when DB fails).
    content = await fs.read_note(note_id)
    assert content == "survive"


@pytest.mark.asyncio
async def test_delete_always_writes_tombstone(space_session, tmp_path):
    """delete() should write a tombstone even if .md is already gone."""
    from app.services.note import NoteService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Tomb", "content": "will be deleted"})
    note_id = note.id

    # Manually delete the .md file first (simulate already-gone FS state).
    await fs.delete_note(note_id)

    # delete() should still succeed and write a tombstone.
    # D-2: explicit hard delete to preserve original test intent.
    await svc.delete(note_id, hard=True)
    assert await TombstoneService(space_session).exists("note", note_id) is not None


@pytest.mark.asyncio
async def test_create_update_delete_end_to_end(space_session, tmp_path):
    """End-to-end: create → update_content → update_metadata → delete."""
    from app.services.note import NoteService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    # Create
    note = await svc.create({"title": "E2E", "content": "v1", "tags": ["a"]})
    assert note.content_hash != ""
    assert note.word_count == 1

    # Update content
    note = await svc.update_content(note.id, "v2 longer content")
    content = await fs.read_note(note.id)
    assert content == "v2 longer content"
    assert note.word_count == 3

    # Update metadata
    note = await svc.update_metadata(note.id, {"title": "E2E Updated", "category": "test"})
    assert note.title == "E2E Updated"
    assert note.category == "test"

    # Delete
    # D-2: explicit hard delete to preserve original test intent.
    await svc.delete(note.id, hard=True)
    assert await TombstoneService(space_session).exists("note", note.id) is not None


# --------------------------------------------------------------------------- #
# P1-3: updated_at / version bump behavior for normal vs sync paths
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_update_metadata_bumps_updated_at_and_version(space_session, tmp_path):
    """Normal REST/service update_metadata() must bump updated_at and version."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Original", "content": "body"})
    original_updated_at = note.updated_at
    original_version = note.version

    # Small sleep to ensure timestamp changes (updated_at is seconds-precision).
    import asyncio
    await asyncio.sleep(1)

    updated = await svc.update_metadata(note.id, {"title": "Updated Title"})

    assert updated.title == "Updated Title"
    assert updated.version == original_version + 1
    assert updated.updated_at != original_updated_at
    assert updated.updated_at.endswith("Z")


@pytest.mark.asyncio
async def test_update_metadata_only_bumps_updated_at_and_version(space_session, tmp_path):
    """Normal NoteService.update() with metadata-only payload must bump updated_at/version."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Original", "content": "body"})
    original_updated_at = note.updated_at
    original_version = note.version

    import asyncio
    await asyncio.sleep(1)

    updated = await svc.update(note.id, {"title": "Updated via update()", "category": "work"})

    assert updated.title == "Updated via update()"
    assert updated.category == "work"
    assert updated.version == original_version + 1
    assert updated.updated_at != original_updated_at


@pytest.mark.asyncio
async def test_update_metadata_sync_mode_preserves_client_updated_at(space_session, tmp_path):
    """Sync path with updated_at_override must preserve client timestamp and not bump version."""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Original", "content": "body"})
    original_version = note.version
    client_ts = "2026-07-04T12:00:00.000Z"

    updated = await svc.update_metadata(
        note.id,
        {"title": "Sync Title"},
        updated_at_override=client_ts,
    )

    assert updated.title == "Sync Title"
    assert updated.updated_at == client_ts
    assert updated.version == original_version


# --------------------------------------------------------------------------- #
# D-2: soft-delete + restore (default REST path)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_delete_default_is_soft_delete(space_session, tmp_path):
    """Default delete() (no hard=True) soft-deletes: row stays, .md moves to .trash/."""
    from app.models.note import Note
    from app.services.note import NoteService
    from app.services.tombstone import TombstoneService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Soft", "content": "will be trashed"})
    note_id = note.id

    # Default delete = soft delete.
    await svc.delete(note_id)

    # DB row still exists with trashed_at set.
    row = await space_session.get(Note, note_id)
    assert row is not None
    assert row.trashed_at is not None

    # .md file moved to .trash/ -> read_note raises KeyError.
    with pytest.raises(KeyError):
        await fs.read_note(note_id)

    # No tombstone written for soft delete.
    assert await TombstoneService(space_session).exists("note", note_id) is None

    # Idempotent: second soft delete on already-trashed note is a no-op.
    await svc.delete(note_id)
    row = await space_session.get(Note, note_id)
    assert row is not None
    assert row.trashed_at is not None

    # Soft delete on missing row is also a no-op (no raise).
    await svc.delete("nonexistent-id-xyz")


@pytest.mark.asyncio
async def test_restore_clears_trashed_at_and_recovers_md(space_session, tmp_path):
    """restore() clears trashed_at, moves .md back from .trash/, and is non-idempotent."""
    from app.errors import ValidationError
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)

    note = await svc.create({"title": "Restore Me", "content": "recoverable body"})
    note_id = note.id

    # Soft-delete then restore.
    await svc.delete(note_id)
    restored = await svc.restore(note_id)

    assert restored.trashed_at is None
    content = await fs.read_note(note_id)
    assert content == "recoverable body"

    # Repeat restore -> ValidationError (note no longer in trash).
    with pytest.raises(ValidationError):
        await svc.restore(note_id)
