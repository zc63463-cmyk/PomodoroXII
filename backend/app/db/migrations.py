"""Fail-closed Alembic migration entry points for meta and space databases."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Literal

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import MetaData, create_engine, inspect, text
from sqlalchemy.engine import Connection

DatabaseKind = Literal["meta", "space"]

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = (_BACKEND_DIR / "alembic.ini").resolve()

_VERSION_TABLES = {
    "meta": "alembic_version_meta",
    "space": "alembic_version_space",
}
_ALL_VERSION_TABLES = frozenset({"alembic_version", *_VERSION_TABLES.values()})
_LEGACY_REVISIONS = {
    "meta": "meta_001",
    "space": "space_005_sync_updated_at_indexes",
}


class MigrationSafetyError(RuntimeError):
    """Raised when a database cannot be migrated without an explicit decision."""


def _config(kind: DatabaseKind) -> Config:
    config = Config(str(_ALEMBIC_INI), ini_section=f"alembic:{kind}")
    config.get_main_option("script_location")
    return config


def _metadata(kind: DatabaseKind) -> MetaData:
    from app.db.metadata import get_meta_metadata, get_space_metadata

    if kind == "meta":
        return get_meta_metadata()
    return get_space_metadata()


def _table_names(kind: DatabaseKind) -> frozenset[str]:
    return frozenset(_metadata(kind).tables)


def _single_head(config: Config) -> str:
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        raise MigrationSafetyError(
            f"{config.config_ini_section} migration chain must have exactly one head"
        )
    return heads[0]


def _version_rows(connection: Connection, version_table: str) -> list[str]:
    return list(
        connection.execute(text(f'SELECT version_num FROM "{version_table}"')).scalars()
    )


def _normalize_sql(value: Any) -> str | None:
    if value is None:
        return None
    return " ".join(str(value).strip().lower().split())


def _inspector_fingerprint(connection: Connection, table_names: frozenset[str]) -> dict[str, Any]:
    inspector = inspect(connection)
    fingerprint: dict[str, Any] = {}
    for table_name in sorted(table_names):
        columns = tuple(
            (
                column["name"],
                str(column["type"]).upper(),
                bool(column["nullable"]),
                _normalize_sql(column["default"]),
            )
            for column in inspector.get_columns(table_name)
        )
        pk = tuple(inspector.get_pk_constraint(table_name).get("constrained_columns") or ())
        uniques = frozenset(
            (
                constraint.get("name"),
                tuple(constraint.get("column_names") or ()),
            )
            for constraint in inspector.get_unique_constraints(table_name)
        )
        checks = frozenset(
            (constraint.get("name"), _normalize_sql(constraint.get("sqltext")))
            for constraint in inspector.get_check_constraints(table_name)
        )
        indexes = frozenset(
            (
                index.get("name"),
                tuple(index.get("column_names") or ()),
                bool(index.get("unique")),
                _normalize_sql((index.get("dialect_options") or {}).get("sqlite_where")),
            )
            for index in inspector.get_indexes(table_name)
        )
        fingerprint[table_name] = (columns, pk, uniques, checks, indexes)
    return fingerprint


def _expected_legacy_fingerprint(kind: DatabaseKind) -> dict[str, Any]:
    metadata = _metadata(kind)
    table_names = _table_names(kind)
    engine = create_engine("sqlite://")
    try:
        metadata.create_all(engine)
        with engine.connect() as connection:
            return _inspector_fingerprint(connection, table_names)
    finally:
        engine.dispose()


def _expected_managed_schema(
    kind: DatabaseKind, revision: str
) -> tuple[frozenset[str], dict[str, Any]]:
    config = _config(kind)
    version_table = _VERSION_TABLES[kind]
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, revision)
            table_names = frozenset(inspect(connection).get_table_names()) - {version_table}
            return table_names, _inspector_fingerprint(connection, table_names)
    finally:
        engine.dispose()


def _classify_schema(
    connection: Connection,
    kind: DatabaseKind,
    known_revisions: set[str],
) -> Literal["fresh", "legacy", "managed"]:
    expected_tables = _table_names(kind)
    version_table = _VERSION_TABLES[kind]
    tables = set(inspect(connection).get_table_names())
    present_version_tables = tables & _ALL_VERSION_TABLES
    business_tables = tables - _ALL_VERSION_TABLES

    if not tables:
        return "fresh"

    if present_version_tables:
        if present_version_tables != {version_table}:
            raise MigrationSafetyError(
                f"legacy, foreign, or multiple version tables found: {sorted(present_version_tables)}"
            )
        try:
            rows = _version_rows(connection, version_table)
        except Exception as exc:
            raise MigrationSafetyError(f"invalid {version_table} schema") from exc
        if len(rows) != 1:
            raise MigrationSafetyError(
                f"{version_table} must contain exactly one migration version"
            )
        revision = rows[0]
        if revision not in known_revisions:
            raise MigrationSafetyError(
                f"{version_table} contains unknown migration version {revision!r}"
            )
        revision_tables, expected = _expected_managed_schema(kind, revision)
        if business_tables != revision_tables:
            raise MigrationSafetyError(
                f"managed {kind} schema has mixed, unknown, or missing tables"
            )
        actual = _inspector_fingerprint(connection, revision_tables)
        if actual != expected:
            raise MigrationSafetyError(
                f"managed {kind} schema fingerprint does not match revision {revision!r}"
            )
        return "managed"

    if business_tables == expected_tables:
        actual = _inspector_fingerprint(connection, expected_tables)
        expected = _expected_legacy_fingerprint(kind)
        if actual != expected:
            raise MigrationSafetyError(
                f"legacy {kind} schema fingerprint does not match create_all schema"
            )
        return "legacy"

    raise MigrationSafetyError(
        f"mixed, unknown, or incomplete {kind} schema cannot be adopted safely"
    )


def _migrate_file(kind: DatabaseKind, path: Path) -> None:
    config = _config(kind)
    script = ScriptDirectory.from_config(config)
    head = _single_head(config)
    known_revisions = {revision.revision for revision in script.walk_revisions()}
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    try:
        with engine.begin() as connection:
            state = _classify_schema(connection, kind, known_revisions)
            config.attributes["connection"] = connection
            if state == "legacy":
                config.attributes["allow_legacy_adoption"] = True
                command.stamp(config, _LEGACY_REVISIONS[kind])
                command.upgrade(config, head)
            else:
                command.upgrade(config, head)
    finally:
        engine.dispose()


def run_migrations(kind: DatabaseKind, db_path: Path) -> None:
    """Atomically upgrade one SQLite database, adopting only an exact legacy schema."""
    if kind not in _VERSION_TABLES:
        raise ValueError(f"unsupported database kind: {kind!r}")

    path = Path(db_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    temporary_path: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.migration-", suffix=".db", dir=path.parent
        )
        os.close(fd)
        temporary_path = Path(temporary_name)
        if existed:
            shutil.copy2(path, temporary_path)
        _migrate_file(kind, temporary_path)
        os.replace(temporary_path, path)
        temporary_path = None
    except MigrationSafetyError:
        raise
    except Exception as exc:
        raise MigrationSafetyError(f"failed to migrate {kind} database at {path}") from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
