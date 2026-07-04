"""End-to-end integration tests for file_system (Gate #6)."""

from __future__ import annotations

import pytest


class TestFullFlow:
    async def test_create_read_search_delete(self, fs_instance):
        """Full lifecycle: create → read → search → edit → delete → trash → restore."""
        # 1. Create folder
        folder = await fs_instance.create_folder(name="Project")

        # 2. Create note in folder
        meta = await fs_instance.create_note(
            title="Design Doc",
            content="Architecture overview for the new system",
            folder_id=folder.id,
        )

        # 3. Read note content
        content = await fs_instance.read_note(meta.id)
        assert "Architecture" in content

        # 4. Search for the note
        results = await fs_instance.search("Architecture")
        assert any(r.note_id == meta.id for r in results)

        # 5. Edit note
        await fs_instance.edit_note(meta.id, "Updated architecture content")

        # 6. Delete note
        await fs_instance.delete_note(meta.id)
        with pytest.raises(KeyError):
            await fs_instance.read_note(meta.id)

        # 7. List trash
        trash = await fs_instance.list_trash()
        assert any(t["note_id"] == meta.id for t in trash)

        # 8. Restore note
        await fs_instance.restore(meta.id)
        restored = await fs_instance.read_note(meta.id)
        assert "Updated architecture" in restored

    async def test_multiple_notes_batch_read(self, fs_instance):
        """Create multiple notes, batch read, verify order and content."""
        notes = []
        for i in range(3):
            meta = await fs_instance.create_note(
                title=f"Batch{i}",
                content=f"batch content {i}",
            )
            notes.append(meta)

        # Read in a specific order
        ordered_ids = [notes[2].id, notes[0].id, notes[1].id]
        contents = await fs_instance.read_notes_batch(ordered_ids)

        assert len(contents) == 3
        assert contents[0] == "batch content 2"
        assert contents[1] == "batch content 0"
        assert contents[2] == "batch content 1"
