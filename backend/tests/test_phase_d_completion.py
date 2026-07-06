"""Phase D completion gate tests -- 8 项全绿 = Phase D 100%.

Covers the v4 Phase D gate items end-to-end through HTTP (where possible)
or service-layer (for frontmatter, which strips frontmatter on read):

| # | Test                                 | Gate |
|---|--------------------------------------|------|
| D-1a | PATCH metadata 不写 .md            | metadata 分离 |
| D-1b | PUT /content 写 .md + content_hash | content 分离  |
| D-2a | note 软删→trash→restore 内容完整   | trash 对齐   |
| D-2b | folder 软删仍在 trash              | trash 回归   |
| D-3  | list_versions + get_version HTTP   | 版本历史     |
| D-4  | quick_note convert → note          | convert      |
| D-5  | FTS search 命中 title/body         | #16 回归     |
| D-6  | frontmatter 7 字段                 | D6 自描述    |

Self-contained helpers (do NOT import other test modules to avoid fixture
pollution). Run: uv run pytest tests/test_phase_d_completion.py -v
"""
from __future__ import annotations

import pytest

# --------------------------------------------------------------------------- #
# Self-contained HTTP helpers
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
        "/api/v1/spaces", json={"name": "Phase D Gate Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    return resp.json()["space_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_note(client, headers, *, content="Hello world", title="Test"):
    resp = await client.post(
        "/api/v1/notes",
        json={"title": title, "content": content},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# --------------------------------------------------------------------------- #
# D-1a: PATCH /notes/{id} 不写 .md
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d1a_patch_metadata_does_not_write_md(client):
    """PATCH metadata leaves content_hash and .md body unchanged."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)
    note = await _create_note(client, h, content="Original body")
    note_id = note["id"]
    original_hash = note["content_hash"]

    # Read original .md content.
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=h)
    assert resp.status_code == 200
    original_md = resp.text

    # PATCH metadata.
    resp = await client.patch(
        f"/api/v1/notes/{note_id}",
        json={"title": "Patched Title", "tags": ["gate"]},
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "Patched Title"
    assert resp.json()["content_hash"] == original_hash

    # .md body unchanged.
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=h)
    assert resp.status_code == 200
    assert resp.text == original_md


# --------------------------------------------------------------------------- #
# D-1b: PUT /notes/{id}/content 写 .md + content_hash
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d1b_put_content_writes_md_and_hash(client):
    """PUT /content rewrites .md and bumps content_hash."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)
    note = await _create_note(client, h, content="v1")
    note_id = note["id"]
    original_hash = note["content_hash"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}/content",
        json={"content": "v2 - rewritten body"},
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    new_hash = resp.json()["content_hash"]
    assert new_hash != original_hash

    # GET /content reflects new body.
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=h)
    assert resp.status_code == 200
    assert "v2 - rewritten body" in resp.text


# --------------------------------------------------------------------------- #
# D-2a: note 软删 → trash → restore → 内容完整
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d2a_note_soft_delete_restore_content_intact(client):
    """Soft-delete -> trash -> restore -> .md content fully recovered."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)
    note = await _create_note(
        client, h, content="Soft-delete me, then restore"
    )
    note_id = note["id"]

    # Soft-delete via DELETE /notes/{id}.
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=h)
    assert resp.status_code == 200

    # Trash listing contains the note.
    resp = await client.get("/api/v1/trash", headers=h)
    assert resp.status_code == 200
    assert note_id in [item["entity_id"] for item in resp.json()["items"]]

    # Restore.
    resp = await client.post(
        f"/api/v1/trash/note/{note_id}/restore", headers=h
    )
    assert resp.status_code == 200, resp.text

    # trashed_at cleared; content intact.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=h)
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is None
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=h)
    assert resp.status_code == 200
    assert "Soft-delete me, then restore" in resp.text


# --------------------------------------------------------------------------- #
# D-2b: folder 软删仍在 trash
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d2b_folder_soft_delete_appears_in_trash(client):
    """DELETE /folders/{id} soft-deletes; folder appears in /trash."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)

    resp = await client.post(
        "/api/v1/folders", json={"name": "Gate Folder"}, headers=h
    )
    assert resp.status_code == 201
    folder_id = resp.json()["id"]

    # Soft-delete via DELETE /folders/{id}.
    resp = await client.delete(f"/api/v1/folders/{folder_id}", headers=h)
    assert resp.status_code == 200, resp.text

    # Folder appears in trash listing.
    resp = await client.get("/api/v1/trash", headers=h)
    assert resp.status_code == 200
    trash_ids = [item["entity_id"] for item in resp.json()["items"]]
    assert folder_id in trash_ids


# --------------------------------------------------------------------------- #
# D-3: list_versions + get_version HTTP
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d3_versions_rest_list_and_get(client):
    """Edit a note -> list_versions >= 1 -> get_version returns prior body."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)
    note = await _create_note(client, h, content="v1 original body")
    note_id = note["id"]

    # Rewrite content -> produces a version backup.
    resp = await client.put(
        f"/api/v1/notes/{note_id}/content",
        json={"content": "v2 updated body"},
        headers=h,
    )
    assert resp.status_code == 200

    # List versions.
    resp = await client.get(f"/api/v1/notes/{note_id}/versions", headers=h)
    assert resp.status_code == 200
    versions = resp.json()
    assert len(versions) >= 1

    # Get the first version's content -> should be the PRIOR body.
    version_id = versions[0]["version_id"]
    resp = await client.get(
        f"/api/v1/notes/{note_id}/versions/{version_id}", headers=h
    )
    assert resp.status_code == 200
    assert "v1 original body" in resp.text


# --------------------------------------------------------------------------- #
# D-4: quick_note convert → note + migrated_to_note_id
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d4_quick_note_convert_creates_note(client):
    """POST /quick-notes/{id}/convert creates a Note and marks the QN archived."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)

    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "Quick capture to convert"},
        headers=h,
    )
    assert resp.status_code == 201
    qn_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/quick-notes/{qn_id}/convert", headers=h
    )
    assert resp.status_code == 200, resp.text
    note_id = resp.json()["note_id"]
    assert note_id and note_id != qn_id

    # Note readable.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=h)
    assert resp.status_code == 200
    assert "Quick capture to convert" in resp.json()["title"]

    # Quick note marked as archived + migrated.
    resp = await client.get(f"/api/v1/quick-notes/{qn_id}", headers=h)
    assert resp.status_code == 200
    assert resp.json()["archived_at"] is not None
    assert resp.json()["migrated_to_note_id"] == note_id

    # Quick note excluded from listing.
    resp = await client.get("/api/v1/quick-notes", headers=h)
    assert resp.status_code == 200
    assert qn_id not in [item["id"] for item in resp.json()["items"]]


