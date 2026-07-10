"""Tests for YAML frontmatter module — self-describing .md files.

Verifies that:
- serialize_frontmatter produces valid YAML with all expected keys
- wrap_with_frontmatter prepends frontmatter and handles re-wrap
- strip_frontmatter removes the frontmatter block cleanly
- extract_frontmatter parses back to dict + body
- read_note returns clean content (no frontmatter) for backward compat
- create_note writes .md with frontmatter to disk
- edit_note updates frontmatter on content change
"""
from __future__ import annotations

import pytest

# --------------------------------------------------------------------------- #
# Unit tests for frontmatter helpers
# --------------------------------------------------------------------------- #

def test_serialize_frontmatter_basic():
    """serialize_frontmatter should produce valid YAML block."""
    from app.file_system.frontmatter import serialize_frontmatter

    fm = serialize_frontmatter({
        "id": "n_abc",
        "title": "Test Note",
        "tags": ["work", "urgent"],
        "folder_id": None,
        "content_hash": "sha256:abcdef",
        "created_at": "2026-07-04T10:00:00.000Z",
        "updated_at": "2026-07-04T12:00:00.000Z",
    })
    assert fm.startswith("---\n")
    assert fm.endswith("---\n")
    assert "id: n_abc" in fm
    assert "title: Test Note" in fm
    assert "tags: [work, urgent]" in fm
    assert "folder_id: null" in fm
    assert "content_hash: sha256:abcdef" in fm


def test_serialize_frontmatter_empty_tags():
    """Empty tags list should produce 'tags: []'."""
    from app.file_system.frontmatter import serialize_frontmatter

    fm = serialize_frontmatter({"tags": []})
    assert "tags: []" in fm


def test_wrap_with_frontmatter_prepends():
    """wrap_with_frontmatter should prepend frontmatter before content."""
    from app.file_system.frontmatter import strip_frontmatter, wrap_with_frontmatter

    result = wrap_with_frontmatter({"id": "n_1", "title": "T"}, "Hello world")
    assert result.startswith("---\n")
    assert "Hello world" in result
    # Body should be strippable back to original
    assert strip_frontmatter(result) == "Hello world"


def test_wrap_with_frontmatter_replaces_existing():
    """wrap_with_frontmatter should replace existing frontmatter, not duplicate."""
    from app.file_system.frontmatter import wrap_with_frontmatter

    content_with_fm = "---\nid: old\n---\nBody"
    result = wrap_with_frontmatter({"id": "new"}, content_with_fm)
    # Should only have one frontmatter block
    lines = result.split("\n")
    delimiter_count = sum(1 for line in lines if line.strip() == "---")
    assert delimiter_count == 2, f"Expected 2 delimiters, got {delimiter_count}"
    assert "id: new" in result
    assert "id: old" not in result


def test_strip_frontmatter_no_frontmatter():
    """strip_frontmatter on plain content should return it unchanged."""
    from app.file_system.frontmatter import strip_frontmatter

    assert strip_frontmatter("Just markdown") == "Just markdown"
    assert strip_frontmatter("") == ""


def test_extract_frontmatter_roundtrip():
    """extract_frontmatter should parse back to dict + body."""
    from app.file_system.frontmatter import extract_frontmatter, serialize_frontmatter

    original_meta = {
        "id": "n_xyz",
        "title": "Roundtrip",
        "tags": ["a", "b"],
        "folder_id": "f_123",
        "content_hash": "sha256:abc",
        "created_at": "2026-07-04T10:00:00.000Z",
        "updated_at": "2026-07-04T12:00:00.000Z",
    }
    content = "Hello world"
    wrapped = serialize_frontmatter(original_meta) + "\n" + content
    meta, body = extract_frontmatter(wrapped)
    assert meta is not None
    assert meta["id"] == "n_xyz"
    assert meta["title"] == "Roundtrip"
    assert meta["tags"] == ["a", "b"]
    assert meta["folder_id"] == "f_123"
    assert body == "Hello world"


def test_has_frontmatter_detection():
    """has_frontmatter should correctly detect frontmatter blocks."""
    from app.file_system.frontmatter import has_frontmatter

    assert has_frontmatter("---\nid: x\n---\nbody") is True
    assert has_frontmatter("Just content") is False
    assert has_frontmatter("") is False
    assert has_frontmatter("# Not frontmatter\n---\nbody") is False


# --------------------------------------------------------------------------- #
# Integration tests: file_system create/read with frontmatter
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_create_note_writes_frontmatter_to_disk(tmp_path):
    """create_note should write .md file with YAML frontmatter."""
    from app.file_system.api import get_file_system
    from app.file_system.frontmatter import extract_frontmatter, has_frontmatter

    fs = await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )
    note = await fs.create_note(
        title="Frontmatter Test",
        content="Body content here",
        tags=["test", "frontmatter"],
    )
    # Read the raw .md file directly via read_note_meta to get path info
    note_meta = await fs.read_note_meta(note.id)
    note_path = fs.root / note_meta.current_path if hasattr(note_meta, 'current_path') else None
    # NoteMeta doesn't expose current_path, so use the DB directly
    if note_path is None:
        from app.file_system.engine.base import _make_filename
        filename = _make_filename(note.id, "Frontmatter Test")
        note_path = fs.root / "notes" / filename
    raw = note_path.read_text(encoding="utf-8")
    assert has_frontmatter(raw), "File should have YAML frontmatter"

    meta, body = extract_frontmatter(raw)
    assert meta is not None
    assert meta["id"] == note.id
    assert meta["title"] == "Frontmatter Test"
    assert meta["tags"] == ["test", "frontmatter"]
    assert body == "Body content here"


@pytest.mark.asyncio
async def test_read_note_strips_frontmatter(tmp_path):
    """read_note should return clean content without frontmatter (backward compat)."""
    from app.file_system.api import get_file_system

    fs = await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )
    await fs.create_note(
        title="Backward Compat",
        content="Pure markdown body",
    )
    notes = await fs.list_notes()
    note_id = notes[0].id
    content = await fs.read_note(note_id)
    # Should NOT contain frontmatter
    assert "---\n" not in content
    assert content == "Pure markdown body"


@pytest.mark.asyncio
async def test_edit_note_updates_frontmatter(tmp_path):
    """edit_note should rewrite .md with updated frontmatter."""
    from app.file_system.api import get_file_system
    from app.file_system.frontmatter import extract_frontmatter

    fs = await get_file_system(
        root_dir=tmp_path / "notes",
        index_db=tmp_path / "index.db",
    )
    note = await fs.create_note(
        title="Original Title",
        content="Original content",
    )
    await fs.edit_note(note.id, "Updated content via edit")
    # Read raw file via _make_filename to get path
    from app.file_system.engine.base import _make_filename
    filename = _make_filename(note.id, "Original Title")
    note_path = fs.root / "notes" / filename
    raw = note_path.read_text(encoding="utf-8")
    meta, body = extract_frontmatter(raw)
    assert meta is not None
    assert body == "Updated content via edit"
    # Title should be preserved in frontmatter
    assert meta["title"] == "Original Title"
