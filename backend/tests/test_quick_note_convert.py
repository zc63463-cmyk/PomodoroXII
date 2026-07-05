"""D-4 (v4 D5b): QuickNote -> Note conversion REST + service tests.

Closes the v4 Phase D gate item: "convert API + memo_comments copy".

Routes:
- POST /api/v1/quick-notes/{id}/convert -> QuickNoteConvertResponse

Layout:
- HTTP tests (1-4, 6) use the ``client`` fixture (self-contained helpers).
- Service-layer test (5) uses ``space_session`` + ``tmp_path`` to insert
  MemoComment rows directly and verify the copy logic.

Run: uv run pytest tests/test_quick_note_convert.py -v
"""

from __future__ import annotations

import pytest

# --------------------------------------------------------------------------- #
# HTTP helpers (self-contained per Phase D gate convention)
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


async def _create_quick_note(client, headers, *, content="hello", tags=None):
    payload = {"content": content}
    if tags is not None:
        payload["tags"] = tags
    resp = await client.post(
        "/api/v1/quick-notes", json=payload, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# --------------------------------------------------------------------------- #
# HTTP: POST /quick-notes/{id}/convert
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_convert_creates_note_and_marks_quick_note(client):
    """POST /convert returns note_id + quick_note_id; both rows are readable."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    qn = await _create_quick_note(
        client, headers, content="convert me to a note", tags=["alpha"]
    )
    qn_id = qn["id"]

    resp = await client.post(
        f"/api/v1/quick-notes/{qn_id}/convert", headers=headers
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["quick_note_id"] == qn_id
    note_id = data["note_id"]
    assert note_id and note_id != qn_id
    assert data["migrated_comments_count"] == 0

    # Note is readable via GET /notes/{id}.
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    note = resp.json()
    assert "convert me to a note" in note["title"]

    # Note content (on filesystem) matches quick note content.
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=headers)
    assert resp.status_code == 200
    assert "convert me to a note" in resp.text

    # Quick note still readable (200) with archived_at + migrated_to_note_id set.
    resp = await client.get(f"/api/v1/quick-notes/{qn_id}", headers=headers)
    assert resp.status_code == 200
    qn_after = resp.json()
    assert qn_after["archived_at"] is not None
    assert qn_after["migrated_to_note_id"] == note_id


@pytest.mark.asyncio
async def test_convert_excluded_from_list_after_convert(client):
    """Converted quick notes do not appear in GET /quick-notes listing."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    qn = await _create_quick_note(client, headers, content="will be hidden")
    qn_id = qn["id"]

    # Pre-convert: list contains the quick note.
    resp = await client.get("/api/v1/quick-notes", headers=headers)
    assert resp.status_code == 200
    ids_before = [item["id"] for item in resp.json()["items"]]
    assert qn_id in ids_before

    # Convert.
    resp = await client.post(
        f"/api/v1/quick-notes/{qn_id}/convert", headers=headers
    )
    assert resp.status_code == 200

    # Post-convert: list excludes the quick note (archived_at filter).
    resp = await client.get("/api/v1/quick-notes", headers=headers)
    assert resp.status_code == 200
    ids_after = [item["id"] for item in resp.json()["items"]]
    assert qn_id not in ids_after


@pytest.mark.asyncio
async def test_convert_twice_returns_409(client):
    """Converting an already-converted quick note returns 409 ConflictError."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    qn = await _create_quick_note(client, headers, content="once only")
    qn_id = qn["id"]

    resp = await client.post(
        f"/api/v1/quick-notes/{qn_id}/convert", headers=headers
    )
    assert resp.status_code == 200

    # Second convert -> 409 ConflictError.
    resp = await client.post(
        f"/api/v1/quick-notes/{qn_id}/convert", headers=headers
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_convert_nonexistent_returns_404(client):
    """Converting a nonexistent quick note returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/quick-notes/nonexistent-id-12345/convert", headers=headers
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_convert_empty_content_uses_default_title(client):
    """Converting a quick note with empty content yields default note title."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    qn = await _create_quick_note(client, headers, content="")
    qn_id = qn["id"]

    resp = await client.post(
        f"/api/v1/quick-notes/{qn_id}/convert", headers=headers
    )
    assert resp.status_code == 200, resp.text
    note_id = resp.json()["note_id"]

    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["title"] == "(converted quick note)"


# --------------------------------------------------------------------------- #
# Service-layer: memo_comments copy verification
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_convert_copies_memo_comments(space_session, tmp_path):
    """convert() copies memo_comments from the quick note to the new Note.

    Originals are preserved (note_id still references the quick note id);
    copies get note_id = new Note.id. migrated_comments_count == N.
    """
    from sqlalchemy import select

    from app.file_system.api import get_file_system
    from app.models.memo_comment import MemoComment
    from app.services.note import NoteService
    from app.services.quick_note import QuickNoteService

    fs = await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )
    qn_svc = QuickNoteService(space_session)
    note_svc = NoteService(space_session, fs)

    qn = await qn_svc.create({"content": "with comments"})
    # Insert 2 memo comments referencing the quick note.
    space_session.add(MemoComment(note_id=qn.id, content="comment 1"))
    space_session.add(MemoComment(note_id=qn.id, content="comment 2"))
    await space_session.flush()

    result = await qn_svc.convert(qn.id, note_service=note_svc)
    await space_session.commit()

    assert result["migrated_comments_count"] == 2
    assert result["note_id"] != qn.id
    assert result["quick_note_id"] == qn.id

    # 2 new comments point to the new Note.id.
    new_comments = (
        await space_session.execute(
            select(MemoComment).where(MemoComment.note_id == result["note_id"])
        )
    ).scalars().all()
    assert len(new_comments) == 2
    assert {c.content for c in new_comments} == {"comment 1", "comment 2"}

    # Originals preserved (note_id still = qn.id).
    orig_comments = (
        await space_session.execute(
            select(MemoComment).where(MemoComment.note_id == qn.id)
        )
    ).scalars().all()
    assert len(orig_comments) == 2


# --------------------------------------------------------------------------- #
# C-4: convert a trashed QuickNote -> ValidationError (422)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_convert_trashed_quick_note_raises_validation_error(space_session, tmp_path):
    """convert() on a trashed QuickNote raises ValidationError.

    C-4 fix: align with NoteService.update_metadata trashed_at guard.
    A trashed quick note must be restored before conversion; the guard
    takes precedence over the archived_at check.
    """
    from app.errors import ValidationError
    from app.file_system.api import get_file_system
    from app.services.note import NoteService
    from app.services.quick_note import QuickNoteService
    from app.services.time import utc_now_iso

    fs = await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )
    qn_svc = QuickNoteService(space_session)
    note_svc = NoteService(space_session, fs)

    qn = await qn_svc.create({"content": "trashed before convert"})
    # Simulate soft-delete (no REST soft-delete route for QN; set trashed_at directly).
    qn.trashed_at = utc_now_iso()
    await space_session.flush()

    with pytest.raises(ValidationError, match="trash"):
        await qn_svc.convert(qn.id, note_service=note_svc)
