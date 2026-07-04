"""MCP Server for PomodoroXII — exposes tools, resources, and prompts to LLM agents.

Architecture:
  - All Service classes are MCP-ready (no FastAPI dependency, dict params).
  - This module wraps them as MCP tools using FastMCP decorators.
  - DB sessions are obtained via a context manager that bypasses FastAPI's
    dependency injection (MCP clients don't go through HTTP routes).

Transports:
  - stdio (default): for local CLI agent integration
  - http: for remote/web integration at /mcp endpoint

Usage:
  # stdio (for Claude Desktop, Cursor, etc.)
  python -m app.mcp.server

  # HTTP (for web clients)
  python -m app.mcp.server --transport http --port 9000

  # Or mount into existing FastAPI app (see main.py)
"""
from __future__ import annotations

import argparse
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastmcp import FastMCP, Context
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.meta_session import init_meta_db, close_meta_db
from app.space_manager import get_space_engine_manager, dispose_space_engine_manager
from sqlalchemy import select

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# DB session bridge — bypasses FastAPI deps, directly uses engine manager
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def get_space_session(space_id: str) -> AsyncIterator[AsyncSession]:
    """Yield an AsyncSession for the given space, closing it after use.

    This is the MCP equivalent of the ``get_space_db`` FastAPI dependency.
    It ensures the space engine is initialized and creates a session
    directly from the SpaceEngineManager.
    """
    manager = get_space_engine_manager()
    session = await manager.get_session(space_id)
    try:
        yield session
    finally:
        await session.close()


async def list_spaces() -> list[dict[str, Any]]:
    """Return all registered spaces from the meta DB."""
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space as SpaceModel

    result: list[dict[str, Any]] = []
    async for session in get_meta_session():
        rows = (await session.execute(select(SpaceModel))).scalars().all()
        for s in rows:
            result.append({
                "id": s.id,
                "name": s.name,
                "created_at": s.created_at,
            })
        break
    return result


# --------------------------------------------------------------------------- #
# MCP Server instance
# --------------------------------------------------------------------------- #

mcp = FastMCP(
    "PomodoroXII",
    instructions=(
        "PomodoroXII is a pomodoro timer app with multi-space sync. "
        "Use list_spaces to discover available spaces, then pass space_id "
        "to other tools. Stats tools return aggregate analytics. "
        "Meta tools expose the entity schema registry. "
        "Sync tools expose push/pull/status for cross-device synchronization."
    ),
)


# --------------------------------------------------------------------------- #
# Tools — Space discovery
# --------------------------------------------------------------------------- #

@mcp.tool
async def list_all_spaces() -> list[dict[str, Any]]:
    """List all registered spaces (workspaces).

    Returns a list of {id, name, created_at} dicts. Use the id as the
    space_id parameter for other tools.
    """
    return await list_spaces()


# --------------------------------------------------------------------------- #
# Tools — Statistics
# --------------------------------------------------------------------------- #

@mcp.tool
async def get_stats_overview(
    space_id: str,
    periods: list[str] | None = None,
) -> dict:
    """Get pomodoro session counts and durations by time period.

    Args:
        space_id: The space to query (from list_all_spaces).
        periods: Optional list of periods: today, week, month, total.
                 Defaults to all four.

    Returns:
        Dict mapping period names to {count, duration}.
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).overview(periods=periods)


@mcp.tool
async def get_focus_trend(space_id: str, days: int = 7) -> dict:
    """Get daily focus trend (pomodoro count + duration) for last N days.

    Args:
        space_id: The space to query.
        days: Number of days to trend (1-365, default 7).

    Returns:
        Dict with "data" list of {date, count, duration} entries.
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).focus_trend(days=days)


@mcp.tool
async def get_task_distribution(space_id: str) -> dict:
    """Get task distribution grouped by status and priority.

    Args:
        space_id: The space to query.

    Returns:
        Dict with "by_status" and "by_priority" mappings.
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).task_distribution()


@mcp.tool
async def get_daily_detail(space_id: str, date: str) -> dict:
    """Get session count and total duration for a specific date.

    Args:
        space_id: The space to query.
        date: Date in YYYY-MM-DD format.

    Returns:
        Dict with date, count, and duration for completed work sessions.
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).daily_detail(date=date)


@mcp.tool
async def get_habit_summary(space_id: str, days: int = 30) -> dict:
    """Get habit check-in statistics: streaks, completion rates.

    Args:
        space_id: The space to query.
        days: Period in days (1-365, default 30).

    Returns:
        Dict with "habits" list (each has total_check_ins, check_in_days,
        current_streak, completion_rate) and "period_days".
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).habit_summary(days=days)


@mcp.tool
async def get_schedule_summary(space_id: str, days: int = 30) -> dict:
    """Get schedule completion statistics: completed, pending, overdue.

    Args:
        space_id: The space to query.
        days: Period in days (1-365, default 30).

    Returns:
        Dict with total, completed, pending, overdue, completion_rate.
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).schedule_summary(days=days)


@mcp.tool
async def get_note_summary(space_id: str) -> dict:
    """Get note and folder counts (active + trashed).

    Args:
        space_id: The space to query.

    Returns:
        Dict with notes, folders, trashed_notes, trashed_folders counts.
    """
    from app.services.stats import StatsService

    async with get_space_session(space_id) as db:
        return await StatsService(db).note_summary()


