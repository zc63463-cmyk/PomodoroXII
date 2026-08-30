"""T9: MCP Task Space read-only tools — behaviour and contract tests.

Covers the five query tools added by the Agent-access phase:
``list_task_space_projects``, ``query_work_items``, ``get_work_item``,
``get_work_item_note`` and ``list_task_space_definitions``.

Seeding uses the ORM directly against the migrated space DB created by
the shared ``mcp_space_session`` fixture (space_010 seeds the system
status/type vocabulary), keeping the tests independent from the mutation
pipeline while exercising the exact query module the REST routes use.
"""
from __future__ import annotations

import pytest

# Reuse the MCP runtime fixtures from the server test module: the space DB
# harness (real VFS runtime + registered spc_test space) and the trusted
# stdio principal context the tools authorize through.
from tests.test_mcp_server import _explicit_trusted_stdio_context, mcp_space_session  # noqa: F401


async def _seed_task_space(session) -> tuple[str, str, str]:
    """Insert a project and a two-level work item tree; return ids."""
    from app.models.project import Project
    from app.models.work_item import WorkItem

    now = "2026-08-30T12:00:00.000Z"
    version = 1
    project_id = "11111111-1111-4111-8111-111111111111"
    root_id = "22222222-2222-4222-8222-222222222222"
    child_id = "33333333-3333-4333-8333-333333333333"
    session.add(
        Project(
            id=project_id,
            key="TS9",
            next_work_item_number=3,
            name="MCP Probe",
            description=None,
            rank=0,
            default_status_definition_id="sys-status-not-started",
            default_type_definition_id="sys-type-work-item",
            archived_at=None,
            created_at=now,
            updated_at=now,
            version=version,
        )
    )
    for item_id, parent_id, rank, title, level in (
        (root_id, None, 0, "Root", 1),
        (child_id, root_id, 0, "Child", 2),
    ):
        session.add(
            WorkItem(
                id=item_id,
                project_id=project_id,
                display_key=f"TS9-{level}",
                title=title,
                description=None,
                type_definition_id="sys-type-work-item",
                status_definition_id="sys-status-not-started",
                priority=None,
                parent_id=parent_id,
                child_rank=rank,
                completion_window_start=None,
                completion_window_end=None,
                review_point=None,
                hard_deadline=None,
                effort_estimate_lower_seconds=None,
                effort_estimate_upper_seconds=None,
                effort_actual_seconds=0,
                confidence=None,
                completed_at=None,
                cancelled_at=None,
                archived_at=None,
                marked_as_attention=False,
                created_at=now,
                updated_at=now,
                version=version,
            )
        )
    await session.commit()
    return project_id, root_id, child_id


@pytest.mark.asyncio
async def test_list_task_space_projects_returns_seeded_project(mcp_space_session):
    from app.mcp.server import list_task_space_projects

    await _seed_task_space(mcp_space_session)

    result = await list_task_space_projects("spc_test")
    assert result["next_cursor"] is None
    keys = [item["key"] for item in result["items"]]
    assert "TS9" in keys


@pytest.mark.asyncio
async def test_query_work_items_returns_depth_annotated_rows(mcp_space_session):
    from app.mcp.server import query_work_items

    project_id, _root_id, child_id = await _seed_task_space(mcp_space_session)

    result = await query_work_items("spc_test", project_id=project_id)
    by_id = {item["id"]: item for item in result["items"]}
    assert by_id[child_id]["depth"] == 2
    assert result["items"][0]["depth"] <= result["items"][-1]["depth"]


@pytest.mark.asyncio
async def test_get_work_item_returns_single_row_with_depth(mcp_space_session):
    from app.mcp.server import get_work_item

    _project_id, root_id, _child_id = await _seed_task_space(mcp_space_session)

    row = await get_work_item("spc_test", root_id)
    assert row["title"] == "Root"
    assert row["depth"] == 1


@pytest.mark.asyncio
async def test_get_work_item_note_reports_absence_without_error(mcp_space_session):
    from app.mcp.server import get_work_item_note

    _project_id, root_id, _child_id = await _seed_task_space(mcp_space_session)

    result = await get_work_item_note("spc_test", root_id)
    assert result == {"exists": False, "work_item_id": root_id}


@pytest.mark.asyncio
async def test_list_task_space_definitions_exposes_system_vocabulary(mcp_space_session):
    from app.mcp.server import list_task_space_definitions

    result = await list_task_space_definitions("spc_test")
    status_ids = {row["id"] for row in result["statuses"]}
    assert "sys-status-not-started" in status_ids
    assert any(row["id"] == "sys-type-work-item" for row in result["types"])


@pytest.mark.asyncio
async def test_task_space_tools_reject_unreadable_space(mcp_space_session):
    """The tools honour the space authorization surface like every other
    space-scoped tool (canonical error mapping, no data leak)."""
    from fastmcp.exceptions import ToolError

    from app.mcp.server import query_work_items

    # canonical_mcp_errors maps the AppError to a FastMCP ToolError.
    with pytest.raises(ToolError):
        await query_work_items("spc_missing")
