"""Query-index contract for the final WorkItem authority."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.models.work_item import WorkItem


@pytest.mark.asyncio
async def test_work_item_tree_and_project_indexes_exist(space_session) -> None:
    expected = {"ix_work_items_project_id", "ix_work_items_parent_id"}
    orm_indexes = {index.name for index in WorkItem.__table__.indexes}
    rows = await space_session.execute(
        text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_items'")
    )
    database_indexes = {row[0] for row in rows}

    assert expected <= orm_indexes
    assert expected <= database_indexes