# --------------------------------------------------------------------------- #
# Tools — Entity metadata (Registry)
# --------------------------------------------------------------------------- #

@mcp.tool
async def get_registry_health() -> dict:
    """Get the entity registry health status.

    Returns:
        Dict with registry_loaded, entity_count, and per-category counts.
    """
    from app.services.meta import MetaService

    return MetaService().health()


@mcp.tool
async def list_entities(category: str | None = None) -> dict:
    """List all registered entity types with their metadata.

    Args:
        category: Optional filter: business, sync_infra, meta, setting.

    Returns:
        Dict with "entities" list and "total" count.
    """
    from app.services.meta import MetaService

    svc = MetaService()
    specs = svc.list_entities(category=category)
    return {
        "entities": [svc.serialize(s) for s in specs],
        "total": len(specs),
    }


@mcp.tool
async def get_entity_schema(entity_type: str) -> dict:
    """Get the field schema for a specific entity type.

    Args:
        entity_type: Entity name (e.g. "task", "session", "note", "habit").

    Returns:
        Dict with entity_type, table_name, primary_key, and fields list.
    """
    from app.services.meta import MetaService

    return MetaService().get_schema(entity_type)


# --------------------------------------------------------------------------- #
# Tools — Sync
# --------------------------------------------------------------------------- #

@mcp.tool
async def get_sync_status(space_id: str) -> dict:
    """Get sync status: per-entity row counts + tombstone count.

    Args:
        space_id: The space to query.

    Returns:
        Dict with server_time, entity_counts (per entity type), and
        tombstone_count.
    """
    from app.services.sync import SyncService

    async with get_space_session(space_id) as db:
        return await SyncService(db).status()


@mcp.tool
async def sync_pull(
    space_id: str,
    since: str = "",
    limit: int = 1000,
) -> dict:
    """Pull changes from the server since a given timestamp.

    Args:
        space_id: The space to sync from.
        since: ISO timestamp; only entities updated after this are returned.
               Empty string = full pull.
        limit: Max entities per type (default 1000).

    Returns:
        Dict with all entity lists, tombstones, next_since, has_more.
    """
    from app.services.sync import SyncService

    async with get_space_session(space_id) as db:
        return await SyncService(db).pull(since=since, limit=limit)


# --------------------------------------------------------------------------- #
# Resources — Entity schema (read-only data sources)
# --------------------------------------------------------------------------- #

@mcp.resource("pomodoro://registry/health")
async def registry_health_resource() -> dict:
    """Registry health as an MCP resource (read-only)."""
    from app.services.meta import MetaService

    return MetaService().health()


@mcp.resource("pomodoro://registry/entities")
async def all_entities_resource() -> dict:
    """Full entity registry as an MCP resource."""
    from app.services.meta import MetaService

    svc = MetaService()
    specs = svc.list_entities()
    return {
        "entities": [svc.serialize(s) for s in specs],
        "total": len(specs),
    }


@mcp.resource("pomodoro://registry/entities/{entity_type}")
async def entity_schema_resource(entity_type: str) -> dict:
    """Single entity schema as an MCP resource.

    Args:
        entity_type: Entity name (e.g. "task", "session", "note").
    """
    from app.services.meta import MetaService

    return MetaService().get_schema(entity_type)


@mcp.resource("pomodoro://spaces")
async def spaces_resource() -> list[dict]:
    """List all spaces as an MCP resource."""
    return await list_spaces()


# --------------------------------------------------------------------------- #
# Prompts — Reusable LLM interaction templates
# --------------------------------------------------------------------------- #

@mcp.prompt
def analyze_productivity(space_id: str) -> str:
    """Generate a prompt for analyzing productivity patterns.

    Args:
        space_id: The space to analyze.
    """
    return (
        f"Please analyze my productivity data from space '{space_id}'. "
        f"Start by calling get_stats_overview to see today/week/month totals, "
        f"then get_focus_trend for the last 14 days, and get_habit_summary "
        f"for habit streaks. Identify patterns, suggest improvements, and "
        f"highlight any concerning trends (e.g. declining focus time, "
        f"broken habit streaks)."
    )


@mcp.prompt
def weekly_review(space_id: str) -> str:
    """Generate a prompt for a weekly review.

    Args:
        space_id: The space to review.
    """
    return (
        f"Create a weekly review for space '{space_id}'. "
        f"Call get_stats_overview with periods=['week'] for the summary, "
        f"get_focus_trend with days=7 for the daily breakdown, "
        f"get_task_distribution for task progress, and "
        f"get_schedule_summary with days=7 for schedule completion. "
        f"Summarize achievements, identify unfinished work, and "
        f"suggest priorities for next week."
    )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main() -> None:
    """Run the MCP server."""
    parser = argparse.ArgumentParser(description="PomodoroXII MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="Transport mechanism (default: stdio)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host")
    parser.add_argument("--port", type=int, default=9000, help="HTTP port")
    args = parser.parse_args()

    # Initialize meta DB for stdio mode (HTTP mode uses lifespan).
    if args.transport == "stdio":
        asyncio.run(init_meta_db())

    try:
        if args.transport == "http":
            mcp.run(transport="http", host=args.host, port=args.port)
        else:
            mcp.run()
    finally:
        if args.transport == "stdio":
            asyncio.run(dispose_space_engine_manager())
            asyncio.run(close_meta_db())


if __name__ == "__main__":
    main()
