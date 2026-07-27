"""Observable schema parity gates for both Alembic chains."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from sqlalchemy import Inspector, MetaData, inspect

from tests.migrations import migration_engine, run_bound_command

LEGACY_CUTOVER_TABLES = frozenset(
    {"tasks", "sessions", "task_quick_notes", "session_quick_notes"}
)


def _normalize_sql(value: Any) -> str | None:
    if value is None:
        return None
    normalized = (
        re.sub(r"\s+", " ", str(value).strip())
        .replace('"', "")
        .replace("`", "")
        .lower()
    )
    if re.fullmatch(r"'[+-]?\d+(?:\.\d+)?'", normalized):
        return normalized[1:-1]
    return normalized


def _schema_signature(inspector: Inspector, table_name: str) -> dict[str, Any]:
    columns = {
        column["name"]: (
            column["type"].__class__.__name__.lower(),
            getattr(column["type"], "length", None),
            column["nullable"],
            _normalize_sql(column.get("default")),
        )
        for column in inspector.get_columns(table_name)
    }
    indexes = {
        (
            index["name"],
            tuple(index["column_names"]),
            index["unique"],
            _normalize_sql((index.get("dialect_options") or {}).get("sqlite_where")),
        )
        for index in inspector.get_indexes(table_name)
    }
    unique_constraints = {
        (constraint["name"], tuple(constraint["column_names"]))
        for constraint in inspector.get_unique_constraints(table_name)
    }
    foreign_keys = {
        (
            constraint["name"],
            tuple(constraint["constrained_columns"]),
            constraint["referred_table"],
            tuple(constraint["referred_columns"]),
        )
        for constraint in inspector.get_foreign_keys(table_name)
    }
    checks = {
        (constraint["name"], _normalize_sql(constraint["sqltext"]))
        for constraint in inspector.get_check_constraints(table_name)
    }
    primary_key = inspector.get_pk_constraint(table_name)
    return {
        "columns": columns,
        "primary_key": (primary_key["name"], tuple(primary_key["constrained_columns"])),
        "indexes": indexes,
        "unique_constraints": unique_constraints,
        "foreign_keys": foreign_keys,
        "checks": checks,
    }


def _metadata_signature(metadata: MetaData, tmp_path: Path, schema: str) -> dict[str, Any]:
    engine = migration_engine(tmp_path, f"orm_{schema}")
    try:
        metadata.create_all(engine)
        inspector = inspect(engine)
        return {
            table_name: _schema_signature(inspector, table_name)
            for table_name in inspector.get_table_names()
            if table_name not in LEGACY_CUTOVER_TABLES
        }
    finally:
        engine.dispose()


@pytest.mark.parametrize("schema", ["meta", "space"])
def test_alembic_head_matches_metadata(tmp_path: Path, schema: str) -> None:
    from app.db.metadata import get_meta_metadata, get_space_metadata

    metadata = get_meta_metadata() if schema == "meta" else get_space_metadata()
    engine = migration_engine(tmp_path, f"alembic_{schema}")
    try:
        cfg = run_bound_command(
            schema,
            tmp_path / f"alembic_{schema}.db",
            command.upgrade,
            "head",
        )
        inspector = inspect(engine)
        version_table = cfg.get_main_option("version_table")
        actual = {
            table_name: _schema_signature(inspector, table_name)
            for table_name in inspector.get_table_names()
            if table_name != version_table
        }
    finally:
        engine.dispose()

    assert actual == _metadata_signature(metadata, tmp_path, schema)
