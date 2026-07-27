"""Fail-closed checks for the Task Space breaking schema cutover."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy.engine import Connection

from app.db.migrations import MigrationPreflightPolicy, MigrationStatus

LEGACY_ENTITY_TYPES = (
    "task",
    "session",
    "task" + "QuickNote",
    "session" + "QuickNote",
    "task_quick_note",
    "session_quick_note",
)
LEGACY_TABLES = ("tasks", "sessions", "task_quick_notes", "session_quick_notes")
SAFE_MUTATION_TERMINALS = ("FINALIZED", "ABORTED", "COMPENSATED")
TASK_SPACE_TARGET_HEAD = "space_010_task_space_focus_session"


def _contains_removed_authority(value: object) -> bool:
    """Return whether a decoded JSON tree contains a removed authority key/value."""
    removed = frozenset((*LEGACY_ENTITY_TYPES, *LEGACY_TABLES))
    if isinstance(value, str):
        return value in removed
    if isinstance(value, Mapping):
        return any(
            _contains_removed_authority(key) or _contains_removed_authority(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_removed_authority(item) for item in value)
    return False


def require_empty_legacy_authority(connection: Connection) -> None:
    """Reject durable references to the removed Task/Session authority."""
    terminal_marks = ",".join("?" for _ in SAFE_MUTATION_TERMINALS)
    for table_name in ("mutation_batches", "mutation_operations"):
        if connection.exec_driver_sql(
            f"SELECT 1 FROM {table_name} "
            f"WHERE state NOT IN ({terminal_marks}) LIMIT 1",
            SAFE_MUTATION_TERMINALS,
        ).first() is not None:
            raise RuntimeError("breaking_cutover_requires_clean_mutation_journal")

    for row in connection.exec_driver_sql(
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
        if connection.exec_driver_sql(
            f'SELECT 1 FROM "{table_name}" LIMIT 1'
        ).first() is not None:
            raise RuntimeError(f"breaking_cutover_requires_empty_legacy:{table_name}")

    marks = ",".join("?" for _ in LEGACY_ENTITY_TYPES)
    if connection.exec_driver_sql(
        f"SELECT 1 FROM sync_outbox WHERE entity_type IN ({marks}) LIMIT 1",
        LEGACY_ENTITY_TYPES,
    ).first() is not None:
        raise RuntimeError("breaking_cutover_requires_empty_legacy:sync_outbox")
    if connection.exec_driver_sql(
        f"SELECT 1 FROM tombstones WHERE entity_type IN ({marks}) LIMIT 1",
        LEGACY_ENTITY_TYPES,
    ).first() is not None:
        raise RuntimeError("breaking_cutover_requires_empty_legacy:tombstones")


class TaskSpaceCutoverPreflight(MigrationPreflightPolicy):
    """S2-compatible registration for the TS0 empty-legacy policy."""

    target_revision = TASK_SPACE_TARGET_HEAD

    def __init__(self) -> None:
        super().__init__("space", TASK_SPACE_TARGET_HEAD, self._probe)

    @staticmethod
    def _probe(
        kind: str, _status: MigrationStatus, connection: Connection
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
