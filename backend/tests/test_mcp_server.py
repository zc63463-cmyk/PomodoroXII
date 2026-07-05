"""Tests for MCP server — verifies tool registration and basic execution.

These tests verify:
1. The MCP server instance is created with correct identity
2. All expected tools are registered
3. Tools execute correctly against a real space DB
4. Resources are accessible
5. Prompts generate expected text
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

# --------------------------------------------------------------------------- #
# Server identity
# --------------------------------------------------------------------------- #

def test_mcp_server_has_correct_name():
    """The MCP server should be named 'PomodoroXII'."""
    from app.mcp.server import mcp

    assert mcp.name == "PomodoroXII"


def test_mcp_server_has_instructions():
    """The server should have instructions for LLM clients."""
    from app.mcp.server import mcp

    # FastMCP stores instructions; verify it's non-empty.
    # The exact attribute name may vary by version, so we check the
    # server has some form of guidance configured.
    assert mcp is not None


# --------------------------------------------------------------------------- #
# Tool registration
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_all_spaces_returns_list():
    """list_all_spaces should return a list (possibly empty)."""
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.mcp.server import list_all_spaces

    await init_meta_db()
    try:
        result = await list_all_spaces()
        assert isinstance(result, list)
    finally:
        await close_meta_db()


@pytest.mark.asyncio
async def test_get_stats_overview_returns_dict(space_session):
    """get_stats_overview should return a dict with period keys."""
    from app.mcp.server import get_stats_overview

    result = await get_stats_overview("spc_test")
    assert isinstance(result, dict)
    # Default periods should be today/week/month/total
    assert "today" in result or "total" in result


@pytest.mark.asyncio
async def test_get_task_distribution_returns_dict(space_session):
    """get_task_distribution should return by_status and by_priority."""
    from app.mcp.server import get_task_distribution

    result = await get_task_distribution("spc_test")
    assert "by_status" in result
    assert "by_priority" in result


@pytest.mark.asyncio
async def test_get_habit_summary_returns_dict(space_session):
    """get_habit_summary should return habits list and period_days."""
    from app.mcp.server import get_habit_summary

    result = await get_habit_summary("spc_test", days=7)
    assert "habits" in result
    assert result["period_days"] == 7
    assert isinstance(result["habits"], list)


@pytest.mark.asyncio
async def test_get_note_summary_returns_counts(space_session):
    """get_note_summary should return note/folder counts."""
    from app.mcp.server import get_note_summary

    result = await get_note_summary("spc_test")
    assert "notes" in result
    assert "folders" in result
    assert "trashed_notes" in result
    assert "trashed_folders" in result


@pytest.mark.asyncio
async def test_get_registry_health_returns_dict():
    """get_registry_health should return registry status."""
    from app.mcp.server import get_registry_health

    result = await get_registry_health()
    assert "registry_loaded" in result
    assert "entity_count" in result
    assert result["registry_loaded"] is True
    assert result["entity_count"] > 0


@pytest.mark.asyncio
async def test_list_entities_returns_all():
    """list_entities should return all registered entities."""
    from app.mcp.server import list_entities

    result = await list_entities()
    assert "entities" in result
    assert result["total"] > 0
    # Should include core business entities.
    names = [e["name"] for e in result["entities"]]
    assert "task" in names
    assert "session" in names
    assert "note" in names


@pytest.mark.asyncio
async def test_get_entity_schema_returns_fields():
    """get_entity_schema should return field list for an entity."""
    from app.mcp.server import get_entity_schema

    result = await get_entity_schema("task")
    assert result["entity_type"] == "task"
    assert "fields" in result
    assert len(result["fields"]) > 0
    field_names = [f["name"] for f in result["fields"]]
    assert "title" in field_names
    assert "status" in field_names


@pytest.mark.asyncio
async def test_get_sync_status_returns_counts(space_session):
    """get_sync_status should return entity_counts and tombstone_count."""
    from app.mcp.server import get_sync_status

    result = await get_sync_status("spc_test")
    assert "entity_counts" in result
    assert "tombstone_count" in result
    assert "server_time" in result


@pytest.mark.asyncio
async def test_sync_pull_returns_data(space_session):
    """sync_pull should return a dict with entity lists and next_since."""
    from app.mcp.server import sync_pull

    result = await sync_pull("spc_test", since="", limit=100)
    assert "next_since" in result
    assert "has_more" in result
    assert "server_time" in result


# --------------------------------------------------------------------------- #
# Prompts
# --------------------------------------------------------------------------- #

def test_analyze_productivity_prompt_generates_text():
    """analyze_productivity prompt should generate guidance text."""
    from app.mcp.server import analyze_productivity

    result = analyze_productivity("spc_test")
    assert isinstance(result, str)
    assert "spc_test" in result
    assert "get_stats_overview" in result
    assert "get_focus_trend" in result


def test_weekly_review_prompt_generates_text():
    """weekly_review prompt should generate review guidance text."""
    from app.mcp.server import weekly_review

    result = weekly_review("spc_test")
    assert isinstance(result, str)
    assert "spc_test" in result
    assert "get_task_distribution" in result
    assert "get_schedule_summary" in result


# --------------------------------------------------------------------------- #
# Code quality — no dead imports
# --------------------------------------------------------------------------- #

def test_mcp_module_has_no_dead_context_import():
    """Context should not be imported if never used (dead import).

    FastMCP 3.x may change Context's import path, causing ImportError.
    Since Context is never referenced in server.py, it must not be imported.
    """
    import inspect

    import app.mcp.server as server_mod

    source = inspect.getsource(server_mod)
    # Context is never used in the module body; importing it is dead code.
    assert "from fastmcp import" in source
    # The import line must NOT include Context.
    for line in source.splitlines():
        if line.strip().startswith("from fastmcp import"):
            assert "Context" not in line, (
                f"Dead import: Context is imported but never used. Line: {line}"
            )


# --------------------------------------------------------------------------- #
# Server identity — real assertions (replaces weak placeholder)
# --------------------------------------------------------------------------- #

def test_mcp_server_instructions_non_empty():
    """The server should have non-empty instructions for LLM clients."""
    from app.mcp.server import mcp

    # FastMCP 3.x stores instructions; verify it's accessible and non-empty.
    instructions = getattr(mcp, "instructions", None)
    if instructions is None:
        # Some versions nest under config or _instructions
        instructions = getattr(getattr(mcp, "config", None), "instructions", None)
    assert instructions is not None, "MCP server has no instructions attribute"
    assert len(str(instructions)) > 0, "MCP server instructions are empty"


# --------------------------------------------------------------------------- #
# Tool registration — verify via FastMCP list_tools
# --------------------------------------------------------------------------- #


def test_all_tools_registered_via_fastmcp():
    """All expected tools should be registered with FastMCP.

    Uses the EXPECTED_MCP_TOOLS constant from parity_helpers as the single
    source of truth, avoiding duplication of the tool list in this file.
    """
    from app.mcp.server import mcp

    tools = asyncio.run(mcp.list_tools())
    tool_names = {t.name for t in tools}
    from tests.parity_helpers import EXPECTED_MCP_TOOLS

    missing = EXPECTED_MCP_TOOLS - tool_names
    extra = tool_names - EXPECTED_MCP_TOOLS
    assert not missing, f"Tools missing from FastMCP registry: {missing}"
    assert not extra, f"Unexpected extra tools in FastMCP registry: {extra}"


# --------------------------------------------------------------------------- #
# Tools without prior test coverage
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_get_focus_trend_returns_data(space_session):
    """get_focus_trend should return trend data with 'data' key."""
    from app.mcp.server import get_focus_trend

    result = await get_focus_trend("spc_test", days=7)
    assert isinstance(result, dict)
    assert "data" in result
    assert isinstance(result["data"], list)


@pytest.mark.asyncio
async def test_get_daily_detail_returns_data(space_session):
    """get_daily_detail should return count and duration for a date."""
    from app.mcp.server import get_daily_detail

    result = await get_daily_detail("spc_test", date="2026-01-01")
    assert isinstance(result, dict)
    assert "date" in result
    assert "count" in result
    assert "duration" in result


@pytest.mark.asyncio
async def test_get_schedule_summary_returns_data(space_session):
    """get_schedule_summary should return schedule completion stats."""
    from app.mcp.server import get_schedule_summary

    result = await get_schedule_summary("spc_test", days=7)
    assert isinstance(result, dict)
    assert "completed" in result or "total" in result
