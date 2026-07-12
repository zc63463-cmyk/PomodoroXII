"""P0-1: DB isolation tests — meta DB and space DB must not share tables.

Verifies that:
1. Meta DB contains only ``spaces`` + ``meta_settings`` (2 tables).
2. Space DB excludes meta tables (``spaces``, ``meta_settings`` absent).
3. Space DB contains all 20 business tables.
"""

import pytest


@pytest.mark.asyncio
async def test_meta_db_has_only_2_tables(_isolate_env):
    """Meta DB should only contain spaces + meta_settings (+ its version table)."""
    from sqlalchemy import inspect

    from app.db.meta_session import init_meta_db

    engine = await init_meta_db()
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )
    business = set(tables) - {"alembic_version_meta"}
    assert business == {"spaces", "meta_settings"}, (
        f"Meta DB has extra tables: {business - {'spaces', 'meta_settings'}}"
    )


@pytest.mark.asyncio
async def test_space_db_excludes_meta_tables(_isolate_env):
    """Space DB should not contain spaces or meta_settings tables."""
    from sqlalchemy import inspect

    from app.db.meta_session import init_meta_db
    from app.space_manager import get_space_engine_manager

    await init_meta_db()
    manager = get_space_engine_manager()
    engine = await manager.get_engine("spc_test")
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )
    assert "spaces" not in tables, "Space DB should not contain 'spaces' table"
    assert "meta_settings" not in tables, (
        "Space DB should not contain 'meta_settings' table"
    )


@pytest.mark.asyncio
async def test_space_db_has_all_business_tables(_isolate_env):
    """Space DB should contain all 20 business tables."""
    from sqlalchemy import inspect

    from app.db.meta_session import init_meta_db
    from app.space_manager import get_space_engine_manager

    await init_meta_db()
    manager = get_space_engine_manager()
    engine = await manager.get_engine("spc_test")
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )

    expected_business_tables = {
        "tasks", "sessions", "notes", "folders", "quick_notes",
        "reflections", "habits", "habit_check_ins", "schedules",
        "time_blocks", "memo_comments", "session_quick_notes",
        "schedule_quick_notes", "task_quick_notes", "tombstones",
        "settings", "sync_outbox", "sync_audit_log",
        "sync_state", "sync_snapshots",
    }
    actual_business = set(tables) - {"spaces", "meta_settings", "alembic_version_space", "alembic_version_meta"}
    missing = expected_business_tables - actual_business
    assert not missing, f"Space DB missing business tables: {missing}"
    assert len(actual_business) == 20, (
        f"Space DB has {len(actual_business)} business tables, expected 20: "
        f"extra={actual_business - expected_business_tables}"
    )
