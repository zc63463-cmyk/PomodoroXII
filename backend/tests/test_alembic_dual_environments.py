"""Contract tests for isolated meta and per-space Alembic environments."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import MetaData, create_engine, inspect, text

META_TABLES = {"spaces", "meta_settings"}
SPACE_TABLES = {
    "folders",
    "habit_check_ins",
    "habits",
    "memo_comments",
    "notes",
    "quick_notes",
    "reflections",
    "schedule_quick_notes",
    "schedules",
    "session_quick_notes",
    "sessions",
    "settings",
    "sync_audit_log",
    "sync_outbox",
    "task_quick_notes",
    "tasks",
    "time_blocks",
    "tombstones",
}
VERSION_TABLES = {
    "meta": "alembic_version_meta",
    "space": "alembic_version_space",
}


def _backend_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def _config(environment: str) -> Config:
    config = Config(str(_backend_dir() / "alembic.ini"), ini_section=f"alembic:{environment}")
    # Force-load the selected section before disabling env.py fileConfig side effects.
    config.get_main_option("script_location")
    config.config_file_name = None
    return config


def _upgrade(environment: str, db_path: Path):
    engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    config = _config(environment)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
    return engine


def _selected_metadata(environment: str) -> MetaData:
    from app.db.metadata import get_meta_metadata, get_space_metadata

    if environment == "meta":
        return get_meta_metadata()
    return get_space_metadata()


def _column_signature(inspector, table_name: str) -> dict[str, tuple[str, bool, str | None]]:
    return {
        column["name"]: (
            str(column["type"]),
            bool(column["nullable"]),
            None if column["default"] is None else str(column["default"]),
        )
        for column in inspector.get_columns(table_name)
    }


def _metadata_column_signature(metadata: MetaData, table_name: str, engine) -> dict:
    expected = {}
    for column in metadata.tables[table_name].columns:
        default = None
        if column.server_default is not None:
            default = str(column.server_default.arg)
        expected[column.name] = (
            str(column.type.compile(dialect=engine.dialect)),
            bool(column.nullable),
            default,
        )
    return expected


def _index_signature(inspector, table_name: str) -> set[tuple[str, tuple[str, ...], bool]]:
    return {
        (index["name"], tuple(index["column_names"]), bool(index["unique"]))
        for index in inspector.get_indexes(table_name)
    }


def _metadata_index_signature(metadata: MetaData, table_name: str) -> set[tuple[str, tuple[str, ...], bool]]:
    return {
        (index.name, tuple(column.name for column in index.columns), bool(index.unique))
        for index in metadata.tables[table_name].indexes
    }


def _unique_signature(inspector, table_name: str) -> set[tuple[str | None, tuple[str, ...]]]:
    return {
        (constraint["name"], tuple(constraint["column_names"]))
        for constraint in inspector.get_unique_constraints(table_name)
    }


def _metadata_unique_signature(
    metadata: MetaData, table_name: str
) -> set[tuple[str | None, tuple[str, ...]]]:
    from sqlalchemy import UniqueConstraint

    return {
        (constraint.name, tuple(column.name for column in constraint.columns))
        for constraint in metadata.tables[table_name].constraints
        if isinstance(constraint, UniqueConstraint)
    }


def test_dual_environment_layout_and_ini_sections() -> None:
    backend_dir = _backend_dir()
    for environment in ("meta", "space"):
        migration_dir = backend_dir / f"alembic_{environment}"
        assert (migration_dir / "env.py").is_file()
        assert (migration_dir / "script.py.mako").is_file()
        assert (migration_dir / "versions").is_dir()

        config = _config(environment)
        assert Path(config.get_main_option("script_location")).resolve() == migration_dir.resolve()
        assert config.get_main_option("version_table") == VERSION_TABLES[environment]


def test_each_environment_has_exactly_one_independent_head() -> None:
    meta_script = ScriptDirectory.from_config(_config("meta"))
    space_script = ScriptDirectory.from_config(_config("space"))

    assert len(meta_script.get_heads()) == 1
    assert len(space_script.get_heads()) == 1
    assert set(meta_script.walk_revisions()).isdisjoint(set(space_script.walk_revisions()))


@pytest.mark.parametrize(
    ("environment", "expected_tables", "forbidden_tables"),
    [("meta", META_TABLES, SPACE_TABLES), ("space", SPACE_TABLES, META_TABLES)],
)
def test_fresh_head_creates_only_its_database_schema(
    tmp_path: Path,
    environment: str,
    expected_tables: set[str],
    forbidden_tables: set[str],
) -> None:
    engine = _upgrade(environment, tmp_path / f"{environment}.db")
    try:
        tables = set(inspect(engine).get_table_names())
        assert tables == expected_tables | {VERSION_TABLES[environment]}
        assert tables.isdisjoint(forbidden_tables)
        assert (set(VERSION_TABLES.values()) - {VERSION_TABLES[environment]}).isdisjoint(tables)
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("environment", "table_names"), [("meta", META_TABLES), ("space", SPACE_TABLES)]
)
def test_fresh_head_matches_selected_metadata_key_attributes(
    tmp_path: Path, environment: str, table_names: set[str]
) -> None:
    engine = _upgrade(environment, tmp_path / f"{environment}_parity.db")
    metadata = _selected_metadata(environment)
    inspector = inspect(engine)
    try:
        for table_name in table_names:
            assert _column_signature(inspector, table_name) == _metadata_column_signature(
                metadata, table_name, engine
            )
            assert _index_signature(inspector, table_name) == _metadata_index_signature(
                metadata, table_name
            )
            assert _unique_signature(inspector, table_name) == _metadata_unique_signature(
                metadata, table_name
            )
            assert inspector.get_pk_constraint(table_name)["constrained_columns"] == [
                column.name for column in metadata.tables[table_name].primary_key.columns
            ]
    finally:
        engine.dispose()


@pytest.mark.parametrize("environment", ["meta", "space"])
def test_mixed_legacy_database_fails_closed_without_schema_changes(
    tmp_path: Path, environment: str
) -> None:
    db_path = tmp_path / f"legacy_{environment}.db"
    engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE spaces (id TEXT PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE tasks (id TEXT PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"))
        before = set(inspect(connection).get_table_names())

        config = _config(environment)
        config.attributes["connection"] = connection
        with pytest.raises(RuntimeError, match="legacy|mixed|adopt"):
            command.upgrade(config, "head")

        assert set(inspect(connection).get_table_names()) == before
    engine.dispose()


# ─── Downgrade / Roundtrip ─────────────────────────────────


@pytest.mark.parametrize("environment", ["meta", "space"])
def test_downgrade_to_base_then_upgrade_head_roundtrip(tmp_path: Path, environment: str) -> None:
    """head → base → head roundtrip must succeed and restore the full schema."""
    db_path = tmp_path / f"roundtrip_{environment}.db"
    engine = _upgrade(environment, db_path)
    config = _config(environment)
    script = ScriptDirectory.from_config(config)
    head = script.get_heads()[0]

    try:
        # Downgrade to base (before any revision)
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.downgrade(config, "base")
        after_down = set(inspect(engine).get_table_names())
        # Only the (now-empty) version table may remain; all business tables must be gone
        business_tables = (META_TABLES if environment == "meta" else SPACE_TABLES)
        assert after_down.isdisjoint(business_tables)

        # Upgrade back to head
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, head)
        after_up = set(inspect(engine).get_table_names())
        expected = business_tables | {VERSION_TABLES[environment]}
        assert after_up == expected
    finally:
        engine.dispose()


@pytest.mark.parametrize("environment", ["meta", "space"])
def test_downgrade_leaves_no_residual_tables(tmp_path: Path, environment: str) -> None:
    """After full downgrade to base, no business tables should remain as orphans."""
    db_path = tmp_path / f"residual_{environment}.db"
    engine = _upgrade(environment, db_path)
    config = _config(environment)

    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.downgrade(config, "base")
        tables = set(inspect(engine).get_table_names())
        # Only the (now-empty) version table may remain; no business tables
        business_tables = (META_TABLES if environment == "meta" else SPACE_TABLES)
        assert tables.isdisjoint(business_tables)
    finally:
        engine.dispose()


def test_space_chain_revision_ids_are_disjoint_from_meta() -> None:
    """Meta and space revision IDs must never overlap."""
    meta_revs = {rev.revision for rev in ScriptDirectory.from_config(_config("meta")).walk_revisions()}
    space_revs = {rev.revision for rev in ScriptDirectory.from_config(_config("space")).walk_revisions()}
    assert meta_revs.isdisjoint(space_revs)
    assert len(meta_revs) >= 1
    assert len(space_revs) >= 1
