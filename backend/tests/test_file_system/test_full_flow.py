"""End-to-end integration tests for file_system (Gate #6)."""

from __future__ import annotations

import hashlib

import pytest


def _note_path(fs_instance, note_id):
    with fs_instance._connect() as conn:
        current_path = conn.execute(
            "SELECT current_path FROM notes WHERE note_id = ?", (note_id,)
        ).fetchone()[0]
    return fs_instance.root / current_path


def _db_content_hash(fs_instance, note_id):
    with fs_instance._connect() as conn:
        return conn.execute(
            "SELECT content_hash FROM notes WHERE note_id = ?", (note_id,)
        ).fetchone()[0]


def _sha256(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


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


class TestContentHashConsistency:
    async def test_created_note_with_frontmatter_is_consistent(self, fs_instance):
        note = await fs_instance.create_note(title="Created", content="# Body\n\nText")

        report = await fs_instance.check_consistency()

        assert note.id not in report["hash_mismatches"]

    async def test_edited_note_with_frontmatter_is_consistent(self, fs_instance):
        note = await fs_instance.create_note(title="Edited", content="Before")
        await fs_instance.edit_note(note.id, "After")

        report = await fs_instance.check_consistency()

        assert note.id not in report["hash_mismatches"]

    async def test_frontmatter_only_change_does_not_mismatch_body_hash(self, fs_instance):
        note = await fs_instance.create_note(title="Metadata", content="Stable body")
        path = _note_path(fs_instance, note.id)
        raw = path.read_text(encoding="utf-8")
        path.write_text(raw.replace("title: Metadata", "title: Changed externally"), encoding="utf-8")

        report = await fs_instance.check_consistency()

        assert note.id not in report["hash_mismatches"]

    async def test_legacy_plain_markdown_uses_entire_file_as_body(self, fs_instance):
        note = await fs_instance.create_note(title="Legacy", content="Original")
        path = _note_path(fs_instance, note.id)
        legacy_body = "# Legacy\n\nPlain markdown"
        path.write_text(legacy_body, encoding="utf-8")
        with fs_instance._connect() as conn:
            conn.execute(
                "UPDATE notes SET content_hash = ? WHERE note_id = ?",
                (_sha256(legacy_body), note.id),
            )
            conn.commit()

        report = await fs_instance.check_consistency()

        assert note.id not in report["hash_mismatches"]

    async def test_repair_stores_body_hash_and_is_idempotent(self, fs_instance):
        note = await fs_instance.create_note(title="Repair", content="Body to repair")
        with fs_instance._connect() as conn:
            conn.execute(
                "UPDATE notes SET content_hash = ? WHERE note_id = ?",
                ("incorrect-hash", note.id),
            )
            conn.commit()

        report = await fs_instance.check_consistency()
        first_repair = await fs_instance.repair(report)
        repaired_hash = _db_content_hash(fs_instance, note.id)
        after_repair = await fs_instance.check_consistency()
        second_repair = await fs_instance.repair(after_repair)

        assert report["hash_mismatches"] == [note.id]
        assert first_repair["hash_repaired"] == 1
        assert repaired_hash == _sha256("Body to repair")
        assert after_repair["hash_mismatches"] == []
        assert second_repair.get("hash_repaired", 0) == 0
        assert _db_content_hash(fs_instance, note.id) == repaired_hash

    async def test_external_body_modification_detected_and_repaired(self, fs_instance):
        """Externally modifying only the note body must trigger mismatch, then repair fixes it."""
        note = await fs_instance.create_note(title="External", content="Original body")
        path = _note_path(fs_instance, note.id)
        raw = path.read_text(encoding="utf-8")
        # Replace only the body, preserving frontmatter
        body_start = raw.find("---\n", 4)  # find closing delimiter
        if body_start == -1:
            pytest.skip("note has no frontmatter delimiter")
        new_body = "Tampered body content"
        tampered = raw[:body_start + 4] + "\n" + new_body
        path.write_text(tampered, encoding="utf-8")

        report = await fs_instance.check_consistency()
        assert note.id in report["hash_mismatches"]

        repair_result = await fs_instance.repair(report)
        assert repair_result["hash_repaired"] == 1
        assert _db_content_hash(fs_instance, note.id) == _sha256(new_body)

        after = await fs_instance.check_consistency()
        assert note.id not in after["hash_mismatches"]

    async def test_frontmatter_horizontal_rule_not_treated_as_yaml(self, fs_instance):
        """A Markdown horizontal rule (---) must not be stripped as frontmatter."""
        note = await fs_instance.create_note(title="HR", content="Before rule")
        path = _note_path(fs_instance, note.id)
        # Write a plain markdown file with an HR, no YAML frontmatter
        plain_md = "# Title\n\n---\n\nSome text after HR"
        path.write_text(plain_md, encoding="utf-8")
        with fs_instance._connect() as conn:
            conn.execute(
                "UPDATE notes SET content_hash = ? WHERE note_id = ?",
                (_sha256(plain_md), note.id),
            )
            conn.commit()

        report = await fs_instance.check_consistency()
        # The entire file is the body since there's no valid frontmatter
        assert note.id not in report["hash_mismatches"]
