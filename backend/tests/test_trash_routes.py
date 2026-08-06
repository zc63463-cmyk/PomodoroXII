"""Tests for trash routes — durable purge and restore lifecycles.

Verifies that restore and purge operations delegate to the KnowledgeStore
and route through the durable mutation pipeline (journal + UoW + projections).

Covers:
- Folder cascade purge (descendants hard-deleted + tombstoned).
- Folder cascade purge with no descendants.
- Note soft-delete → trash listing → restore → .md recovery.
- Note purge (hard delete + tombstone).
- Note purge on untrashed note → 422.
- Folder soft-delete → restore via durable pipeline.
- Note restore succeeds even when FS restore fails (best-effort FS).
- Note purge creates sync events (proves durable pipeline).
- Folder purge creates sync events for all descendants.
"""
from __future__ import annotations

import pytest

from tests.sync_v2_helpers import (
    pull_sync_v2,
    ready_sync_v2_client,
    recover_sync_v2,
)

pytestmark = pytest.mark.provisioned_space_storage


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
        "/api/v1/spaces", json={"name": "Trash Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    return resp.json()["space_token"]


@pytest.mark.asyncio
async def test_purge_folder_cascades_to_descendants(client):
    """purge_item on a folder deletes the folder + all descendants."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    client_id = await ready_sync_v2_client(client, headers)

    # Create root + 2 children + 1 grandchild (so cascade depth > 1).
    resp = await client.post(
        "/api/v1/folders", json={"name": "Root"}, headers=headers
    )
    assert resp.status_code == 201
    root_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Child1", "parent_id": root_id},
        headers=headers,
    )
    assert resp.status_code == 201
    child1_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Child2", "parent_id": root_id},
        headers=headers,
    )
    assert resp.status_code == 201
    child2_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Grandchild1", "parent_id": child1_id},
        headers=headers,
    )
    assert resp.status_code == 201
    grandchild1_id = resp.json()["id"]

    # Enter Trash first; purge is intentionally blocked for active Folders.
    resp = await client.delete(
        f"/api/v1/folders/{root_id}", headers=headers
    )
    assert resp.status_code == 200

    # Purge the trashed root — should cascade to all descendants.
    resp = await client.delete(
        f"/api/v1/trash/folder/{root_id}", headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["entity_type"] == "folder"
    assert resp.json()["entity_id"] == root_id

    # Verify root and all descendants are gone (404 from GET /folders/{id}).
    for fid in (root_id, child1_id, child2_id, grandchild1_id):
        resp = await client.get(f"/api/v1/folders/{fid}", headers=headers)
        assert resp.status_code == 404, f"folder {fid} should be purged"

    # Sync v2 exposes purge tombstones as incremental delete events.
    page = await pull_sync_v2(client, headers, client_id)
    tomb_ids = {
        event["entity_id"]
        for event in page["events"]
        if event["entity_type"] == "folder" and event["action"] == "delete"
    }
    for fid in (root_id, child1_id, child2_id, grandchild1_id):
        assert fid in tomb_ids, f"tombstone for {fid} should exist"


@pytest.mark.asyncio
async def test_purge_folder_with_no_descendants_succeeds(client):
    """purge_item on a leaf folder (no descendants) should still work."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    resp = await client.post(
        "/api/v1/folders", json={"name": "Leaf"}, headers=headers
    )
    assert resp.status_code == 201
    leaf_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/folders/{leaf_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.delete(
        f"/api/v1/trash/folder/{leaf_id}", headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["entity_id"] == leaf_id

    # Folder should be gone.
    resp = await client.get(f"/api/v1/folders/{leaf_id}", headers=headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_purge_active_folder_is_rejected(client):
    """A Folder must enter Trash before the route can permanently purge it."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    resp = await client.post(
        "/api/v1/folders", json={"name": "Still Active"}, headers=headers
    )
    assert resp.status_code == 201
    folder_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/trash/folder/{folder_id}", headers=headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_purge_active_quick_note_is_rejected(client):
    """A QuickNote must enter Trash before it can be permanently purged."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    resp = await client.post(
        "/api/v1/quick-notes", json={"content": "Still active"}, headers=headers
    )
    assert resp.status_code == 201
    quick_note_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/trash/quick_note/{quick_note_id}", headers=headers
    )
    assert resp.status_code == 422


# --------------------------------------------------------------------------- #
# D-2: Note soft-delete -> trash -> restore -> purge cycle
# --------------------------------------------------------------------------- #


async def _create_note(client, headers, *, content="Hello world", title="Test"):
    """Helper: create a note and return its id."""
    resp = await client.post(
        "/api/v1/notes",
        json={"title": title, "content": content},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_note_soft_delete_appears_in_trash(client):
    """DELETE /notes/{id} soft-deletes; note appears in /trash, not in /notes."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    note_id = await _create_note(client, headers, content="trash me")

    # Soft-delete via DELETE /notes/{id}.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200, resp.text

    # Note should appear in trash listing.
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    trash_ids = [item["entity_id"] for item in resp.json()["items"]]
    assert note_id in trash_ids

    # Note should NOT appear in regular /notes listing.
    resp = await client.get("/api/v1/notes", headers=headers)
    assert resp.status_code == 200
    note_ids = [item["id"] for item in resp.json()["items"]]
    assert note_id not in note_ids

    # GET single note still 200 with trashed_at set.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is not None


@pytest.mark.asyncio
async def test_note_restore_recovers_md_and_clears_trashed_at(client):
    """POST /trash/note/{id}/restore clears trashed_at and recovers .md body."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    note_id = await _create_note(
        client, headers, content="Restorable body content"
    )

    # Soft-delete.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200

    # Restore via trash route.
    resp = await client.post(
        f"/api/v1/trash/note/{note_id}/restore", headers=headers
    )
    assert resp.status_code == 200, resp.text

    # trashed_at should be cleared.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is None

    # .md content should be fully recovered.
    resp = await client.get(
        f"/api/v1/notes/{note_id}/content", headers=headers
    )
    assert resp.status_code == 200
    assert "Restorable body content" in resp.text


@pytest.mark.asyncio
async def test_note_purge_writes_tombstone_and_returns_404(client):
    """DELETE /trash/note/{id} (purge) hard-deletes + writes tombstone."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    client_id = await ready_sync_v2_client(client, headers)

    note_id = await _create_note(client, headers, content="purge me")

    # Soft-delete first.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200

    # Purge via trash route.
    resp = await client.delete(
        f"/api/v1/trash/note/{note_id}", headers=headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["entity_type"] == "note"
    assert resp.json()["entity_id"] == note_id

    # Note row is gone -> GET /notes/{id} returns 404.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 404

    # Tombstone visible as a Sync v2 incremental delete event.
    page = await pull_sync_v2(client, headers, client_id)
    tomb_ids = [
        event["entity_id"]
        for event in page["events"]
        if event["entity_type"] == "note" and event["action"] == "delete"
    ]
    assert note_id in tomb_ids


@pytest.mark.asyncio
async def test_note_purge_untrashed_returns_422(client):
    """Purging a note that was NOT soft-deleted first returns 422."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    note_id = await _create_note(client, headers, content="not trashed yet")

    # Try to purge without soft-deleting first -> 422 ValidationError.
    resp = await client.delete(
        f"/api/v1/trash/note/{note_id}", headers=headers
    )
    assert resp.status_code == 422


# --------------------------------------------------------------------------- #
# Task 8: Durable pipeline integration tests
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_note_restore_succeeds_even_when_fs_target_occupied(
    client, monkeypatch
):
    """POST /trash/note/{id}/restore succeeds even when FS restore fails.

    The durable DB restore via KnowledgeStore is the source of truth.
    FS restore is best-effort: if the target .md path is occupied,
    the note is still restored in the DB (trashed_at cleared) and
    the route returns 200.
    """
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    note_id = await _create_note(client, headers, content="to be soft-deleted")

    # Soft-delete the note so it is in trash.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200

    # Mock FS restore to raise FileExistsError (simulates path conflict).
    # Patch TrashOpsMixin because it overrides FileSystem.restore in the MRO.
    from app.file_system.engine.trash_ops import TrashOpsMixin

    async def _raise_file_exists(self, note_id):
        raise FileExistsError(f"target path for note {note_id} already occupied")

    monkeypatch.setattr(TrashOpsMixin, "restore", _raise_file_exists)

    resp = await client.post(
        f"/api/v1/trash/note/{note_id}/restore", headers=headers
    )
    # DB restore succeeds even when FS restore fails.
    assert resp.status_code == 200, resp.text

    # trashed_at should be cleared in DB.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is None


@pytest.mark.asyncio
async def test_folder_soft_delete_then_restore_via_durable_pipeline(client):
    """Folder soft-delete → restore via KnowledgeStore clears trashed_at."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    # Create a folder.
    resp = await client.post(
        "/api/v1/folders", json={"name": "To Restore"}, headers=headers
    )
    assert resp.status_code == 201
    folder_id = resp.json()["id"]

    # Soft-delete via DELETE /folders/{id} (uses CascadeService → KnowledgeStore).
    resp = await client.delete(f"/api/v1/folders/{folder_id}", headers=headers)
    assert resp.status_code == 200

    # Folder should appear in trash listing.
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    trash_ids = [item["entity_id"] for item in resp.json()["items"]]
    assert folder_id in trash_ids

    # Restore via trash route.
    resp = await client.post(
        f"/api/v1/trash/folder/{folder_id}/restore", headers=headers
    )
    assert resp.status_code == 200, resp.text

    # Folder should no longer be in trash.
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    trash_ids = [item["entity_id"] for item in resp.json()["items"]]
    assert folder_id not in trash_ids

    # Folder should be accessible again.
    resp = await client.get(f"/api/v1/folders/{folder_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is None


@pytest.mark.asyncio
async def test_note_purge_creates_sync_events(client):
    """Note purge via KnowledgeStore creates sync events (durable pipeline proof)."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    client_id = await ready_sync_v2_client(client, headers)

    note_id = await _create_note(client, headers, content="sync event test")

    # Soft-delete first.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200

    # Purge via trash route (goes through KnowledgeStore → UoW).
    resp = await client.delete(
        f"/api/v1/trash/note/{note_id}", headers=headers
    )
    assert resp.status_code == 200

    # Verify a v2 delete event was created by the durable pipeline.
    data = await pull_sync_v2(client, headers, client_id)
    tomb_ids = [
        event["entity_id"]
        for event in data["events"]
        if event["entity_type"] == "note" and event["action"] == "delete"
    ]
    assert note_id in tomb_ids

    records, _waterline = await recover_sync_v2(
        client, headers, "note-purge-recovery-client"
    )
    assert not any(
        record["entity_type"] == "note" and record["entity_id"] == note_id
        for record in records
    )


@pytest.mark.asyncio
async def test_folder_purge_creates_tombstones_for_all_descendants(client):
    """Folder cascade purge creates tombstones for root + all descendants."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}
    client_id = await ready_sync_v2_client(client, headers)

    # Create root + child + grandchild.
    resp = await client.post(
        "/api/v1/folders", json={"name": "Root"}, headers=headers
    )
    assert resp.status_code == 201
    root_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Child", "parent_id": root_id},
        headers=headers,
    )
    assert resp.status_code == 201
    child_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Grandchild", "parent_id": child_id},
        headers=headers,
    )
    assert resp.status_code == 201
    grandchild_id = resp.json()["id"]

    # Enter Trash first; the purge route only accepts trashed Folders.
    resp = await client.delete(
        f"/api/v1/folders/{root_id}", headers=headers
    )
    assert resp.status_code == 200

    # Purge root (cascades to all descendants via KnowledgeStore).
    resp = await client.delete(
        f"/api/v1/trash/folder/{root_id}", headers=headers
    )
    assert resp.status_code == 200

    # Verify v2 delete events exist for all three folders.
    page = await pull_sync_v2(client, headers, client_id)
    tomb_ids = {
        event["entity_id"]
        for event in page["events"]
        if event["entity_type"] == "folder" and event["action"] == "delete"
    }
    assert root_id in tomb_ids
    assert child_id in tomb_ids
    assert grandchild_id in tomb_ids


@pytest.mark.asyncio
async def test_restore_untrashed_note_returns_422(client):
    """Restoring a note that is NOT trashed returns 422 ValidationError."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    note_id = await _create_note(client, headers, content="not trashed")

    # Try to restore without soft-deleting first → 422.
    resp = await client.post(
        f"/api/v1/trash/note/{note_id}/restore", headers=headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_restore_nonexistent_note_returns_404(client):
    """Restoring a nonexistent note returns 404."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    resp = await client.post(
        "/api/v1/trash/note/nonexistent-id/restore", headers=headers
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_purge_nonexistent_note_returns_404(client):
    """Purging a nonexistent note returns 404."""
    space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    resp = await client.delete(
        "/api/v1/trash/note/nonexistent-id", headers=headers
    )
    assert resp.status_code == 404
