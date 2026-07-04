"""Tests for P0-1: Note content propagation through sync pull/full.

The Note ORM row stores only metadata (content_hash, word_count); the
Markdown body lives in the filesystem. SyncService.pull() must read the
content via fs.read_notes_batch() and include it in each note payload
so devices pulling changes receive the full body, not just metadata.

Covers:
- pull() includes content for notes when fs is provided.
- pull() marks content_missing=True when fs is None.
- pull() marks content_missing=True when the .md file was deleted out-of-band.
- pull() uses read_notes_batch (1 call) instead of N read_note calls.
- full() also includes content (it delegates to pull()).
- push note create → pull returns the same content.
- REST POST /notes → sync pull returns the same content.
"""
from __future__ import annotations

import uuid

import pytest


async def _make_fs_for_sync(tmp_path):
    """Helper: create a FileSystem instance for sync tests."""
    from app.file_system.api import get_file_system

    return await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )


# --------------------------------------------------------------------------- #
# Service-layer: pull includes content from filesystem
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pull_note_includes_content_from_filesystem(space_session, tmp_path):
    """pull() should include note content read from the filesystem."""
    from app.services.sync import SyncService
    from app.services.note import NoteService

    fs = await _make_fs_for_sync(tmp_path)
    note_svc = NoteService(space_session, fs)
    await note_svc.create({
        "id": "pull-content-1",
        "title": "Has Body",
        "content": "Hello world",
        "tags": "[]",
    })

    svc = SyncService(space_session, fs)
    result = await svc.pull(since="", limit=100)
    notes = result["notes"]
    assert len(notes) == 1
    assert notes[0]["id"] == "pull-content-1"
    assert notes[0]["content"] == "Hello world"
    assert notes[0]["content_missing"] is False


@pytest.mark.asyncio
async def test_pull_note_content_missing_when_fs_none(space_session):
    """pull() with fs=None should mark content_missing=True and content=''."""
    from app.services.sync import SyncService
    from app.models.note import Note

    # Insert a Note row directly bypassing fs (so no .md file exists).
    note = Note(
        id="no-fs-1",
        title="No FS",
        content_hash="",
        word_count=0,
        tags="[]",
        status="active",
    )
    space_session.add(note)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    result = await svc.pull(since="", limit=100)
    notes = result["notes"]
    assert len(notes) == 1
    assert notes[0]["content"] == ""
    assert notes[0]["content_missing"] is True


@pytest.mark.asyncio
async def test_pull_note_content_missing_when_file_deleted(space_session, tmp_path):
    """pull() should mark content_missing=True when the .md file was deleted
    out-of-band (fs returns None for that note id)."""
    from app.services.sync import SyncService
    from app.services.note import NoteService

    fs = await _make_fs_for_sync(tmp_path)
    note_svc = NoteService(space_session, fs)
    note = await note_svc.create({
        "id": "file-gone-1",
        "title": "Will lose file",
        "content": "Original body",
        "tags": "[]",
    })

    # Delete the .md file directly via fs (bypassing NoteService.delete
    # which would also remove the DB row). This simulates an orphan DB row.
    await fs.delete_note(note.id)

    svc = SyncService(space_session, fs)
    result = await svc.pull(since="", limit=100)
    notes = result["notes"]
    assert len(notes) == 1
    assert notes[0]["content"] == ""
    assert notes[0]["content_missing"] is True


@pytest.mark.asyncio
async def test_pull_multiple_notes_uses_batch_read(space_session, tmp_path, monkeypatch):
    """pull() should call fs.read_notes_batch exactly once for N notes
    (not N times read_note)."""
    from app.services.sync import SyncService
    from app.services.note import NoteService

    fs = await _make_fs_for_sync(tmp_path)
    note_svc = NoteService(space_session, fs)
    for i in range(3):
        await note_svc.create({
            "id": f"batch-{i}",
            "title": f"Note {i}",
            "content": f"Body {i}",
            "tags": "[]",
        })

    call_count = {"n": 0}
    real_batch = fs.read_notes_batch

    async def _counting_batch(note_ids):
        call_count["n"] += 1
        return await real_batch(note_ids)

    monkeypatch.setattr(fs, "read_notes_batch", _counting_batch)

    svc = SyncService(space_session, fs)
    result = await svc.pull(since="", limit=100)
    assert len(result["notes"]) == 3
    assert call_count["n"] == 1, (
        f"pull() should call read_notes_batch exactly once for 3 notes, "
        f"got {call_count['n']} calls"
    )


@pytest.mark.asyncio
async def test_full_includes_note_content(space_session, tmp_path):
    """full() should also include note content (delegates to pull)."""
    from app.services.sync import SyncService
    from app.services.note import NoteService

    fs = await _make_fs_for_sync(tmp_path)
    note_svc = NoteService(space_session, fs)
    await note_svc.create({
        "id": "full-content-1",
        "title": "Full Sync",
        "content": "Full body",
        "tags": "[]",
    })

    svc = SyncService(space_session, fs)
    result = await svc.full(since="", limit=100)
    notes = result["notes"]
    assert len(notes) == 1
    assert notes[0]["content"] == "Full body"
    assert notes[0]["content_missing"] is False
    assert result["is_full"] is True


@pytest.mark.asyncio
async def test_push_note_create_then_pull_returns_same_content(space_session, tmp_path):
    """push(note, create) → pull should return the same content."""
    from app.services.sync import SyncService

    fs = await _make_fs_for_sync(tmp_path)
    svc = SyncService(space_session, fs)
    eid = "push-pull-content-1"
    push_result = await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid,
            "title": "Synced Note",
            "content": "synced body",
            "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(push_result["applied"]) == 1
    assert push_result["errors"] == []

    pull_result = await svc.pull(since="", limit=100)
    notes = pull_result["notes"]
    assert len(notes) == 1
    assert notes[0]["id"] == eid
    assert notes[0]["content"] == "synced body"
    assert notes[0]["content_missing"] is False


# --------------------------------------------------------------------------- #
# HTTP-layer: REST create note → sync pull returns content
# --------------------------------------------------------------------------- #

async def _setup_login_and_space_token(client) -> str:
    """Setup admin, login, create a space, return a space token."""
    resp = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert resp.status_code in (200, 201)
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert resp.status_code == 200
    master_token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post(
        "/api/v1/spaces", json={"name": "Note Content Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    return resp.json()["space_token"]


@pytest.mark.asyncio
async def test_rest_note_create_then_pull_returns_same_content(client):
    """REST POST /notes → GET /sync/pull should return the same content."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    # Create a note via REST.
    resp = await client.post(
        "/api/v1/notes",
        json={
            "title": "REST Note",
            "content": "REST body content",
            "tags": [],
        },
        headers=headers,
    )
    assert resp.status_code == 201, f"note create failed: {resp.text}"
    note_id = resp.json()["id"]

    # Pull via sync — content must be present.
    resp = await client.get(
        "/api/v1/sync/pull?since=&limit=100", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    notes = data["notes"]
    matching = [n for n in notes if n["id"] == note_id]
    assert len(matching) == 1, (
        f"note {note_id} not in pull notes: {[n['id'] for n in notes]}"
    )
    assert matching[0]["content"] == "REST body content"
    assert matching[0]["content_missing"] is False
