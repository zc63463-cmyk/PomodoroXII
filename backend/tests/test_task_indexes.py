"""Tests for Task model indexes (P3.5: status/priority/due_date)."""
from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_task_indexes_exist(space_session):
    """Verify that tasks.status, priority, due_date have indexes.

    P3.5 adds index=True to these three columns to speed up filtered
    listings (e.g. GET /tasks?status=todo&priority=high).
    """
    result = await space_session.execute(
        text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
    )
    indexes = {row[0] for row in result.all()}

    # SQLAlchemy auto-generates index names as "ix_<table>_<column>".
    assert "ix_tasks_status" in indexes, (
        f"ix_tasks_status missing; have: {indexes}"
    )
    assert "ix_tasks_priority" in indexes, (
        f"ix_tasks_priority missing; have: {indexes}"
    )
    assert "ix_tasks_due_date" in indexes, (
        f"ix_tasks_due_date missing; have: {indexes}"
    )