# --------------------------------------------------------------------------- #
# D-5: FTS search 命中 title/body
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d5_fts_search_hits_title_and_body(client):
    """GET /notes/search?q=... returns matches from title and body."""
    token = await _setup_login_and_space_token(client)
    h = _headers(token)

    # Create a note with a distinctive title and body keyword.
    await _create_note(
        client, h, title="Phase D Gate Note", content="contains gatekeyword"
    )

    # Search by title term.
    resp = await client.get(
        "/api/v1/notes/search?q=Phase", headers=h
    )
    assert resp.status_code == 200
    titles = [r["title"] for r in resp.json()]
    assert any("Phase D Gate Note" == t for t in titles), titles

    # Search by body keyword.
    resp = await client.get(
        "/api/v1/notes/search?q=gatekeyword", headers=h
    )
    assert resp.status_code == 200
    assert len(resp.json()) >= 1
    assert any(r["title"] == "Phase D Gate Note" for r in resp.json())


# --------------------------------------------------------------------------- #
# D-6: frontmatter 7 字段（service-layer E2E）
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_d6_frontmatter_seven_fields_in_md_file(space_session, tmp_path):
    """A note's raw .md file contains YAML frontmatter with 7+ fields.

    Fields verified: id, title, tags, folder_id, content_hash, created_at,
    updated_at. The HTTP GET /content path strips frontmatter, so this
    test reads the raw .md file from the filesystem directly.
    """
    from app.file_system.api import get_file_system
    from app.file_system.frontmatter import extract_frontmatter, has_frontmatter
    from app.services.note import NoteService

    fs = await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )
    svc = NoteService(space_session, fs)
    note = await svc.create({
        "title": "Frontmatter Gate",
        "content": "Body for frontmatter gate test",
        "tags": ["gate", "frontmatter"],
    })

    # Locate the raw .md file via the same helper test_frontmatter.py uses.
    from app.file_system.engine.base import _make_filename
    filename = _make_filename(note.id, "Frontmatter Gate")
    note_path = fs.root / "notes" / filename
    assert note_path.exists(), f".md file not found at {note_path}"
    raw = note_path.read_text(encoding="utf-8")

    assert has_frontmatter(raw), "raw .md should start with YAML frontmatter"
    meta, body = extract_frontmatter(raw)
    assert meta is not None

    # 7 expected fields.
    expected = {
        "id", "title", "tags", "folder_id",
        "content_hash", "created_at", "updated_at",
    }
    missing = expected - set(meta.keys())
    assert not missing, f"frontmatter missing fields: {missing}"

    # Spot-check a few values.
    assert meta["id"] == note.id
    assert meta["title"] == "Frontmatter Gate"
    assert meta["tags"] == ["gate", "frontmatter"]
    # Frontmatter stores "sha256:<16-char prefix>"; DB stores full 64-char hex.
    assert meta["content_hash"].startswith("sha256:")
    prefix = meta["content_hash"].removeprefix("sha256:")
    assert note.content_hash.startswith(prefix), (
        f"DB hash {note.content_hash!r} should start with frontmatter prefix {prefix!r}"
    )
    assert body == "Body for frontmatter gate test"
