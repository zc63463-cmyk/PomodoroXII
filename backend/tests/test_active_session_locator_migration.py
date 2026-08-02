"""Tests for the meta_002 ActiveSession coordination schema.

Verifies:
- meta_002 creates ``active_session_locator`` and ``active_session_operations``.
- The locator enforces a singleton slot and positive ownership epoch.
- Operation ``result_descriptor_json`` is bounded to 8192 UTF-8 bytes.
- The version table reports ``meta_002_active_session_locator``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.db.migrations import run_migrations


@pytest.fixture
def meta_at_002(tmp_path: Path) -> Path:
    """Return a meta database path migrated to the meta_002 head."""
    path = tmp_path / "meta.db"
    run_migrations("meta", path)
    return path


def test_meta_002_creates_one_locator_slot(tmp_path: Path) -> None:
    path = tmp_path / "meta.db"
    run_migrations("meta", path)
    with sqlite3.connect(path) as conn:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(active_session_locator)")
        }
        assert columns == {
            "singleton_key", "space_id", "session_id", "operation_id", "state",
            "owner_device_id", "owner_tab_id", "ownership_epoch",
            "lease_expires_at", "updated_at",
        }
        operation_columns = {
            row[1] for row in conn.execute(
                "PRAGMA table_info(active_session_operations)"
            )
        }
        assert operation_columns == {
            "operation_id", "kind", "payload_hash", "intent_json", "phase",
            "result_descriptor_json", "related_operation_id", "created_at", "updated_at",
        }
        assert conn.execute(
            "SELECT version_num FROM alembic_version_meta"
        ).fetchone() == ("meta_002_active_session_locator",)
        assert conn.execute(
            "SELECT COUNT(*) FROM active_session_locator"
        ).fetchone() == (0,)


def test_locator_constraints_reject_second_slot_and_non_positive_epoch(
    meta_at_002: Path,
) -> None:
    with sqlite3.connect(meta_at_002) as conn:
        conn.execute(
            "INSERT INTO active_session_locator VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("active", "s1", "fs1", "op1", "active", "d1", "t1", 1,
             "2026-07-15T00:01:00.000Z", "2026-07-15T00:00:00.000Z"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO active_session_locator VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("other", "s2", "fs2", "op2", "active", "d2", "t2", 1,
                 "2026-07-15T00:01:00.000Z", "2026-07-15T00:00:00.000Z"),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE active_session_locator SET ownership_epoch = 0"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE active_session_locator SET ownership_epoch = -1"
            )


def test_operation_result_descriptor_is_bounded(meta_at_002: Path) -> None:
    with sqlite3.connect(meta_at_002) as conn:
        conn.execute(
            "INSERT INTO active_session_operations "
            "(operation_id,kind,payload_hash,intent_json,phase,"
            "result_descriptor_json,related_operation_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            ("op-exact", "start", "0" * 64, "{}", "completed", "x" * 8192,
             None, "2026-07-15T00:00:00.000Z",
                "2026-07-15T00:00:00.000Z"),
            )


def test_locator_state_and_operation_enums_and_hash_are_closed(
    meta_at_002: Path,
) -> None:
    with sqlite3.connect(meta_at_002) as conn:
        locator = (
            "INSERT INTO active_session_locator VALUES "
            "(?,?,?,?,?,?,?,?,?,?)"
        )
        for invalid_state in ("paused", "ACTIVE", ""):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    locator,
                    ("active", "s1", "fs1", "op1", invalid_state, "d1", "t1", 1,
                     "2026-07-15T00:01:00.000Z", "2026-07-15T00:00:00.000Z"),
                )

        operation = (
            "INSERT INTO active_session_operations "
            "(operation_id,kind,payload_hash,intent_json,phase,"
            "result_descriptor_json,related_operation_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)"
        )
        for invalid_kind in ("cancel", "START", ""):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    operation,
                    (f"kind-{invalid_kind or 'empty'}", invalid_kind, "0" * 64,
                     "{}", "prepared", None, None,
                     "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"),
                )
        for invalid_phase in ("running", "COMPLETED", ""):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    operation,
                    (f"phase-{invalid_phase or 'empty'}", "start", "0" * 64,
                     "{}", invalid_phase, None, None,
                     "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"),
                )
        for invalid_hash in ("A" * 64, "0" * 63, "0" * 65, "g" * 64):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    operation,
                    (f"hash-{invalid_hash[:6]}", "start", invalid_hash, "{}",
                     "prepared", None, None,
                     "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"),
                )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO active_session_operations "
                "(operation_id,kind,payload_hash,intent_json,phase,"
                "result_descriptor_json,related_operation_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("op-large", "start", "0" * 64, "{}", "completed", "x" * 8193,
                 None, "2026-07-15T00:00:00.000Z",
                 "2026-07-15T00:00:00.000Z"),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO active_session_operations "
                "(operation_id,kind,payload_hash,intent_json,phase,"
                "result_descriptor_json,related_operation_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("op-multibyte", "start", "0" * 64, "{}", "completed",
                 "雪" * 2731, None, "2026-07-15T00:00:00.000Z",
                 "2026-07-15T00:00:00.000Z"),
            )
