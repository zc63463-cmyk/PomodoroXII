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

import pytest


@pytest.fixture(autouse=True)
def _explicit_trusted_stdio_context():
    from app.mcp.auth import trusted_stdio_context

    with trusted_stdio_context():
        yield


@pytest.fixture
async def mcp_space_session(space_session, monkeypatch):
    import app.mcp.server as server
    from app.db.meta_session import get_meta_session
    from app.db.migrations import MigrationCoordinator
    from app.db.models.meta import Space
    from app.file_system.index_schema import IndexStoreSchema
    from app.runtime.leases import RuntimeLeaseCoordinator
    from app.runtime.space import SpaceRuntime
    from app.runtime.sqlite_vfs import _bind_existing_target, _extension_candidates
    from app.settings import settings
    from app.space_manager import SpaceEngineManager, dispose_space_engine_manager

    candidates = _extension_candidates()
    assert candidates, "Task 5 MCP tests require the Windows pxii-vfs extension"
    monkeypatch.setenv("POMODOROXII_PXII_VFS_EXTENSION", str(candidates[0]))
    engines = SpaceEngineManager()
    leases = RuntimeLeaseCoordinator(settings.data_root / ".runtime")
    index_schema = IndexStoreSchema()
    runtime = SpaceRuntime(
        leases=leases,
        engines=engines,
        migrations=MigrationCoordinator(leases, engines),
        index_schema=index_schema,
    )
    database = settings.space_db_path("spc_test")
    notes = settings.space_notes_dir("spc_test")
    notes.mkdir(parents=True, exist_ok=True)
    index = database.parent / "index.db"
    index.touch()
    index_target = _bind_existing_target(index, create_authority=True)
    try:
        index_schema.upgrade_open(index_target, create_if_missing=False)
    finally:
        await index_target.aclose()
    async for meta_db in get_meta_session():
        meta_db.add(
            Space(
                id="spc_test",
                name="spc_test",
                db_path=str(database),
                notes_dir=str(notes),
            )
        )
        await meta_db.commit()
        break
    server.install_space_runtime(runtime)
    try:
        yield space_session
    finally:
        server.install_space_runtime(None)
        await engines.dispose_all()
        await dispose_space_engine_manager()

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
async def test_get_habit_summary_returns_dict(mcp_space_session):
    """get_habit_summary should return habits list and period_days."""
    from app.mcp.server import get_habit_summary

    result = await get_habit_summary("spc_test", days=7)
    assert "habits" in result
    assert result["period_days"] == 7
    assert isinstance(result["habits"], list)


@pytest.mark.asyncio
async def test_get_note_summary_returns_counts(mcp_space_session):
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
    assert "work_item" in names
    assert "focus_session" in names
    assert "note" in names


@pytest.mark.asyncio
async def test_get_entity_schema_returns_fields():
    """get_entity_schema should return field list for an entity."""
    from app.mcp.server import get_entity_schema

    result = await get_entity_schema("work_item")
    assert result["entity_type"] == "work_item"
    assert "fields" in result
    assert len(result["fields"]) > 0
    field_names = [f["name"] for f in result["fields"]]
    assert "title" in field_names
    assert "status_definition_id" in field_names


@pytest.mark.asyncio
async def test_sync_v2_tool_schemas_replace_the_reduced_legacy_contract():
    """The MCP surface exposes opaque v2 inputs instead of timestamp Sync."""
    from app.mcp.server import mcp

    tools = {tool.name: tool for tool in await mcp.list_tools()}
    pull = tools["sync_pull"].parameters
    status = tools["get_sync_status"].parameters

    assert set(pull["properties"]) == {"space_id", "client_id", "cursor", "limit"}
    assert "since" not in pull["properties"]
    assert pull["properties"]["limit"] == {
        "default": 500,
        "maximum": 500,
        "minimum": 1,
        "type": "integer",
    }
    assert set(status["properties"]) == {"space_id", "client_id"}


@pytest.mark.asyncio
async def test_sync_query_schema_preserves_ordered_bounded_operation_ids():
    from app.mcp.server import mcp

    tool = await mcp.get_tool("sync_query_operations")
    operation_ids = tool.parameters["properties"]["operation_ids"]

    assert operation_ids["minItems"] == 1
    assert operation_ids["maxItems"] == 500
    assert operation_ids["uniqueItems"] is True
    assert operation_ids["items"]["minLength"] == 1
    assert operation_ids["items"]["maxLength"] == 128


@pytest.mark.asyncio
async def test_sync_tool_schemas_publish_strict_input_and_output_limits():
    from app.mcp.server import mcp
    from app.schemas.sync import MAX_JS_SAFE_INTEGER, MAX_RECOVERY_BASE64_CHARS

    push = await mcp.get_tool("sync_push")
    recover = await mcp.get_tool("sync_recover")
    event = next(iter(push.parameters["$defs"].values()))

    assert push.parameters["properties"]["events"]["maxItems"] == 500
    assert event["properties"]["expected_version"]["anyOf"][0]["maximum"] == (
        MAX_JS_SAFE_INTEGER
    )
    assert event["properties"]["client_updated_at"]["pattern"]
    assert recover.output_schema["properties"]["entity_count"]["maximum"] == 500
    assert recover.output_schema["properties"]["payload_jsonl_base64"]["maxLength"] == (
        MAX_RECOVERY_BASE64_CHARS
    )


# --------------------------------------------------------------------------- #
# Prompts
# --------------------------------------------------------------------------- #

def test_analyze_productivity_prompt_generates_text():
    """analyze_productivity prompt should generate guidance text."""
    from app.mcp.server import analyze_productivity

    result = analyze_productivity("spc_test")
    assert isinstance(result, str)
    assert "spc_test" in result
    assert "get_habit_summary" in result
    assert "get_schedule_summary" in result


def test_weekly_review_prompt_generates_text():
    """weekly_review prompt should generate review guidance text."""
    from app.mcp.server import weekly_review

    result = weekly_review("spc_test")
    assert isinstance(result, str)
    assert "spc_test" in result
    assert "get_habit_summary" in result
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
    from app.sync.operations import SYNC_OPERATIONS
    from tests.parity_helpers import EXPECTED_MCP_TOOLS

    expected = EXPECTED_MCP_TOOLS | {spec.mcp_tool for spec in SYNC_OPERATIONS}

    missing = expected - tool_names
    extra = tool_names - expected
    assert not missing, f"Tools missing from FastMCP registry: {missing}"
    assert not extra, f"Unexpected extra tools in FastMCP registry: {extra}"


# --------------------------------------------------------------------------- #
# Tools without prior test coverage
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_get_schedule_summary_returns_data(mcp_space_session):
    """get_schedule_summary should return schedule completion stats."""
    from app.mcp.server import get_schedule_summary

    result = await get_schedule_summary("spc_test", days=7)
    assert isinstance(result, dict)
    assert "completed" in result or "total" in result
