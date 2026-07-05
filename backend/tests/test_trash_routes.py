"""Tests for trash routes (P3.2: cascade purge of folder descendants).

Verifies that purge_item on a folder with descendants:
- Hard-deletes the root folder.
- Hard-deletes all descendant folders (cascade).
- Creates a tombstone for each deleted folder.

The fix in P3.2 changes the implementation from N+1 per-row db.get()
calls to a single batch SELECT via IN-clause, without changing the
external behaviour. These tests pin that behaviour so the refactor
cannot regress.
"""
from __future__ import annotations

import pytest


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

    # Purge the root — should cascade to all descendants.
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

    # Verify tombstones exist for all via /sync/full.
    resp = await client.get("/api/v1/sync/full", headers=headers)
    assert resp.status_code == 200
    tomb_ids = {t["entity_id"] for t in resp.json()["tombstones"]}
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
        f"/api/v1/trash/folder/{leaf_id}", headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["entity_id"] == leaf_id

    # Folder should be gone.
    resp = await client.get(f"/api/v1/folders/{leaf_id}", headers=headers)
    assert resp.status_code == 404


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

    # Tombstone visible in /sync/full.
    resp = await client.get("/api/v1/sync/full", headers=headers)
    assert resp.status_code == 200
    tomb_ids = [t["entity_id"] for t in resp.json()["tombstones"]]
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
