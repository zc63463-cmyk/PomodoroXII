from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest


class _ContainedFileSystemFixture:
    def __init__(self, root: Path) -> None:
        self._root = root

    @asynccontextmanager
    async def opens(self):
        from app.runtime.contained_io import open_bound_space
        from app.runtime.scope import _walk_existing_ancestors

        notes = self._root / "notes"
        notes.mkdir(parents=True, exist_ok=True)
        (self._root / "space.db").touch()
        (self._root / "index.db").touch()
        paths = SimpleNamespace(
            space_root=self._root.parent,
            db_path=self._root / "space.db",
            notes_dir=notes,
            index_db=self._root / "index.db",
        )
        opens = open_bound_space(paths, _walk_existing_ancestors(paths))
        try:
            yield opens
        finally:
            await opens.close_all()

    @asynccontextmanager
    async def file_system(self):
        from app.file_system.api import open_contained_file_system

        async with self.opens() as opens:
            file_system = await open_contained_file_system(opens)
            try:
                yield file_system
            finally:
                await file_system.close()


@pytest.fixture
def contained_file_system_fixture(tmp_path: Path) -> _ContainedFileSystemFixture:
    return _ContainedFileSystemFixture(tmp_path)


@pytest.mark.asyncio
async def test_contained_entry_never_calls_path_backed_constructor(
    contained_file_system_fixture, monkeypatch
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.file_system.engine import FileSystemStorage

    def forbidden_path_constructor(*args, **kwargs):
        raise AssertionError("contained production path used path-backed constructor")

    monkeypatch.setattr(FileSystemStorage, "__init__", forbidden_path_constructor)
    async with contained_file_system_fixture.opens() as opens:
        file_system = await open_contained_file_system(opens)
        assert file_system._storage_mode == "contained"
        await file_system.close()


@pytest.mark.asyncio
async def test_request_open_verifies_existing_store_without_initializing(
    contained_file_system_fixture, monkeypatch
) -> None:
    from app.file_system.api import open_existing_file_system
    from app.file_system.engine import FileSystemStorage
    from app.file_system.index_schema import IndexStoreSchema

    async with contained_file_system_fixture.opens() as provisioning_opens:
        IndexStoreSchema().upgrade_open(
            provisioning_opens.index_target, create_if_missing=False
        )

    initialized = False

    async def forbidden_init(self):
        nonlocal initialized
        initialized = True
        raise AssertionError("request open attempted initialization")

    monkeypatch.setattr(FileSystemStorage, "init", forbidden_init)
    async with contained_file_system_fixture.opens() as opens:
        file_system = await open_existing_file_system(opens)
        assert file_system._storage_mode == "contained"
        await file_system.close()
    assert initialized is False


def test_contained_entry_and_engine_operations_have_no_path_fallback() -> None:
    from app.file_system.api import open_contained_file_system

    entry_source = inspect.getsource(open_contained_file_system)
    assert "FileSystemStorage.from_bound_handles" in entry_source
    assert "FileSystemStorage(" not in entry_source
    assert "get_file_system(" not in entry_source
    engine_root = Path(__file__).resolve().parents[2] / "app" / "file_system" / "engine"
    for name in (
        "note_ops.py",
        "folder_ops.py",
        "search_ops.py",
        "trash_ops.py",
        "version_ops.py",
        "consistency_ops.py",
    ):
        source = (engine_root / name).read_text(encoding="utf-8")
        assert "self.root" not in source
        assert "self.index_db" not in source
        assert "sqlite3.connect(" not in source


@pytest.mark.asyncio
async def test_contained_import_and_export_require_external_path_capability(
    contained_file_system_fixture, tmp_path: Path
) -> None:
    from app.errors import ExternalPathCapabilityRequiredError

    source = tmp_path / "outside.md"
    source.write_text("do not read", encoding="utf-8")
    output = tmp_path / "outside-export"
    async with contained_file_system_fixture.file_system() as file_system:
        with pytest.raises(ExternalPathCapabilityRequiredError) as imported:
            await file_system.import_from_md(str(source))
        with pytest.raises(ExternalPathCapabilityRequiredError) as exported:
            await file_system.export_folder("folder", str(output))
    assert imported.value.to_domain_record("req-import").code == (
        "external_path_capability_required"
    )
    assert exported.value.to_domain_record("req-export").code == (
        "external_path_capability_required"
    )
    assert source.read_text(encoding="utf-8") == "do not read"
    assert not output.exists()


@pytest.mark.asyncio
async def test_contained_crud_uses_bound_notes_and_index_authorities(
    contained_file_system_fixture,
) -> None:
    async with contained_file_system_fixture.file_system() as file_system:
        folder = await file_system.create_folder("Bound")
        note = await file_system.create_note(
            "Authority note", "first body", folder_id=folder.id
        )
        assert await file_system.read_note(note.id) == "first body"
        edited = await file_system.edit_note(note.id, "second searchable body")
        assert edited.content_hash != note.content_hash
        versions = await file_system.list_versions(note.id)
        assert len(versions) == 1
        assert "first body" in await file_system.get_version(
            note.id, versions[0].version_id
        )
        assert [item.note_id for item in await file_system.search("searchable")] == [
            note.id
        ]
        await file_system.delete_note(note.id)
        assert [item["note_id"] for item in await file_system.list_trash()] == [note.id]
        restored = await file_system.restore(note.id)
        assert restored.id == note.id
        assert await file_system.read_note(note.id) == "second searchable body"
        consistency = await file_system.check_consistency()
        assert consistency["missing_files"] == []
        assert consistency["orphan_files"] == []
        assert consistency["hash_mismatches"] == []
        stats = await file_system.get_stats()
        assert stats["total_notes"] == 1
