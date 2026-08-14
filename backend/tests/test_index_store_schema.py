from __future__ import annotations

import asyncio
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app.file_system.index_schema import INDEX_SCHEMA_VERSION, IndexStoreSchema
from app.runtime.sqlite_vfs import MaintenanceOptions


@pytest.fixture
def index_target(tmp_path: Path):
    from app.runtime.sqlite_vfs import bind_marked_isolated_target, discard_closed_isolated_target

    marker = tmp_path / ".index-marker"
    marker.write_text("index", encoding="ascii")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="index.db",
        marker_basename=marker.name,
        marker_nonce="index",
    )
    try:
        yield target
    finally:
        asyncio.run(target.aclose())
        discard_closed_isolated_target(cleanup, target.identity)


def test_fresh_index_store_has_tables_indexes_fts(index_target) -> None:
    status = IndexStoreSchema().upgrade_open(index_target, create_if_missing=False)
    assert status.version == INDEX_SCHEMA_VERSION == 2
    assert status.valid


def test_verify_open_is_bound_and_rebuilds_missing_index(index_target) -> None:
    schema = IndexStoreSchema()
    schema.upgrade_open(index_target, create_if_missing=False)
    with index_target.open_maintenance(MaintenanceOptions(read_only=False)) as db:
        db.execute('DROP INDEX "ix_notes_level"')
        db.commit()
    status = schema.verify_open(index_target)
    assert not status.valid
    assert "ix_notes_level" in status.missing_indexes
    assert schema.rebuild_open(index_target).valid


def test_missing_bound_store_never_creates_companion(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import _bind_existing_target

    with pytest.raises(Exception):
        _bind_existing_target(tmp_path / "missing.db", create_authority=False)
    assert list(tmp_path.iterdir()) == []


def test_verify_path_is_public_and_read_only(tmp_path: Path, index_target) -> None:
    schema = IndexStoreSchema()
    assert schema.upgrade_open(index_target, create_if_missing=False).valid
    db_path = tmp_path / "index.db"
    with closing(sqlite3.connect(db_path)) as connection:
        assert connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete"

    assert not (tmp_path / "index.db-wal").exists()
    assert not (tmp_path / "index.db-shm").exists()

    status = schema.verify(db_path)

    assert status.valid
    assert not (tmp_path / "index.db-wal").exists()
    assert not (tmp_path / "index.db-shm").exists()
