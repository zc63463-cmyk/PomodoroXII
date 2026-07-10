"""Tests for Alembic migration 002 (phase_b_all_models).

Uses the connection-sharing path in env.py: when
``config.attributes["connection"]`` is set, env.py runs migrations
synchronously on that connection, bypassing the async engine and
fileConfig side-effects.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def _alembic_cfg() -> Config:
    """Build an Alembic Config pointing at the project's alembic.ini.

    We read the ini file so that ``script_location`` and other options
    are populated, then clear ``config_file_name`` to suppress the
    ``fileConfig()`` call inside env.py (which would re-configure
    Python logging and pollute test output).
    """
    backend_dir = Path(__file__).resolve().parent.parent
    ini_path = backend_dir / "alembic.ini"
    cfg = Config(str(ini_path))
    # Ensure script_location is resolved relative to the backend dir,
    # not the pytest CWD (which may differ).
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    # Suppress fileConfig logging side-effects during tests.
    cfg.config_file_name = None
    return cfg


def _run_migration(tmp_path: Path, action: str, revision: str):
    """Run an Alembic migration on a fresh temp SQLite DB.

    Returns the *engine* (still open) so the caller can inspect schema.
    """
    cfg = _alembic_cfg()
    db_path = tmp_path / "alembic_test.db"
    engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        if action == "upgrade":
            command.upgrade(cfg, revision)
        else:
            command.downgrade(cfg, revision)
    return engine


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def test_upgrade_to_head_creates_20_tables(tmp_path: Path) -> None:
    """upgrade head should create all 20 tables (2 meta + 18 business)."""
    engine = _run_migration(tmp_path, "upgrade", "head")
    try:
        all_tables = inspect(engine).get_table_names()
        # Exclude alembic_version (Alembic's own bookkeeping table).
        app_tables = [t for t in all_tables if t != "alembic_version"]
        assert len(app_tables) == 20, \
            f"Expected 20 app tables, got {len(app_tables)}: {sorted(app_tables)}"
    finally:
        engine.dispose()


def test_downgrade_to_001_leaves_only_2_meta_tables(tmp_path: Path) -> None:
    """downgrade to 001 should leave only spaces + meta_settings."""
    # First upgrade to head, then downgrade back to 001.
    engine = _run_migration(tmp_path, "upgrade", "head")
    try:
        cfg = _alembic_cfg()
        with engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.downgrade(cfg, "001")
        tables = inspect(engine).get_table_names()
        # Exclude alembic_version (Alembic's own bookkeeping table).
        app_tables = [t for t in tables if t != "alembic_version"]
        assert sorted(app_tables) == ["meta_settings", "spaces"], \
            f"Expected only meta tables, got: {sorted(app_tables)}"
    finally:
        engine.dispose()


def test_notes_table_has_no_content_column(tmp_path: Path) -> None:
    """notes table must NOT have a 'content' column (D4 decision).

    It should have 'content_hash' and 'word_count' instead.
    """
    engine = _run_migration(tmp_path, "upgrade", "head")
    try:
        columns = {col["name"] for col in inspect(engine).get_columns("notes")}
        assert "content" not in columns, "notes table must not have a 'content' column"
        assert "content_hash" in columns, "notes table must have 'content_hash'"
        assert "word_count" in columns, "notes table must have 'word_count'"
    finally:
        engine.dispose()
