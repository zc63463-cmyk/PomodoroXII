"""Tests for schema.py — init_database and migrations."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.file_system.schema import init_database


class TestInitDatabase:
    def test_creates_all_tables(self, tmp_path: Path):
        """init_database should create all expected tables."""
        db_path = tmp_path / "test.db"
        init_database(db_path)
        with sqlite3.connect(str(db_path)) as conn:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
        expected = {"notes", "folders", "note_paths", "note_versions", "note_links",
                     "notes_fts", "schema_meta", "sync_audit_log"}
        assert expected.issubset(tables), f"Missing tables: {expected - tables}"

    def test_is_idempotent(self, tmp_path: Path):
        """init_database should be callable multiple times without error."""
        db_path = tmp_path / "test_idem.db"
        init_database(db_path)
        init_database(db_path)  # Should not raise
        with sqlite3.connect(str(db_path)) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'"
            ).fetchone()[0]
        assert count == 1

    def test_schema_version_tracking(self, tmp_path: Path):
        """schema_meta should record version=1 after init."""
        db_path = tmp_path / "test_ver.db"
        init_database(db_path)
        with sqlite3.connect(str(db_path)) as conn:
            row = conn.execute(
                "SELECT value FROM schema_meta WHERE key = 'version'"
            ).fetchone()
        assert row is not None
        assert int(row[0]) == 1
