"""D-3 (v4 D5a): Notes version history REST endpoints.

Closes the v4 Phase D gate item: "暴露笔记版本历史". The filesystem layer
already creates version backups in ``.meta/version_backups/`` when
``fs.edit_note()`` detects a content_hash change; these tests verify the
new HTTP routes expose them.

Routes:
- GET /api/v1/notes/{id}/versions              -> list[VersionRecordResponse]
- GET /api/v1/notes/{id}/versions/{version_id} -> PlainTextResponse

Run: uv run pytest tests/test_notes_versions.py -v
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
# GET /notes/{id}/versions
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_versions_after_content_edit(client):
    """Editing note content produces at least one version backup."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="v1 original body")
    note_id = note["id"]

    # Rewrite content via PUT /content -- should create a version backup.
    resp = await client.put(
        f"/api/v1/notes/{note_id}/content",
        json={"content": "v2 updated body"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    resp = await client.get(f"/api/v1/notes/{note_id}/versions", headers=headers)
    assert resp.status_code == 200, resp.text
    versions = resp.json()
    assert len(versions) >= 1, f"expected >=1 version, got {versions}"
    v = versions[0]
    assert "version_id" in v and v["version_id"]
    assert "note_id" in v and v["note_id"] == note_id
    assert "content_hash" in v
    assert "changed_at" in v and v["changed_at"]
    assert "change_summary" in v


@pytest.mark.asyncio
async def test_list_versions_nonexistent_note_404(client):
    """GET /versions on a nonexistent note returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.get(
        "/api/v1/notes/nonexistent-id-12345/versions", headers=headers
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_versions_empty_for_fresh_note(client):
    """A freshly created note (no edits) has zero version backups."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="fresh content")
    note_id = note["id"]

    resp = await client.get(f"/api/v1/notes/{note_id}/versions", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == []


# --------------------------------------------------------------------------- #
# GET /notes/{id}/versions/{version_id}
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_get_version_returns_prior_content(client):
    """get_version returns the OLD .md body (backup taken before overwrite)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="original body v1")
    note_id = note["id"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}/content",
        json={"content": "new body v2"},
        headers=headers,
    )
    assert resp.status_code == 200

    versions = (
        await client.get(f"/api/v1/notes/{note_id}/versions", headers=headers)
    ).json()
    assert len(versions) >= 1
    version_id = versions[0]["version_id"]

    resp = await client.get(
        f"/api/v1/notes/{note_id}/versions/{version_id}", headers=headers
    )
    assert resp.status_code == 200
    # The backup holds the PRIOR content ("original body v1"), not the new one.
    assert "original body v1" in resp.text
    assert "new body v2" not in resp.text


@pytest.mark.asyncio
async def test_get_version_nonexistent_version_id_404(client):
    """Fetching a nonexistent version_id returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    note = await _create_note(client, headers, content="some content")
    note_id = note["id"]

    resp = await client.get(
        f"/api/v1/notes/{note_id}/versions/v_fake_nonexistent",
        headers=headers,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_version_nonexistent_note_404(client):
    """get_version on a nonexistent note returns 404 (note existence checked first)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.get(
        "/api/v1/notes/nonexistent-id-12345/versions/any_version_id",
        headers=headers,
    )
    assert resp.status_code == 404
