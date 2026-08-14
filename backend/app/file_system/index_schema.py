"""Single authority for the identity-bound ``index.db`` schema."""
from __future__ import annotations

import os
import sqlite3
import stat
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.schema import CreateIndex, CreateTable

from app.file_system.schema import (
    FTS5_CREATE_SQL,
    FTS5_TRIGGER_DELETE,
    FTS5_TRIGGER_INSERT,
    FTS5_TRIGGER_UPDATE,
    Base,
    _run_migrations,
)
from app.runtime.sqlite_vfs import BoundSQLiteTarget, MaintenanceOptions

INDEX_SCHEMA_VERSION = 2
EXPECTED_TABLES = {"notes", "folders", "note_paths", "note_versions", "note_links", "schema_meta", "sync_audit_log"}
EXPECTED_FTS = {"notes_fts", "notes_fts_insert", "notes_fts_update", "notes_fts_delete"}


def _is_link_or_reparse(path: Path) -> bool:
    """Reject symlinks and Windows reparse points before any ``resolve``."""
    try:
        status = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if stat.S_ISLNK(status.st_mode):
        return True
    if os.name == "nt":
        attributes = getattr(status, "st_file_attributes", 0)
        return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    return False


class IndexSchemaError(RuntimeError):
    pass


@dataclass(frozen=True)
class IndexSchemaStatus:
    version: int
    valid: bool
    missing_tables: tuple[str, ...] = ()
    missing_indexes: tuple[str, ...] = ()
    missing_fts_objects: tuple[str, ...] = ()
    failure_code: str | None = None


def _ordinary_index_sql() -> dict[str, str]:
    engine = create_engine("sqlite:///:memory:")
    try:
        return {
            index.name: str(CreateIndex(index, if_not_exists=True).compile(dialect=engine.dialect))
            for table in Base.metadata.sorted_tables
            for index in table.indexes
            if index.name
        }
    finally:
        engine.dispose()


def _inspect_status(connection) -> IndexSchemaStatus:
    rows = connection.execute("SELECT name, type FROM sqlite_master").fetchall()
    objects = {name: kind for name, kind in rows}
    indexes = {name for name, kind in rows if kind == "index"}
    version_row = connection.execute(
        "SELECT value FROM schema_meta WHERE key='version'"
    ).fetchone() if "schema_meta" in objects else None
    version = int(version_row[0]) if version_row else 0
    expected_indexes = set(_ordinary_index_sql())
    missing_tables = tuple(sorted(EXPECTED_TABLES - set(objects)))
    missing_indexes = tuple(sorted(expected_indexes - indexes))
    missing_fts = tuple(sorted(EXPECTED_FTS - set(objects)))
    valid = (
        version == INDEX_SCHEMA_VERSION
        and not missing_tables
        and not missing_indexes
        and not missing_fts
    )
    return IndexSchemaStatus(version, valid, missing_tables, missing_indexes, missing_fts,
                             None if valid else "index_schema_invalid")


class IndexStoreSchema:
    def verify(self, path: Path) -> IndexSchemaStatus:
        """Verify a detached index database through the recovery-safe surface."""
        database = Path(path).expanduser()
        if _is_link_or_reparse(database) or not database.is_file():
            return IndexSchemaStatus(
                0,
                False,
                missing_tables=tuple(sorted(EXPECTED_TABLES)),
                failure_code="index_schema_unavailable",
            )
        database = database.resolve()
        uri = f"{database.as_uri()}?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            connection.execute("PRAGMA query_only=ON")
            return _inspect_status(connection)

    def verify_open(self, target: BoundSQLiteTarget) -> IndexSchemaStatus:
        with target.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
            return _inspect_status(connection)

    def upgrade_open(self, target: BoundSQLiteTarget, *, create_if_missing: bool) -> IndexSchemaStatus:
        with target.open_maintenance(
            MaintenanceOptions(read_only=False, create_if_missing=create_if_missing)
        ) as connection:
            engine = create_engine("sqlite:///:memory:")
            try:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA foreign_keys=ON")
                for table in Base.metadata.sorted_tables:
                    connection.execute(str(CreateTable(table, if_not_exists=True).compile(dialect=engine.dialect)))
                _run_migrations(connection)
                connection.execute(FTS5_CREATE_SQL)
                connection.execute(FTS5_TRIGGER_INSERT)
                connection.execute(FTS5_TRIGGER_UPDATE)
                connection.execute(FTS5_TRIGGER_DELETE)
                for sql in _ordinary_index_sql().values():
                    connection.execute(sql)
                connection.execute(
                    "INSERT INTO schema_meta(key,value) VALUES('version',?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(INDEX_SCHEMA_VERSION),),
                )
                connection.commit()
            finally:
                engine.dispose()
        status = self.verify_open(target)
        if not status.valid:
            raise IndexSchemaError(f"index schema invalid: {status}")
        return status

    def rebuild_open(self, target: BoundSQLiteTarget) -> IndexSchemaStatus:
        with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
            for name, sql in _ordinary_index_sql().items():
                connection.execute(f'DROP INDEX IF EXISTS "{name}"')
                connection.execute(sql)
            connection.commit()
        return self.verify_open(target)
