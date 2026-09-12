import json
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from app.db.migrations import run_migrations
from app.task_space.contracts import SYSTEM_STATUS_IDS, SYSTEM_TYPE_ID
from app.task_space.migration_preflight import TASK_SPACE_TARGET_HEAD
from tests.migrations import alembic_config, run_bound_command

FINAL_TABLES = {
    "projects",
    "status_definitions",
    "type_definitions",
    "labels",
    "work_item_labels",
    "work_items",
    "work_item_notes",
    "relations",
    "focus_sessions",
    "session_task_contexts",
    "session_attribution_revisions",
    "session_work_item_plans",
    "session_work_item_outcomes",
    "session_command_envelopes",
    "session_command_receipts",
}
LEGACY_TABLES = {"tasks", "sessions", "task_quick_notes", "session_quick_notes"}
#: 最终任务空间 schema 的边界修订（降级守卫所在处）。
SPACE_010 = "space_010_task_space_focus_session"


def test_space_head_creates_exact_final_tables_and_seeds(tmp_path) -> None:
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
        # ★ 2026-09-12：不再硬编码 revision —— 直接对 TASK_SPACE_TARGET_HEAD
        #   （preflight 的同一锚点），加迁移时只改一处。
        assert conn.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone() == (TASK_SPACE_TARGET_HEAD,)
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
        outcome_columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(session_work_item_outcomes)")
        }
        assert {
            "execution_persona",
            "persona_switched",
            "persona_note",
        } <= outcome_columns
        assert "uq_session_attribution_effective" in attribution_indexes
        assert "uq_session_work_item_outcome_effective" in outcome_indexes


def test_space_head_downgrade_rejects_non_seed_rows(tmp_path: Path) -> None:
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

    # ★ 2026-09-12（恢复全量门禁）：原断言写死「版本必须回到 HEAD」，在 head=014
    #   时恰好成立、head 前移后必红 —— SQLite 跨修订 DDL 非事务，且 014 的重建
    #   内部有显式 commit()，会先把上一跳的版本戳固化；010 守卫抛出时回滚只覆盖
    #   其后的步骤。因此断言改为**真实意图**，与 head 号解耦：
    #   ① 未越过 010 边界（fail-closed：绝不半降级到 009 以下）；
    #   ② 数据完好（被守卫拦下的降级不得销毁注入行）。
    with sqlite3.connect(path) as conn:
        version = conn.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone()[0]
    directory = ScriptDirectory.from_config(alembic_config("space"))
    chain: set[str] = set()
    cursor: str | tuple[str, ...] | None = version
    assert isinstance(cursor, str)
    while cursor is not None:
        chain.add(cursor)
        parent = directory.get_revision(cursor)
        cursor = parent.down_revision if parent is not None else None
    assert SPACE_010 in chain, f"downgrade must not cross {SPACE_010}: stopped at {version}"
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT count(*) FROM projects").fetchone() == (1,)


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


def _insert_operation(connection, command_json: str, result_json: str | None = None) -> None:
    connection.execute(
        text(
            "INSERT INTO mutation_operations "
            "(state, command_json, expected_versions_json, projection_set_json, "
            "db_before_json, db_after_json, result_json) "
            "VALUES ('FINALIZED', :command, '{}', '[]', NULL, NULL, :result)"
        ),
        {"command": command_json, "result": result_json},
    )


def test_task_space_preflight_allows_focus_session_journal_envelopes() -> None:
    """回归（2026-09-11）：会话命令的结果信封本身就是 {"session": ...}。

    真实开发库里有两条 FINALIZED 的会话命令（start / pause），其 journal
    JSON 的键名恰好是 "session" —— 旧实现把键名也当旧权威引用，导致任何跑过
    一次专注会话的实例都会被启动 preflight 永久拦死。键名 "session" 属于
    当前 API 信封，不是对已移除权威的引用。
    """
    from app.task_space.migration_preflight import require_empty_legacy_authority

    command_json = json.dumps({
        "command_hash": "b2b4fcb0",
        "db_plans": [{"table": "focus_sessions", "operation": "insert"}],
        "request": {"entity_type": "focus_session"},
        "result_value": {"session": {"focusedSeconds": 946, "plannedSeconds": 1500}},
    })
    result_json = json.dumps({
        "session": {"focusedSeconds": 946, "ownershipState": "authoritative"},
    })
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _preflight_tables(connection)
            _insert_operation(connection, command_json, result_json)
            require_empty_legacy_authority(connection)  # 不得抛错
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "payload",
    [
        {"entity_type": "task"},        # 值：已移除的实体类型
        {"table": "sessions"},          # 值：已移除的表名
        {"tasks": [{"id": "legacy"}]},  # 键：复数表名结构引用仍然拦截
    ],
)
def test_task_space_preflight_still_rejects_removed_authority(payload: dict) -> None:
    """收敛口径后，真正的旧权威引用（值 / 复数表名键）必须继续被拦截。"""
    from app.task_space.migration_preflight import require_empty_legacy_authority

    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _preflight_tables(connection)
            _insert_operation(connection, json.dumps(payload))
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


def test_space_head_rejects_nonempty_legacy_authority_before_ddl(tmp_path: Path) -> None:
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


def test_space_head_rejects_removed_authority_in_terminal_mutation_json(tmp_path: Path) -> None:
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
