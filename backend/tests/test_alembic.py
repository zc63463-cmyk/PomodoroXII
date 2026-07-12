"""Topology tests for the independent Meta and Space Alembic chains."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text

from tests.migrations import alembic_config, migration_engine


@pytest.mark.parametrize(
    ("schema", "expected_tables"),
    [
        ("meta", {"spaces", "meta_settings"}),
        (
            "space",
            {
                "tasks", "sessions", "notes", "folders", "quick_notes",
                "reflections", "habits", "habit_check_ins", "schedules",
                "time_blocks", "memo_comments", "session_quick_notes",
                "schedule_quick_notes", "task_quick_notes", "tombstones",
                "settings", "sync_outbox", "sync_audit_log",
                "sync_state", "sync_snapshots",
            },
        ),
    ],
)
def test_upgrade_head_is_isolated_and_idempotent(
    tmp_path: Path, schema: str, expected_tables: set[str]
) -> None:
    engine = migration_engine(tmp_path, schema)
    cfg = alembic_config(schema)
    try:
        with engine.begin() as connection:
            cfg.attributes["connection"] = connection
            command.upgrade(cfg, "head")
            command.upgrade(cfg, "head")

        version_table = cfg.get_main_option("version_table")
        tables = set(inspect(engine).get_table_names())
        assert tables - {version_table} == expected_tables
        assert version_table in tables
        with engine.connect() as connection:
            revisions = connection.execute(
                text(f'SELECT version_num FROM "{version_table}"')
            ).all()
        assert len(revisions) == 1
        assert revisions[0][0] == ScriptDirectory.from_config(cfg).get_current_head()
    finally:
        engine.dispose()


@pytest.mark.parametrize("schema", ["meta", "space"])
def test_downgrade_base_removes_only_chain_tables(tmp_path: Path, schema: str) -> None:
    engine = migration_engine(tmp_path, schema)
    cfg = alembic_config(schema)
    try:
        with engine.begin() as connection:
            cfg.attributes["connection"] = connection
            command.upgrade(cfg, "head")
            command.downgrade(cfg, "base")

        assert set(inspect(engine).get_table_names()) <= {
            cfg.get_main_option("version_table")
        }
    finally:
        engine.dispose()


def test_space_notes_table_has_no_content_column(tmp_path: Path) -> None:
    engine = migration_engine(tmp_path, "space")
    cfg = alembic_config("space")
    try:
        with engine.begin() as connection:
            cfg.attributes["connection"] = connection
            command.upgrade(cfg, "head")
        columns = {column["name"] for column in inspect(engine).get_columns("notes")}
        assert "content" not in columns
        assert {"content_hash", "word_count"} <= columns
    finally:
        engine.dispose()
