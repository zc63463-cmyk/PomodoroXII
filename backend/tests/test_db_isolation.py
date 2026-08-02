"""P0-1: DB isolation tests — meta DB and space DB must not share tables.

Verifies that:
1. Meta DB contains only its four application-wide tables.
2. Space DB excludes meta tables (``spaces``, ``meta_settings`` absent).
3. Space DB contains all 33 business/infra/setting tables.
"""

import pytest


@pytest.mark.asyncio
async def test_meta_db_has_only_meta_tables(_isolate_env):
    """Meta DB should contain only application-wide Meta tables."""
    from sqlalchemy import inspect

    from app.db.meta_session import init_meta_db

    engine = await init_meta_db()
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )
    business = set(tables) - {"alembic_version_meta"}
    assert business == {
        "spaces", "meta_settings", "active_session_locator",
        "active_session_operations",
    }


@pytest.mark.asyncio
async def test_space_db_excludes_meta_tables(_isolate_env, space_session):
    """Space DB should not contain spaces or meta_settings tables."""
    from sqlalchemy import inspect

    engine = space_session.bind
    assert engine is not None
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )
    assert "spaces" not in tables, "Space DB should not contain 'spaces' table"
    assert "meta_settings" not in tables, (
        "Space DB should not contain 'meta_settings' table"
    )


@pytest.mark.asyncio
async def test_space_db_has_all_business_tables(_isolate_env, space_session):
    """Space DB should contain all legacy, Task Space, and infra tables."""
    from sqlalchemy import inspect

    engine = space_session.bind
    assert engine is not None
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )

    expected_business_tables = {
        # Legacy business entities (10)
        "notes", "folders", "quick_notes", "reflections",
        "habits", "habit_check_ins", "schedules", "time_blocks",
        "memo_comments", "schedule_quick_notes",
        # Task Space and FocusSession entities (12)
        "projects", "status_definitions", "type_definitions", "labels",
        "work_item_labels", "work_items", "work_item_notes",
        "focus_sessions", "session_task_contexts",
        "session_attribution_revisions", "session_work_item_plans",
        "session_work_item_outcomes",
        # Sync infrastructure (7)
        "tombstones", "sync_outbox", "sync_audit_log",
        "sync_state", "sync_snapshots",
        "session_command_envelopes", "session_command_receipts",
        # Setting (1)
        "settings",
        # Mutation journal (3)
        "mutation_batches", "mutation_operations", "mutation_steps",
    }
    actual_business = set(tables) - {"spaces", "meta_settings", "alembic_version_space", "alembic_version_meta"}
    missing = expected_business_tables - actual_business
    assert not missing, f"Space DB missing business tables: {missing}"
    assert len(actual_business) == 33, (
        f"Space DB has {len(actual_business)} business tables, expected 33: "
        f"extra={actual_business - expected_business_tables}"
    )
