"""Tests for trash_ops.py — trash listing, restore, purge, empty."""

from __future__ import annotations

import pytest


class TestListTrash:
    async def test_returns_deleted_notes(self, fs_instance):
        """list_trash should return notes that have been deleted."""
        meta = await fs_instance.create_note(title="Trash", content="trash me")
        await fs_instance.delete_note(meta.id)
        trash = await fs_instance.list_trash()
        assert len(trash) >= 1
        assert any(t["note_id"] == meta.id for t in trash)


class TestRestoreNote:
    async def test_undoes_delete(self, fs_instance):
        """restore should mark the note as active again."""
        meta = await fs_instance.create_note(title="Restore", content="restore me")
        await fs_instance.delete_note(meta.id)
        await fs_instance.restore(meta.id)
        # Note should be readable again
        content = await fs_instance.read_note(meta.id)
        assert content == "restore me"
        # And not in trash
        trash = await fs_instance.list_trash()
        assert not any(t["note_id"] == meta.id for t in trash)


class TestPurgeNote:
    async def test_permanently_deletes(self, fs_instance):
        """purge should permanently delete the note from DB."""
        meta = await fs_instance.create_note(title="Purge", content="purge me")
        await fs_instance.delete_note(meta.id)
        await fs_instance.purge(meta.id)
        # Should not be in trash
        trash = await fs_instance.list_trash()
        assert not any(t["note_id"] == meta.id for t in trash)
        # Should not be restorable
        with pytest.raises(KeyError):
            await fs_instance.restore(meta.id)


class TestEmptyTrash:
    async def test_clears_all(self, fs_instance):
        """empty_trash should remove all notes from trash."""
        m1 = await fs_instance.create_note(title="T1", content="c1")
        m2 = await fs_instance.create_note(title="T2", content="c2")
        await fs_instance.delete_note(m1.id)
        await fs_instance.delete_note(m2.id)
        count = await fs_instance.empty_trash()
        assert count >= 2
        trash = await fs_instance.list_trash()
        assert len(trash) == 0
