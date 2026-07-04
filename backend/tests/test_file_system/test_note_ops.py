"""Tests for note_ops.py — CRUD + batch read."""

from __future__ import annotations

import pytest

from app.file_system.interfaces import NoteMeta, NoteStatus, NoteLevel


class TestCreateNote:
    async def test_returns_note_meta(self, fs_instance):
        """create_note should return a NoteMeta with id starting with n_."""
        meta = await fs_instance.create_note(title="Test", content="Hello")
        assert isinstance(meta, NoteMeta)
        assert meta.id.startswith("n_")
        assert meta.title == "Test"
        assert meta.status == NoteStatus.ACTIVE

    async def test_writes_md_file(self, fs_instance):
        """create_note should write the .md file to disk."""
        meta = await fs_instance.create_note(title="File Test", content="Content here")
        content = await fs_instance.read_note(meta.id)
        assert content == "Content here"

    async def test_with_folder(self, fs_instance):
        """create_note with folder_id should place the note in that folder."""
        folder = await fs_instance.create_folder(name="MyFolder")
        meta = await fs_instance.create_note(title="In Folder", content="inside", folder_id=folder.id)
        assert meta.folder_id == folder.id

    async def test_with_external_id(self, fs_instance):
        """create_note with external_id should use it as the note_id."""
        meta = await fs_instance.create_note(title="Ext", content="ext", external_id="custom_id_123")
        assert meta.id == "custom_id_123"

    async def test_duplicate_external_id_raises(self, fs_instance):
        """Duplicate external_id should raise ValueError."""
        await fs_instance.create_note(title="First", content="c1", external_id="dup_id")
        with pytest.raises(ValueError, match="already exists"):
            await fs_instance.create_note(title="Second", content="c2", external_id="dup_id")

    async def test_nonexistent_folder_raises(self, fs_instance):
        """Creating a note in a non-existent folder should raise ValueError."""
        with pytest.raises(ValueError, match="does not exist"):
            await fs_instance.create_note(title="Orphan", content="c", folder_id="nonexistent_folder")


class TestReadNote:
    async def test_returns_content(self, fs_instance):
        """read_note should return the note's content."""
        meta = await fs_instance.create_note(title="Read", content="readable content")
        content = await fs_instance.read_note(meta.id)
        assert content == "readable content"

    async def test_not_found_raises(self, fs_instance):
        """read_note with non-existent id should raise KeyError."""
        with pytest.raises(KeyError, match="not found"):
            await fs_instance.read_note("n_nonexistent")

    async def test_meta_returns_metadata(self, fs_instance):
        """read_note_meta should return a NoteMeta."""
        meta = await fs_instance.create_note(title="Meta", content="m", tags=["tag1", "tag2"])
        read_meta = await fs_instance.read_note_meta(meta.id)
        assert read_meta.id == meta.id
        assert read_meta.title == "Meta"
        assert read_meta.tags == ["tag1", "tag2"]


class TestEditNote:
    async def test_updates_content(self, fs_instance):
        """edit_note should update content and change content_hash."""
        meta = await fs_instance.create_note(title="Edit", content="original")
        old_hash = meta.content_hash
        new_meta = await fs_instance.edit_note(meta.id, "updated content")
        assert new_meta.content_hash != old_hash
        content = await fs_instance.read_note(meta.id)
        assert content == "updated content"

    async def test_creates_version_backup(self, fs_instance):
        """edit_note should create a version backup when content changes."""
        meta = await fs_instance.create_note(title="Version", content="v1")
        await fs_instance.edit_note(meta.id, "v2")
        versions = await fs_instance.list_versions(meta.id)
        assert len(versions) >= 1
        assert versions[0].note_id == meta.id

    async def test_meta_updates_title(self, fs_instance):
        """edit_note_meta should update the title and rename the file."""
        meta = await fs_instance.create_note(title="Old Title", content="c")
        await fs_instance.edit_note_meta(meta.id, title="New Title")
        read_meta = await fs_instance.read_note_meta(meta.id)
        assert read_meta.title == "New Title"


class TestDeleteNote:
    async def test_moves_to_trash(self, fs_instance):
        """delete_note should move the .md to .trash/ and mark is_deleted."""
        meta = await fs_instance.create_note(title="Delete", content="del")
        await fs_instance.delete_note(meta.id)
        # Note should not be readable after deletion
        with pytest.raises(KeyError):
            await fs_instance.read_note(meta.id)
        # But should appear in trash
        trash = await fs_instance.list_trash()
        assert any(t["note_id"] == meta.id for t in trash)

    async def test_not_found_raises(self, fs_instance):
        """delete_note with non-existent id should raise KeyError."""
        with pytest.raises(KeyError, match="not found"):
            await fs_instance.delete_note("n_nonexistent")


class TestListNotes:
    async def test_returns_all_active(self, fs_instance):
        """list_notes should return all active (non-deleted) notes."""
        await fs_instance.create_note(title="A", content="a")
        await fs_instance.create_note(title="B", content="b")
        notes = await fs_instance.list_notes()
        assert len(notes) == 2

    async def test_filters_by_folder(self, fs_instance):
        """list_notes with folder_id should filter by folder."""
        folder = await fs_instance.create_folder(name="F")
        await fs_instance.create_note(title="InF", content="f", folder_id=folder.id)
        await fs_instance.create_note(title="NotInF", content="nf")
        notes = await fs_instance.list_notes(folder_id=folder.id)
        assert len(notes) == 1
        assert notes[0].title == "InF"


class TestReadNotesBatch:
    async def test_returns_ordered_contents(self, fs_instance):
        """read_notes_batch should return contents in the same order as input. (Gate #7)"""
        m1 = await fs_instance.create_note(title="N1", content="content1")
        m2 = await fs_instance.create_note(title="N2", content="content2")
        m3 = await fs_instance.create_note(title="N3", content="content3")
        # Request in reverse order
        results = await fs_instance.read_notes_batch([m3.id, m1.id, m2.id])
        assert len(results) == 3
        assert results[0] == "content3"
        assert results[1] == "content1"
        assert results[2] == "content2"

    async def test_empty_input_returns_empty(self, fs_instance):
        """read_notes_batch with empty list should return empty list."""
        results = await fs_instance.read_notes_batch([])
        assert results == []
