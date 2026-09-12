"""Fail-closed checks for the Task Space breaking schema cutover."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from app.db.migrations import MigrationPreflightPolicy, MigrationStatus

LEGACY_ENTITY_TYPES = (
    "task",
    "session",
    "taskQuickNote",
    "sessionQuickNote",
    "task_quick_note",
    "session_quick_note",
)
LEGACY_TABLES = ("tasks", "sessions", "task_quick_notes", "session_quick_notes")
SAFE_MUTATION_TERMINALS = ("FINALIZED", "ABORTED", "COMPENSATED")
# ★★ 加 space 迁移时必须同步更新这个值。
#    它是 fleet preflight 的锚点：bootstrap 用它比对 alembic head，
#    不一致就直接拒绝启动（防止有人偷偷改了迁移链）。
#    忘了更新的症状是启动时报
#    "fleet preflight policy targets a different revision"（assets 踩过一次）。
TASK_SPACE_TARGET_HEAD = "space_015_relation_resolution"


# ★★ 判定口径（2026-09-11 修正，勿回退）：
#   旧权威引用只会以「标识值」出现 —— entity_type / table 这类字段的**值**
#   （"task"、"sessions" …）。而**键名不能全树扫**：当前代码为每条会话命令
#   写入的结果信封本身就长这样 {"session": {...}}
#   （focus_session/policy.py 多处 value={"session": ...}，journal 原样持久化
#   result_value），任何实例只要跑过一次专注会话，键名 "session" 就会被误判，
#   被启动 preflight 永久拦死（2026-09-11 实测：开发库 2c1b5b92 的两条
#   FINALIZED start/pause 命令触发了 breaking_cutover_requires_empty_legacy）。
#   ⇒ 值：全量扫描；键：仅扫「表名」（复数）—— 保留对 {"tasks": [...]} 这类
#     旧结构引用的检测，同时不误伤当前 API 信封。
REMOVED_AUTHORITY_VALUES = frozenset((*LEGACY_ENTITY_TYPES, *LEGACY_TABLES))
REMOVED_AUTHORITY_KEYS = frozenset(LEGACY_TABLES)


def _contains_removed_authority(value: object) -> bool:
    """Return whether a decoded JSON tree contains a removed authority reference."""
    if isinstance(value, str):
        return value in REMOVED_AUTHORITY_VALUES
    if isinstance(value, Mapping):
        return any(
            (isinstance(key, str) and key in REMOVED_AUTHORITY_KEYS)
            or _contains_removed_authority(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_removed_authority(item) for item in value)
    return False


def _execute(connection: Any, statement: str, parameters: tuple = ()):
    execute_driver_sql = getattr(connection, "exec_driver_sql", None)
    if execute_driver_sql is not None:
        return execute_driver_sql(statement, parameters)
    return connection.execute(statement, parameters)


def _first(result: Any):
    first = getattr(result, "first", None)
    return first() if first is not None else result.fetchone()


def require_empty_legacy_authority(connection: Any) -> None:
    """Reject durable references to the removed Task/Session authority."""
    terminal_marks = ",".join("?" for _ in SAFE_MUTATION_TERMINALS)
    for table_name in ("mutation_batches", "mutation_operations"):
        if _first(_execute(
            connection,
            f"SELECT 1 FROM {table_name} "
            f"WHERE state NOT IN ({terminal_marks}) LIMIT 1",
            SAFE_MUTATION_TERMINALS,
        )) is not None:
            raise RuntimeError("breaking_cutover_requires_clean_mutation_journal")

    for row in _execute(
        connection,
        "SELECT command_json, expected_versions_json, projection_set_json, "
        "db_before_json, db_after_json, result_json "
        "FROM mutation_operations"
    ):
        for raw in row:
            if raw is None:
                continue
            try:
                value: Any = json.loads(raw)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(
                    "breaking_cutover_requires_valid_mutation_json"
                ) from exc
            if _contains_removed_authority(value):
                raise RuntimeError(
                    "breaking_cutover_requires_empty_legacy:mutation_journal"
                )

    for table_name in LEGACY_TABLES:
        exists = _first(
            _execute(
                connection,
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = ? LIMIT 1",
                (table_name,),
            )
        )
        if exists is None:
            continue
        if _first(_execute(
            connection,
            f'SELECT 1 FROM "{table_name}" LIMIT 1'
        )) is not None:
            raise RuntimeError(f"breaking_cutover_requires_empty_legacy:{table_name}")

    marks = ",".join("?" for _ in LEGACY_ENTITY_TYPES)
    if _first(_execute(
        connection,
        f"SELECT 1 FROM sync_outbox WHERE entity_type IN ({marks}) LIMIT 1",
        LEGACY_ENTITY_TYPES,
    )) is not None:
        raise RuntimeError("breaking_cutover_requires_empty_legacy:sync_outbox")
    if _first(_execute(
        connection,
        f"SELECT 1 FROM tombstones WHERE entity_type IN ({marks}) LIMIT 1",
        LEGACY_ENTITY_TYPES,
    )) is not None:
        raise RuntimeError("breaking_cutover_requires_empty_legacy:tombstones")


class TaskSpaceCutoverPreflight(MigrationPreflightPolicy):
    """S2-compatible registration for the TS0 empty-legacy policy."""

    target_revision = TASK_SPACE_TARGET_HEAD

    def __init__(self) -> None:
        super().__init__("space", TASK_SPACE_TARGET_HEAD, self._probe)

    @staticmethod
    def _probe(
        kind: str, _status: MigrationStatus, connection: Any
    ) -> None:
        if kind != "space":
            raise RuntimeError("task-space cutover preflight requires a Space target")
        require_empty_legacy_authority(connection)


__all__ = [
    "LEGACY_ENTITY_TYPES",
    "LEGACY_TABLES",
    "SAFE_MUTATION_TERMINALS",
    "TASK_SPACE_TARGET_HEAD",
    "TaskSpaceCutoverPreflight",
    "require_empty_legacy_authority",
]
