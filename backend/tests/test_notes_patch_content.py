"""D-1 (v4 D2): Notes REST content/metadata split -- PATCH + PUT /content.

Closes the v4 Phase D gate item: "PATCH 不写 .md; PUT content 更新 .md +
content_hash". Tests are HTTP-level to complement the existing service-layer
coverage in test_note_service.py.

Layout:
- PATCH /api/v1/notes/{id}        -> NoteService.update_metadata (DB only)
- PUT  /api/v1/notes/{id}/content  -> NoteService.update_content (.md + hash)
- PUT  /api/v1/notes/{id}          -> deprecated dispatcher (backward compat)

Run: uv run pytest tests/test_notes_patch_content.py -v
"""

from __future__ import annotations

import pytest

# --------------------------------------------------------------------------- #
# Helpers (self-contained per Phase D gate convention)
# --------------------------------------------------------------------------- #

async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token."""
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post("/api/v1/auth/login", json={"password": "test123"})
    master_token = resp.json()["access_token"]
    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "Test Space"},
        headers={"Authorization": f"Bearer {master_token}"},
    )
    space_id = resp.json()["id"]
    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    space_token = resp.json()["space_token"]
    return space_token, space_id


def _auth(space_token: str) -> dict:
    return {"Authorization": f"Bearer {space_token}"}


async def _create_note(client, headers, *, content="Hello world", title="Test"):
    resp = await client.post(
        "/api/v1/notes",
        json={"title": title, "content": content},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# --------------------------------------------------------------------------- #
# PATCH /notes/{id} -- metadata only, does NOT write .md
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_patch_metadata_does_not_change_hash_or_md(client):
    """PATCH title/tags updates DB only; content_hash and .md body unchanged."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="Original body")
    note_id = note["id"]
    original_hash = note["content_hash"]

    # Read original .md content via GET /content
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=headers)
    assert resp.status_code == 200
    original_md = resp.text

    # PATCH metadata
    resp = await client.patch(
        f"/api/v1/notes/{note_id}",
        json={"title": "New Title", "tags": ["alpha", "beta"]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["title"] == "New Title"
    assert data["tags"] == ["alpha", "beta"]
    # content_hash unchanged -- .md not rewritten
    assert data["content_hash"] == original_hash

    # .md body unchanged
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=headers)
    assert resp.status_code == 200
    assert resp.text == original_md


@pytest.mark.asyncio
async def test_patch_metadata_404_for_nonexistent_id(client):
    """PATCH on a nonexistent note id returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.patch(
        "/api/v1/notes/nonexistent-id-12345",
        json={"title": "x"},
        headers=headers,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_metadata_supports_status_and_summary(client):
    """PATCH can update summary and status fields (DB-only)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers)
    note_id = note["id"]

    resp = await client.patch(
        f"/api/v1/notes/{note_id}",
        json={"summary": "A short summary", "status": "archived"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["summary"] == "A short summary"
    assert data["status"] == "archived"


# --------------------------------------------------------------------------- #
# PUT /notes/{id}/content -- writes .md + updates content_hash
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_put_content_json_updates_hash_and_md(client):
    """PUT /content with JSON body rewrites .md and updates content_hash."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="v1")
    note_id = note["id"]
    original_hash = note["content_hash"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}/content",
        json={"content": "v2 - updated body"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["content_hash"] != original_hash
    assert data["word_count"] > 0

    # GET /content reflects new body
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=headers)
    assert resp.status_code == 200
    assert "v2 - updated body" in resp.text


@pytest.mark.asyncio
async def test_put_content_plain_text_body(client):
    """PUT /content accepts text/plain body (not just JSON)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="original")
    note_id = note["id"]
    original_hash = note["content_hash"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}/content",
        content="Raw plain text body",
        headers={**headers, "Content-Type": "text/plain"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["content_hash"] != original_hash

    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=headers)
    assert resp.status_code == 200
    assert "Raw plain text body" in resp.text


@pytest.mark.asyncio
async def test_put_content_404_for_nonexistent_id(client):
    """PUT /content on a nonexistent note returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.put(
        "/api/v1/notes/nonexistent-id-12345/content",
        json={"content": "x"},
        headers=headers,
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# PUT /notes/{id} -- deprecated but still works (backward compat regression)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_put_full_deprecated_but_still_works(client):
    """Legacy PUT /notes/{id} still updates both content and metadata."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="orig")
    note_id = note["id"]
    original_hash = note["content_hash"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}",
        json={"title": "Updated Title", "content": "new body"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["title"] == "Updated Title"
    assert data["content_hash"] != original_hash

    # OpenAPI should mark PUT /notes/{id} as deprecated
    spec = await client.get("/openapi.json")
    if spec.status_code == 200:
        put_op = spec.json().get("paths", {}).get(
            "/api/v1/notes/{id}", {}
        ).get("put", {})
        assert put_op.get("deprecated") is True, (
            "PUT /api/v1/notes/{id} should be marked deprecated=True in OpenAPI"
        )


# --------------------------------------------------------------------------- #
# E-5: PATCH on a soft-deleted note -> 422 (must restore first)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_patch_metadata_on_trashed_note_returns_422(client):
    """PATCH /notes/{id} on a soft-deleted note -> 422 (must restore first).

    E-5 edge behavior guard: NoteService.update_metadata must reject metadata
    updates on trashed notes to prevent silent DB mutations on a recycled
    item. The sync push path (sync_mode=True) bypasses this guard.
    """
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="will be trashed")
    note_id = note["id"]

    # Soft-delete via REST DELETE.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200

    # PATCH on trashed note must fail with 422.
    resp = await client.patch(
        f"/api/v1/notes/{note_id}",
        json={"title": "Patched After Trash"},
        headers=headers,
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["error_type"] == "validation_error"
