"""End-to-end integration tests for file_system (Gate #6)."""

from __future__ import annotations

import errno
import hashlib
from pathlib import Path

import pytest

from app.file_system.engine.base import (
    WindowsPathTooLongError,
    _is_windows_path_too_long_error,
)


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


class TestAtomicWrite:
    @pytest.mark.parametrize("error_code", [errno.ENAMETOOLONG, None])
    def test_explicit_path_too_long_error_does_not_require_260_characters(
        self, monkeypatch: pytest.MonkeyPatch, error_code: int | None
    ):
        error = OSError(error_code or errno.ENOENT, "path too long")
        if error_code is None:
            error.winerror = 206
        monkeypatch.setattr("app.file_system.engine.base.os.name", "nt")

        assert _is_windows_path_too_long_error(error, Path("short-component"))

    @pytest.mark.parametrize("winerror", [3, 123])
    def test_ambiguous_windows_error_is_not_classified_as_path_too_long(
        self, monkeypatch: pytest.MonkeyPatch, winerror: int
    ):
        error = OSError(errno.ENOENT, "path not found")
        error.winerror = winerror
        monkeypatch.setattr("app.file_system.engine.base.os.name", "nt")

        assert not _is_windows_path_too_long_error(error, Path("nested" * 50))

    def test_success_replaces_target(self, fs_instance):
        target = fs_instance.root / "notes" / "atomic.md"

        fs_instance._atomic_write(target, "first")
        fs_instance._atomic_write(target, "second")

        assert target.read_text(encoding="utf-8") == "second"
        assert not (target.parent / f".{target.name}.tmp").exists()

    def test_windows_long_path_error_has_actionable_diagnostic(
        self, fs_instance, monkeypatch: pytest.MonkeyPatch
    ):
        target = fs_instance.root / ("nested" * 50) / "note.md"
        original = FileNotFoundError(errno.ENOENT, "path not found")
        original.winerror = 206

        monkeypatch.setattr("app.file_system.engine.base.os.name", "nt")

        def fail_mkdir(self, *args, **kwargs):
            raise original

        monkeypatch.setattr(Path, "mkdir", fail_mkdir)

        with pytest.raises(WindowsPathTooLongError) as raised:
            fs_instance._atomic_write(target, "content")

        message = str(raised.value)
        assert str(target) in message
        assert f"target length={len(str(target))}" in message
        assert "Windows long path" in message
        assert "shorten the space/test data directory" in message
        assert raised.value.__cause__ is original

    def test_cleanup_failure_does_not_hide_long_path_diagnostic(
        self, fs_instance, monkeypatch: pytest.MonkeyPatch
    ):
        target = fs_instance.root / ("nested" * 50) / "note.md"
        original = FileNotFoundError(errno.ENOENT, "path not found")
        original.winerror = 206

        monkeypatch.setattr("app.file_system.engine.base.os.name", "nt")

        def fail_mkdir(self, *args, **kwargs):
            raise original

        def fail_unlink(self, *args, **kwargs):
            raise PermissionError("cleanup failed")

        monkeypatch.setattr(Path, "mkdir", fail_mkdir)
        monkeypatch.setattr(Path, "unlink", fail_unlink)

        with pytest.raises(WindowsPathTooLongError) as raised:
            fs_instance._atomic_write(target, "content")

        assert raised.value.__cause__ is original

    def test_ordinary_file_not_found_keeps_original_semantics(
        self, fs_instance, monkeypatch: pytest.MonkeyPatch
    ):
        target = fs_instance.root / "notes" / "ordinary.md"
        original = FileNotFoundError(errno.ENOENT, "ordinary missing file")

        monkeypatch.setattr("app.file_system.engine.base.os.name", "nt")

        def fail_write_text(self, *args, **kwargs):
            raise original

        monkeypatch.setattr(Path, "write_text", fail_write_text)

        with pytest.raises(FileNotFoundError) as raised:
            fs_instance._atomic_write(target, "content")

        assert raised.value is original
        assert not isinstance(raised.value, WindowsPathTooLongError)


class TestStoragePathContract:
    async def test_root_and_current_path_are_space_relative(self, fs_instance):
        note = await fs_instance.create_note(
            title="Path Contract",
            content="content",
            external_id="n_pathcontract",
        )

        with fs_instance._connect() as conn:
            current_path = conn.execute(
                "SELECT current_path FROM notes WHERE note_id = ?", (note.id,)
            ).fetchone()[0]

        relative_path = Path(current_path)
        assert not relative_path.is_absolute()
        assert relative_path.parts[0] == "notes"
        assert relative_path.name.startswith(f"{note.id}-")
        assert relative_path.suffix == ".md"
        assert (fs_instance.root / relative_path).is_file()
        assert (fs_instance.root / "notes").is_dir()
        assert (fs_instance.root / ".trash").is_dir()
        assert (fs_instance.root / ".meta").is_dir()

    async def test_trash_and_version_paths_remain_below_space_root(self, fs_instance):
        note = await fs_instance.create_note(
            title="Managed Paths",
            content="before",
            external_id="n_managedpaths",
        )
        await fs_instance.edit_note(note.id, "after")
        version = (await fs_instance.list_versions(note.id))[0]

        assert (
            fs_instance.root / ".meta" / "version_backups" / f"{version.version_id}.md"
        ).is_file()

        await fs_instance.delete_note(note.id)
        with fs_instance._connect() as conn:
            current_path = conn.execute(
                "SELECT current_path FROM notes WHERE note_id = ?", (note.id,)
            ).fetchone()[0]

        assert current_path.startswith(".trash/")
        assert not Path(current_path).is_absolute()
        assert (fs_instance.root / current_path).is_file()


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
