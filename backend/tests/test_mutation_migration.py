from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from alembic import command

from tests.migrations import run_bound_command


def _upgrade(path: Path, revision: str, *, after: Callable[[Any], None] | None = None) -> None:
    run_bound_command("space", path, command.upgrade, revision, after=after)


def test_space_008_upgrades_to_mutation_journal_and_preserves_legacy_visibility(
    tmp_path: Path,
) -> None:
    path = tmp_path / "space.db"

    def seed_legacy(maintenance) -> None:
        maintenance.execute(
            "INSERT INTO sync_outbox "
            "(entity_type, entity_id, action, payload, created_at, synced_at) "
            "VALUES ('note', 'n1', 'update', '{}', "
            "'2026-07-14T00:00:00.000Z', NULL)"
        )

    _upgrade(path, "space_008_sync_retention_snapshot", after=seed_legacy)
    observed: dict[str, object] = {}

    def verify_009(maintenance) -> None:
        observed["tables"] = {
            row[0]
            for row in maintenance.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        observed["columns"] = {
            row[1] for row in maintenance.execute("PRAGMA table_info(sync_outbox)").fetchall()
        }
        observed["legacy"] = maintenance.execute(
            "SELECT operation_id, batch_id, version, visible FROM sync_outbox WHERE entity_id='n1'"
        ).fetchone()
        observed["head"] = maintenance.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone()[0]

    _upgrade(path, "head", after=verify_009)

    assert {"mutation_batches", "mutation_operations", "mutation_steps"} <= observed["tables"]
    assert {"operation_id", "batch_id", "version", "visible"} <= observed["columns"]
    assert observed["legacy"] == (None, None, None, 1)
    assert observed["head"] == "space_009_mutation_journal"


def test_bound_after_callback_commits_or_rolls_back_and_closes(tmp_path: Path) -> None:
    path = tmp_path / "space.db"
    captured: list[Any] = []

    def commit_after_write(maintenance) -> None:
        captured.append(maintenance)
        maintenance.execute(
            "INSERT INTO mutation_batches "
            "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
            "VALUES ('committed', 'x', 'INTENT', 0, 't', 't')"
        )

    _upgrade(path, "head", after=commit_after_write)
    with pytest.raises(RuntimeError, match="closed"):
        captured[0].execute("SELECT 1")

    def fail_after_write(maintenance) -> None:
        captured.append(maintenance)
        maintenance.execute(
            "INSERT INTO mutation_batches "
            "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
            "VALUES ('rolled-back', 'x', 'INTENT', 0, 't', 't')"
        )
        raise RuntimeError("after callback failed")

    with pytest.raises(RuntimeError, match="after callback failed"):
        _upgrade(path, "head", after=fail_after_write)

    observed: list[int] = []
    _upgrade(
        path,
        "head",
        after=lambda maintenance: observed.append(
            maintenance.execute(
                "SELECT COUNT(*) FROM mutation_batches "
                "WHERE batch_id IN ('committed', 'rolled-back')"
            ).fetchone()[0]
        ),
    )
    assert observed == [1]
    with pytest.raises(RuntimeError, match="closed"):
        captured[1].execute("SELECT 1")


@pytest.mark.parametrize(
    ("setup_sql", "invalid_sql", "constraint"),
    [
        (
            (),
            "INSERT INTO mutation_batches "
            "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
            "VALUES ('b', 'x', 'BOGUS', 0, 't', 't')",
            "ck_mutation_batches_state",
        ),
        (
            (
                "INSERT INTO mutation_batches "
                "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
                "VALUES ('b', 'x', 'INTENT', 0, 't', 't')",
            ),
            "INSERT INTO mutation_operations "
            "(operation_id, batch_id, sequence, command_hash, command_json, "
            "expected_versions_json, projection_set_json, state, created_at, updated_at) "
            "VALUES ('o', 'b', 0, 'x', '{}', '{}', '{}', 'BOGUS', 't', 't')",
            "ck_mutation_operations_state",
        ),
        (
            (
                "INSERT INTO mutation_batches "
                "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
                "VALUES ('b', 'x', 'INTENT', 0, 't', 't')",
                "INSERT INTO mutation_operations "
                "(operation_id, batch_id, sequence, command_hash, command_json, "
                "expected_versions_json, projection_set_json, state, created_at, updated_at) "
                "VALUES ('o', 'b', 0, 'x', '{}', '{}', '{}', 'INTENT', 't', 't')",
            ),
            "INSERT INTO mutation_steps "
            "(operation_id, ordinal, name, store, target, state) "
            "VALUES ('o', 0, 'x', 'x', 'x', 'BOGUS')",
            "ck_mutation_steps_state",
        ),
    ],
)
def test_mutation_journal_rejects_unknown_states(
    tmp_path: Path,
    setup_sql: tuple[str, ...],
    invalid_sql: str,
    constraint: str,
) -> None:
    path = tmp_path / "space.db"

    def violate(maintenance) -> None:
        for statement in setup_sql:
            maintenance.execute(statement)
        with pytest.raises(sqlite3.IntegrityError, match=constraint):
            maintenance.execute(invalid_sql)

    _upgrade(path, "head", after=violate)


@pytest.mark.parametrize(
    ("setup_sql", "invalid_sql", "constraint"),
    [
        (
            (),
            "INSERT INTO mutation_batches "
            "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
            "VALUES ('b', 'x', 'INTENT', -1, 't', 't')",
            "ck_mutation_batches_accepted_count_nonnegative",
        ),
        (
            (
                "INSERT INTO mutation_batches "
                "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
                "VALUES ('b', 'x', 'INTENT', 0, 't', 't')",
            ),
            "INSERT INTO mutation_operations "
            "(operation_id, batch_id, sequence, command_hash, command_json, "
            "expected_versions_json, projection_set_json, state, created_at, updated_at) "
            "VALUES ('o', 'b', -1, 'x', '{}', '{}', '{}', 'INTENT', 't', 't')",
            "ck_mutation_operations_sequence_nonnegative",
        ),
        (
            (
                "INSERT INTO mutation_batches "
                "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
                "VALUES ('b', 'x', 'INTENT', 0, 't', 't')",
                "INSERT INTO mutation_operations "
                "(operation_id, batch_id, sequence, command_hash, command_json, "
                "expected_versions_json, projection_set_json, state, created_at, updated_at) "
                "VALUES ('o', 'b', 0, 'x', '{}', '{}', '{}', 'INTENT', 't', 't')",
            ),
            "INSERT INTO mutation_steps "
            "(operation_id, ordinal, name, store, target, state) "
            "VALUES ('o', -1, 'x', 'x', 'x', 'PENDING')",
            "ck_mutation_steps_ordinal_nonnegative",
        ),
    ],
)
def test_mutation_journal_rejects_negative_counters(
    tmp_path: Path,
    setup_sql: tuple[str, ...],
    invalid_sql: str,
    constraint: str,
) -> None:
    path = tmp_path / "space.db"

    def violate(maintenance) -> None:
        for statement in setup_sql:
            maintenance.execute(statement)
        with pytest.raises(sqlite3.IntegrityError, match=constraint):
            maintenance.execute(invalid_sql)

    _upgrade(path, "head", after=violate)


def test_fresh_journal_enforces_fk_unique_and_exact_indexes(tmp_path: Path) -> None:
    path = tmp_path / "space.db"
    observed: dict[str, object] = {}

    def verify(maintenance) -> None:
        observed["indexes"] = {
            row[0]
            for row in maintenance.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }
        observed["operation_fks"] = maintenance.execute(
            "PRAGMA foreign_key_list(mutation_operations)"
        ).fetchall()
        observed["step_fks"] = maintenance.execute(
            "PRAGMA foreign_key_list(mutation_steps)"
        ).fetchall()
        observed["schemas"] = {
            table: maintenance.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()[0]
            for table in (
                "mutation_batches",
                "mutation_operations",
                "mutation_steps",
            )
        }
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            maintenance.execute(
                "INSERT INTO mutation_operations "
                "(operation_id, batch_id, sequence, command_hash, command_json, "
                "expected_versions_json, projection_set_json, state, created_at, updated_at) "
                "VALUES ('orphan', 'missing', 0, 'x', '{}', '{}', '{}', "
                "'INTENT', 't', 't')"
            )
        maintenance.execute(
            "INSERT INTO mutation_batches "
            "(batch_id, command_hash, state, accepted_count, created_at, updated_at) "
            "VALUES ('b', 'x', 'INTENT', 0, 't', 't')"
        )
        maintenance.execute(
            "INSERT INTO mutation_operations "
            "(operation_id, batch_id, sequence, command_hash, command_json, "
            "expected_versions_json, projection_set_json, state, created_at, updated_at) "
            "VALUES ('o1', 'b', 0, 'x', '{}', '{}', '{}', 'INTENT', 't', 't')"
        )
        with pytest.raises(
            sqlite3.IntegrityError,
            match="mutation_operations.batch_id, mutation_operations.sequence",
        ):
            maintenance.execute(
                "INSERT INTO mutation_operations "
                "(operation_id, batch_id, sequence, command_hash, command_json, "
                "expected_versions_json, projection_set_json, state, created_at, updated_at) "
                "VALUES ('o2', 'b', 0, 'x', '{}', '{}', '{}', "
                "'INTENT', 't', 't')"
            )
        maintenance.execute(
            "INSERT INTO mutation_steps "
            "(operation_id, ordinal, name, store, target, state) "
            "VALUES ('o1', 0, 'first', 'db', 'target', 'PENDING')"
        )
        with pytest.raises(
            sqlite3.IntegrityError,
            match="mutation_steps.operation_id, mutation_steps.ordinal",
        ):
            maintenance.execute(
                "INSERT INTO mutation_steps "
                "(operation_id, ordinal, name, store, target, state) "
                "VALUES ('o1', 0, 'second', 'db', 'target', 'PENDING')"
            )

    _upgrade(path, "head", after=verify)
    assert {row[2] for row in observed["operation_fks"]} == {"mutation_batches"}
    assert {row[2] for row in observed["step_fks"]} == {"mutation_operations"}
    assert {
        "ix_mutation_batches_state",
        "ix_mutation_operations_batch_id",
        "ix_mutation_operations_state",
        "ix_mutation_steps_operation_id",
        "ix_sync_outbox_operation_id",
        "ix_sync_outbox_batch_id",
        "ix_sync_outbox_visible",
    } <= observed["indexes"]
    for constraint in (
        "ck_mutation_batches_state",
        "ck_mutation_batches_accepted_count_nonnegative",
    ):
        assert constraint in observed["schemas"]["mutation_batches"]
    for constraint in (
        "fk_mutation_operations_batch_id_mutation_batches",
        "uq_mutation_operation_sequence",
        "ck_mutation_operations_state",
        "ck_mutation_operations_sequence_nonnegative",
    ):
        assert constraint in observed["schemas"]["mutation_operations"]
    for constraint in (
        "fk_mutation_steps_operation_id_mutation_operations",
        "uq_mutation_step_ordinal",
        "ck_mutation_steps_state",
        "ck_mutation_steps_ordinal_nonnegative",
    ):
        assert constraint in observed["schemas"]["mutation_steps"]


def test_canonical_enum_literals_match_migration_and_orm(tmp_path: Path) -> None:
    from app.models.mutation import MutationBatch, MutationOperation, MutationStep
    from app.mutation.types import MutationState, StepState

    def literals(expression: str) -> set[str]:
        match = re.search(r"\bstate IN \(([^)]*)\)", expression)
        assert match is not None
        inside = match.group(1)
        return {value.strip().strip("'") for value in inside.split(",")}

    path = tmp_path / "space.db"
    schema_sql: dict[str, str] = {}

    def inspect_schema(maintenance) -> None:
        for table in ("mutation_batches", "mutation_operations", "mutation_steps"):
            schema_sql[table] = maintenance.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()[0]

    _upgrade(path, "head", after=inspect_schema)
    expected_mutation = {state.value for state in MutationState}
    expected_steps = {state.value for state in StepState}
    assert literals(schema_sql["mutation_batches"]) == expected_mutation
    assert literals(schema_sql["mutation_operations"]) == expected_mutation
    assert literals(schema_sql["mutation_steps"]) == expected_steps
    for table, expected in (
        (MutationBatch.__table__, expected_mutation),
        (MutationOperation.__table__, expected_mutation),
        (MutationStep.__table__, expected_steps),
    ):
        state_check = next(
            constraint
            for constraint in table.constraints
            if constraint.name and str(constraint.name).endswith("_state")
        )
        assert literals(str(state_check.sqltext)) == expected


def test_partial_mutation_footprint_fails_before_ddl_or_visibility(
    tmp_path: Path,
) -> None:
    path = tmp_path / "space.db"
    _upgrade(
        path,
        "space_008_sync_retention_snapshot",
        after=lambda maintenance: maintenance.execute(
            "CREATE TABLE mutation_batches (batch_id TEXT PRIMARY KEY)"
        ),
    )
    with pytest.raises(RuntimeError, match="unexpected mutation journal footprint"):
        _upgrade(path, "head")
    observed: dict[str, object] = {}

    def verify_unchanged(maintenance) -> None:
        observed["tables"] = {
            row[0]
            for row in maintenance.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        observed["columns"] = {
            row[1] for row in maintenance.execute("PRAGMA table_info(sync_outbox)").fetchall()
        }
        observed["head"] = maintenance.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone()[0]

    _upgrade(path, "space_008_sync_retention_snapshot", after=verify_unchanged)
    assert "mutation_batches" in observed["tables"]
    assert "mutation_operations" not in observed["tables"]
    assert "operation_id" not in observed["columns"]
    assert observed["head"] == "space_008_sync_retention_snapshot"


@pytest.mark.parametrize(
    "assignment",
    [
        "retention_floor=-1, current_cursor=0",
        "retention_floor=0, current_cursor=-1",
        "retention_floor=2, current_cursor=1",
    ],
)
def test_sync_state_floor_cursor_is_fail_closed(tmp_path: Path, assignment: str) -> None:
    path = tmp_path / "space.db"
    _upgrade(
        path,
        "space_008_sync_retention_snapshot",
        after=lambda maintenance: maintenance.execute(f"UPDATE sync_state SET {assignment}"),
    )

    with pytest.raises(RuntimeError, match="floor/cursor"):
        _upgrade(path, "head")
    observed: list[tuple[int, int, str]] = []

    def verify_unchanged(maintenance) -> None:
        floor, cursor = maintenance.execute(
            "SELECT retention_floor, current_cursor FROM sync_state WHERE id=1"
        ).fetchone()
        head = maintenance.execute("SELECT version_num FROM alembic_version_space").fetchone()[0]
        observed.append((floor, cursor, head))

    _upgrade(path, "space_008_sync_retention_snapshot", after=verify_unchanged)
    expected_values = tuple(int(part.split("=")[1]) for part in assignment.split(", "))
    assert observed == [(*expected_values, "space_008_sync_retention_snapshot")]


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE sync_state SET retention_floor=-1, current_cursor=0",
        "UPDATE sync_state SET retention_floor=0, current_cursor=-1",
        "UPDATE sync_state SET retention_floor=2, current_cursor=1",
        "INSERT INTO sync_state (id, retention_floor, current_cursor) VALUES (2, -1, 0)",
        "INSERT INTO sync_state (id, retention_floor, current_cursor) VALUES (2, 0, -1)",
        "INSERT INTO sync_state (id, retention_floor, current_cursor) VALUES (2, 2, 1)",
    ],
)
def test_sync_state_floor_cursor_check_rejects_invalid_writes(
    tmp_path: Path, statement: str
) -> None:
    path = tmp_path / "space.db"

    def violate(maintenance) -> None:
        with pytest.raises(sqlite3.IntegrityError, match="ck_sync_state_floor_cursor"):
            maintenance.execute(statement)

    _upgrade(path, "head", after=violate)


