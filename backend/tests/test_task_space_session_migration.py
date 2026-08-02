import sqlite3
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, text

from app.db.migrations import run_migrations
from app.task_space.contracts import SYSTEM_STATUS_IDS, SYSTEM_TYPE_ID
from tests.migrations import run_bound_command

FINAL_TABLES = {
    "projects",
    "status_definitions",
    "type_definitions",
    "labels",
    "work_item_labels",
    "work_items",
    "work_item_notes",
    "focus_sessions",
    "session_task_contexts",
    "session_attribution_revisions",
    "session_work_item_plans",
    "session_work_item_outcomes",
    "session_command_envelopes",
    "session_command_receipts",
}
LEGACY_TABLES = {"tasks", "sessions", "task_quick_notes", "session_quick_notes"}


def test_space_010_creates_exact_final_tables_and_seeds(tmp_path) -> None:
    path = tmp_path / "space.db"
    run_migrations("space", path)
    with sqlite3.connect(path) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert FINAL_TABLES <= tables
        assert LEGACY_TABLES.isdisjoint(tables)
        statuses = dict(conn.execute("SELECT category, id FROM status_definitions"))
        assert statuses == dict(SYSTEM_STATUS_IDS)
        assert conn.execute(
            "SELECT id FROM type_definitions WHERE system = 1"
        ).fetchone() == (SYSTEM_TYPE_ID,)
        assert conn.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone() == ("space_010_task_space_focus_session",)
        for table_name, removed in {
            "quick_notes": {"session_id"},
            "time_blocks": {"task_id"},
            "reflections": {"related_task_ids", "auto_linked_session_ids"},
        }.items():
            columns = {
                row[1] for row in conn.execute(f"PRAGMA table_info({table_name})")
            }
            assert columns.isdisjoint(removed)
        attribution_indexes = {
            row[1] for row in conn.execute("PRAGMA index_list(session_attribution_revisions)")
        }
        outcome_indexes = {
            row[1] for row in conn.execute("PRAGMA index_list(session_work_item_outcomes)")
        }
        assert "uq_session_attribution_effective" in attribution_indexes
        assert "uq_session_work_item_outcome_effective" in outcome_indexes


def test_space_010_downgrade_rejects_non_seed_rows(tmp_path: Path) -> None:
    path = tmp_path / "space.db"
    run_migrations("space", path)
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO projects "
            "(id,key,next_work_item_number,name,rank,default_status_definition_id,"
            "default_type_definition_id,created_at,updated_at,version) VALUES "
            "('p1','PX',1,'Project',0,'sys-status-not-started','sys-type-work-item',"
            "'2026-07-15T00:00:00.000Z','2026-07-15T00:00:00.000Z',1)"
        )
        conn.commit()
    with pytest.raises(RuntimeError, match="space_010_downgrade_requires_empty_final_schema"):
        run_bound_command("space", path, command.downgrade, "space_009_mutation_journal")
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone() == ("space_010_task_space_focus_session",)


def _preflight_tables(connection) -> None:
    connection.execute(text("CREATE TABLE mutation_batches (state TEXT)"))
    connection.execute(text(
        "CREATE TABLE mutation_operations ("
        "state TEXT, command_json TEXT, expected_versions_json TEXT, "
        "projection_set_json TEXT, db_before_json TEXT, db_after_json TEXT, "
        "result_json TEXT)"
    ))
    for table_name in (*LEGACY_TABLES, "sync_outbox", "tombstones"):
        connection.execute(text(f'CREATE TABLE "{table_name}" (entity_type TEXT)'))


def test_task_space_preflight_clean_database_is_read_only() -> None:
    from app.task_space.migration_preflight import require_empty_legacy_authority

    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _preflight_tables(connection)
            require_empty_legacy_authority(connection)
            assert connection.execute(text("SELECT COUNT(*) FROM mutation_operations")).scalar_one() == 0
    finally:
        engine.dispose()


@pytest.mark.parametrize("table_name", ["sync_outbox", "tombstones"])
def test_task_space_preflight_rejects_legacy_sync_authority(table_name: str) -> None:
    from app.task_space.migration_preflight import require_empty_legacy_authority

    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _preflight_tables(connection)
            connection.execute(
                text(f'INSERT INTO "{table_name}" (entity_type) VALUES (\'task\')')
            )
            with pytest.raises(RuntimeError, match="breaking_cutover_requires_empty_legacy"):
                require_empty_legacy_authority(connection)
    finally:
        engine.dispose()


def test_task_space_preflight_policy_rejects_non_space_target() -> None:
    from app.task_space.migration_preflight import TaskSpaceCutoverPreflight

    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            with pytest.raises(RuntimeError, match="requires a Space target"):
                TaskSpaceCutoverPreflight().probe("meta", None, connection)
    finally:
        engine.dispose()


def _upgrade_to_009(path: Path, *, after=None) -> None:
    run_bound_command("space", path, command.upgrade, "space_009_mutation_journal", after=after)


def test_space_010_rejects_nonempty_legacy_authority_before_ddl(tmp_path: Path) -> None:
    path = tmp_path / "space.db"

    def seed(maintenance) -> None:
        maintenance.execute(
            "INSERT INTO tasks "
            "(id,title,description,status,priority,tags,plan,completion,"
            "estimated_pomodoros,actual_pomodoros,created_at,updated_at,version) "
            "VALUES ('legacy','x','','todo','medium','[]','','',1,0,"
            "'2026-01-01T00:00:00Z','2026-01-01T00:00:00.000Z',1)"
        )

    _upgrade_to_009(path, after=seed)
    with pytest.raises(RuntimeError, match="breaking_cutover_requires_empty_legacy:tasks"):
        run_bound_command("space", path, command.upgrade, "head")

    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone() == ("space_009_mutation_journal",)
        assert conn.execute("SELECT id FROM tasks").fetchone() == ("legacy",)


def test_space_010_rejects_removed_authority_in_terminal_mutation_json(tmp_path: Path) -> None:
    path = tmp_path / "space.db"

    def seed(maintenance) -> None:
        maintenance.execute(
            "INSERT INTO mutation_batches "
            "(batch_id,command_hash,state,accepted_count,created_at,updated_at) "
            "VALUES ('b1','hash','FINALIZED',0,'t','t')"
        )
        maintenance.execute(
            "INSERT INTO mutation_operations "
            "(operation_id,batch_id,sequence,command_hash,command_json,"
            "expected_versions_json,projection_set_json,state,created_at,updated_at) "
            "VALUES ('o1','b1',0,'hash','{\"entity_type\":\"task\"}',"
            "'{}','[]','FINALIZED','t','t')"
        )

    _upgrade_to_009(path, after=seed)
    with pytest.raises(RuntimeError, match="breaking_cutover_requires_empty_legacy:mutation_journal"):
        run_bound_command("space", path, command.upgrade, "head")
