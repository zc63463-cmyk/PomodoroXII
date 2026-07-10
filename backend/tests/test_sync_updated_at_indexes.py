"""Tests for D-1: SyncMixin.updated_at index on all 14 sync entities.

Without these indexes, ``SyncService.pull`` would full-scan all 14 tables
on every incremental sync request (WHERE updated_at > since).

The indexes are auto-created by SQLAlchemy when ``index=True`` is set on the
column declaration (see ``app.models.mixins.SyncMixin.updated_at``). This
test verifies that every sync entity table has the expected index.
"""
from __future__ import annotations

import pytest
from sqlalchemy import text

# All 14 sync entities (table_name, expected_index_name).
SYNC_ENTITY_TABLES = [
    ("tasks", "ix_tasks_updated_at"),
    ("sessions", "ix_sessions_updated_at"),
    ("notes", "ix_notes_updated_at"),
    ("folders", "ix_folders_updated_at"),
    ("quick_notes", "ix_quick_notes_updated_at"),
    ("reflections", "ix_reflections_updated_at"),
    ("habits", "ix_habits_updated_at"),
    ("habit_check_ins", "ix_habit_check_ins_updated_at"),
    ("schedules", "ix_schedules_updated_at"),
    ("time_blocks", "ix_time_blocks_updated_at"),
    ("memo_comments", "ix_memo_comments_updated_at"),
    ("session_quick_notes", "ix_session_quick_notes_updated_at"),
    ("schedule_quick_notes", "ix_schedule_quick_notes_updated_at"),
    ("task_quick_notes", "ix_task_quick_notes_updated_at"),
]


@pytest.mark.asyncio
async def test_all_sync_entities_have_updated_at_index(space_session):
    """Every sync entity table must have an index on updated_at.

    D-1: SyncMixin.updated_at was updated to ``index=True`` so that
    sync pull queries (WHERE updated_at > since) use an index lookup
    instead of a full table scan.
    """
    # SQLite does not accept a tuple bound to "IN ?", so we build an
    # IN-list of placeholders dynamically and pass scalars.
    table_names = [t for t, _ in SYNC_ENTITY_TABLES]
    placeholders = ", ".join(f":t{i}" for i in range(len(table_names)))
    params = {f"t{i}": t for i, t in enumerate(table_names)}
    sql = text(
        "SELECT name, tbl_name FROM sqlite_master "
        f"WHERE type='index' AND tbl_name IN ({placeholders})"
    )
    result = await space_session.execute(sql, params)
    # Build a map of table_name -> set of index names.
    indexes_by_table: dict[str, set[str]] = {t: set() for t in table_names}
    for row in result.all():
        idx_name, tbl_name = row[0], row[1]
        if tbl_name in indexes_by_table:
            indexes_by_table[tbl_name].add(idx_name)

    missing: list[str] = []
    for table_name, expected_index in SYNC_ENTITY_TABLES:
        if expected_index not in indexes_by_table[table_name]:
            missing.append(
                f"{table_name}: expected '{expected_index}', "
                f"have {sorted(indexes_by_table[table_name])}"
            )
    assert not missing, (
        f"Missing updated_at indexes on {len(missing)} tables:\n"
        + "\n".join(missing)
    )


@pytest.mark.asyncio
async def test_sync_pull_uses_index_for_updated_at_filter(space_session):
    """EXPLAIN QUERY PLAN on a sync-pull-style query should reference the index.

    This is a lightweight regression guard: if someone removes ``index=True``
    from SyncMixin.updated_at, the EXPLAIN output will switch from
    ``SEARCH ... USING INDEX`` to ``SCAN``.
    """

    # Build the same shape of query that SyncService.pull uses.
    q = (
        text(
            "EXPLAIN QUERY PLAN "
            "SELECT * FROM tasks WHERE updated_at > :since "
            "ORDER BY updated_at ASC LIMIT 1001"
        )
    )
    result = await space_session.execute(q, {"since": "2026-01-01T00:00:00Z"})
    plan_lines = [row[3] if len(row) >= 4 else row[0] for row in result.all()]
    plan_text = "\n".join(plan_lines)

    # The query plan should mention either the index name or "USING INDEX".
    # On SQLite the auto-index from index=True will be named ix_<table>_<col>.
    assert "ix_tasks_updated_at" in plan_text or "USING INDEX" in plan_text.upper(), (
        f"Expected query plan to use ix_tasks_updated_at index, got:\n{plan_text}"
    )
    # Make sure we are not doing a full SCAN on tasks.
    assert "SCAN" not in plan_text.upper(), (
        f"Query plan falls back to full SCAN:\n{plan_text}"
    )