def test_new_outbox_rows_default_invisible_and_reject_negative_version(
    tmp_path: Path,
) -> None:
    path = tmp_path / "space.db"
    observed: list[int] = []

    def verify(maintenance) -> None:
        maintenance.execute(
            "INSERT INTO sync_outbox "
            "(entity_type, entity_id, action, payload, created_at, synced_at) "
            "VALUES ('note', 'default-hidden', 'create', '{}', 't', NULL)"
        )
        observed.append(
            maintenance.execute(
                "SELECT visible FROM sync_outbox WHERE entity_id='default-hidden'"
            ).fetchone()[0]
        )
        with pytest.raises(sqlite3.IntegrityError, match="ck_sync_outbox_version_nonnegative"):
            maintenance.execute(
                "INSERT INTO sync_outbox "
                "(entity_type, entity_id, action, payload, created_at, synced_at, version) "
                "VALUES ('note', 'negative', 'create', '{}', 't', NULL, -1)"
            )

    _upgrade(path, "head", after=verify)
    assert observed == [0]


def test_downgrade_to_008_preserves_legacy_outbox(tmp_path: Path) -> None:
    path = tmp_path / "space.db"

    def seed(maintenance) -> None:
        maintenance.execute(
            "INSERT INTO sync_outbox "
            "(entity_type, entity_id, action, payload, created_at, synced_at, visible) "
            "VALUES ('note', 'legacy', 'create', '{}', 't', NULL, 1)"
        )
        maintenance.execute("UPDATE sync_state SET current_cursor=7 WHERE id=1")

    _upgrade(
        path,
        "head",
        after=seed,
    )
    run_bound_command("space", path, command.downgrade, "space_008_sync_retention_snapshot")
    observed: dict[str, object] = {}

    def verify(maintenance) -> None:
        observed["entity_id"] = maintenance.execute(
            "SELECT entity_id FROM sync_outbox WHERE entity_id='legacy'"
        ).fetchone()[0]
        observed["cursor"] = maintenance.execute(
            "SELECT current_cursor FROM sync_state WHERE id=1"
        ).fetchone()[0]
        observed["tables"] = {
            row[0]
            for row in maintenance.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        observed["columns"] = {
            row[1] for row in maintenance.execute("PRAGMA table_info(sync_outbox)").fetchall()
        }
        observed["indexes"] = {
            row[1] for row in maintenance.execute("PRAGMA index_list(sync_outbox)").fetchall()
        }
        observed["sync_state_sql"] = maintenance.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_state'"
        ).fetchone()[0]

    _upgrade(
        path,
        "space_008_sync_retention_snapshot",
        after=verify,
    )
    assert observed["entity_id"] == "legacy"
    assert observed["cursor"] == 7
    assert {
        "mutation_batches",
        "mutation_operations",
        "mutation_steps",
    }.isdisjoint(observed["tables"])
    assert {"operation_id", "batch_id", "version", "visible"}.isdisjoint(observed["columns"])
    assert {
        "ix_sync_outbox_operation_id",
        "ix_sync_outbox_batch_id",
        "ix_sync_outbox_visible",
    }.isdisjoint(observed["indexes"])
    assert "ck_sync_state_floor_cursor" not in observed["sync_state_sql"]
