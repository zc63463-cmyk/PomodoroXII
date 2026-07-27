"""Metadata providers for the independent Meta and Space schemas."""

from __future__ import annotations

from sqlalchemy import Column, Index, MetaData, String

from app.db.base import MetaBase, SpaceBase

REMOVED_LEGACY_SPACE_TABLES = frozenset(
    {"tasks", "sessions", "task_quick_notes", "session_quick_notes"}
)
FINAL_TASK_SPACE_TABLES = frozenset(
    {
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
)
REMOVED_LEGACY_SPACE_COLUMNS = {
    "quick_notes": frozenset({"session_id"}),
    "time_blocks": frozenset({"task_id"}),
    "reflections": frozenset({"related_task_ids", "auto_linked_session_ids"}),
}

# These columns remain part of the pre-TS0 adoption fingerprint.  The runtime
# models intentionally no longer declare them, so legacy metadata restores the
# exact old shape explicitly instead of coupling the new domain to dead refs.
LEGACY_SPACE_COLUMNS = {
    "quick_notes": (("session_id", String(36), True, "ix_quick_notes_session_id"),),
    "time_blocks": (("task_id", String(36), True, "ix_time_blocks_task_id"),),
    "reflections": (
        ("related_task_ids", String(4000), False, None),
        ("auto_linked_session_ids", String(4000), False, None),
    ),
}


def _copy_table_without_columns(table, metadata: MetaData, removed: frozenset[str]):
    copied = table.to_metadata(metadata)
    for index in list(copied.indexes):
        if any(column.name in removed for column in index.columns):
            copied.indexes.remove(index)
    for constraint in list(copied.constraints):
        if hasattr(constraint, "columns") and any(
            column.name in removed for column in constraint.columns
        ):
            copied.constraints.remove(constraint)
    for column_name in removed:
        if column_name in copied.c:
            copied._columns.remove(copied.c[column_name])
    return copied


def _restore_legacy_columns(table, metadata: MetaData) -> None:
    for name, column_type, nullable, index_name in LEGACY_SPACE_COLUMNS.get(
        table.name, ()
    ):
        if name in table.c:
            continue
        table.append_column(Column(name, column_type, nullable=nullable))
        if index_name:
            Index(index_name, table.c[name])


def _space_metadata_without_removed_legacy() -> MetaData:
    source = SpaceBase.metadata
    filtered = MetaData(naming_convention=source.naming_convention)
    for table in source.tables.values():
        if table.name not in REMOVED_LEGACY_SPACE_TABLES:
            _copy_table_without_columns(
                table,
                filtered,
                REMOVED_LEGACY_SPACE_COLUMNS.get(table.name, frozenset()),
            )
    return filtered


def get_meta_metadata() -> MetaData:
    from app.db.models import meta  # noqa: F401

    return MetaBase.metadata


def get_space_metadata() -> MetaData:
    import app.models  # noqa: F401

    return _space_metadata_without_removed_legacy()


def get_legacy_space_metadata() -> MetaData:
    """Return pre-TS0 metadata for exact legacy adoption fingerprints."""
    import app.models  # noqa: F401

    source = SpaceBase.metadata
    legacy = MetaData(naming_convention=source.naming_convention)
    for table in source.tables.values():
        if table.name not in FINAL_TASK_SPACE_TABLES:
            copied = table.to_metadata(legacy)
            _restore_legacy_columns(copied, legacy)
    return legacy
