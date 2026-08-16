"""MCP Server for PomodoroXII — exposes tools, resources, and prompts to LLM agents.

Architecture:
  - All Service classes are MCP-ready (no FastAPI dependency, dict params).
  - This module wraps them as MCP tools using FastMCP decorators.
  - DB sessions are obtained via a context manager that bypasses FastAPI's
    dependency injection (MCP clients don't go through HTTP routes).

Transports:
  - stdio (default selection, requires --trusted-stdio): local CLI integration
  - http: for remote/web integration at /mcp endpoint

Usage:
  # Explicitly trusted stdio (for Claude Desktop, Cursor, etc.)
  python -m app.mcp.server --transport stdio --trusted-stdio

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

from fastmcp import FastMCP
from fastmcp.server.auth import AccessToken, TokenVerifier
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal
from app.errors import AppError, AuthorizationError
from app.mcp.auth import (
    canonical_mcp_errors,
    current_mcp_principal,
    trusted_stdio_context,
)
from app.mcp.sync_tools import (
    McpSyncProtocolFactory,
    register_sync_tools,
)
from app.runtime.bootstrap import RuntimeServices
from app.runtime.scope import AccessMode
from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# DB session bridge — bypasses FastAPI deps, directly uses engine manager
# --------------------------------------------------------------------------- #

_installed_space_runtime: SpaceRuntime | None = None
_installed_runtime_services: RuntimeServices | None = None


def install_space_runtime(runtime: SpaceRuntime | None) -> None:
    """Install the runtime supplied by shared bootstrap or explicit tests."""
    global _installed_space_runtime
    _installed_space_runtime = runtime


def install_mcp_runtime_services(services: RuntimeServices | None) -> None:
    global _installed_runtime_services
    _installed_runtime_services = services
    global _installed_space_runtime
    _installed_space_runtime = None if services is None else services.runtime


def _require_runtime_services() -> RuntimeServices:
    if _installed_runtime_services is None:
        raise RuntimeError("MCP RuntimeServices are not installed")
    return _installed_runtime_services


def _require_space_runtime() -> SpaceRuntime:
    if _installed_space_runtime is None:
        raise RuntimeError("SpaceRuntime is not installed")
    return _installed_space_runtime


@asynccontextmanager
async def get_space_session(handle: SpaceRuntimeHandle) -> AsyncIterator[AsyncSession]:
    """Yield a session from one already-authorized runtime handle.

    This is the MCP equivalent of the ``get_space_db`` FastAPI dependency.
    The handle owns the engine/filesystem lifetime and closes in this same Task.
    """
    session = handle.session_factory()
    try:
        yield session
    finally:
        await session.close()
        await handle.aclose()


async def _authorize_space(space_id: str, mode: AccessMode) -> SpaceRuntimeHandle:
    principal = current_mcp_principal()
    return await _require_runtime_services().scope.open(
        principal, space_id, mode
    )


def _require_master_principal() -> Principal:
    principal = current_mcp_principal()
    if principal.token_type not in {"master", "trusted_stdio"}:
        raise AuthorizationError("Master token required")
    return principal


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


class _InstalledRuntimeTokenVerifier(TokenVerifier):
    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            principal = await _require_runtime_services().credential_verifier(
                token, None
            )
        except AppError:
            return None
        scopes = (
            ["master"]
            if principal.token_type == "master"
            else [f"space:{principal.space_id}"]
        )
        return AccessToken(
            token=token,
            client_id=principal.subject,
            subject=principal.subject,
            scopes=scopes,
            expires_at=principal.expires_at,
            claims={
                "sub": principal.subject,
                "type": principal.token_type,
                "space_id": principal.space_id,
                "epoch": principal.epoch,
            },
        )

mcp = FastMCP(
    "PomodoroXII",
    instructions=(
        "PomodoroXII is a pomodoro timer app with multi-space sync. "
        "Use list_spaces to discover available spaces, then pass space_id "
        "to other tools. Stats tools return aggregate analytics. "
        "Meta tools expose the entity schema registry. "
        "Sync tools expose push/pull/status for cross-device synchronization."
    ),
    auth=_InstalledRuntimeTokenVerifier(),
)
register_sync_tools(mcp, McpSyncProtocolFactory(_require_runtime_services))


# --------------------------------------------------------------------------- #
# Tools — Space discovery
# --------------------------------------------------------------------------- #

@mcp.tool
@canonical_mcp_errors
async def list_all_spaces() -> list[dict[str, Any]]:
    """List all registered spaces (workspaces).

    Returns a list of {id, name, created_at} dicts. Use the id as the
    space_id parameter for other tools.
    """
    _require_master_principal()
    return await list_spaces()


# --------------------------------------------------------------------------- #
# Tools — Statistics
# --------------------------------------------------------------------------- #

@mcp.tool
@canonical_mcp_errors
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

    scope = await _authorize_space(space_id, "read")
    async with get_space_session(scope) as db:
        return await StatsService(db).habit_summary(days=days)


@mcp.tool
@canonical_mcp_errors
async def get_schedule_summary(space_id: str, days: int = 30) -> dict:
    """Get schedule completion statistics: completed, pending, overdue.

    Args:
        space_id: The space to query.
        days: Period in days (1-365, default 30).

    Returns:
        Dict with total, completed, pending, overdue, completion_rate.
    """
    from app.services.stats import StatsService

    scope = await _authorize_space(space_id, "read")
    async with get_space_session(scope) as db:
        return await StatsService(db).schedule_summary(days=days)


@mcp.tool
@canonical_mcp_errors
async def get_note_summary(space_id: str) -> dict:
    """Get note and folder counts (active + trashed).

    Args:
        space_id: The space to query.

    Returns:
        Dict with notes, folders, trashed_notes, trashed_folders counts.
    """
    from app.services.stats import StatsService

    scope = await _authorize_space(space_id, "read")
    async with get_space_session(scope) as db:
        return await StatsService(db).note_summary()


# --------------------------------------------------------------------------- #
# Tools — Entity metadata (Registry)
# --------------------------------------------------------------------------- #

@mcp.tool
@canonical_mcp_errors
async def get_registry_health() -> dict:
    """Get the entity registry health status.

    Returns:
        Dict with registry_loaded, entity_count, and per-category counts.
    """
    from app.services.meta import MetaService

    _require_master_principal()
    return MetaService().health()


@mcp.tool
@canonical_mcp_errors
async def list_entities(category: str | None = None) -> dict:
    """List all registered entity types with their metadata.

    Args:
        category: Optional filter: business, sync_infra, meta, setting.

    Returns:
        Dict with "entities" list and "total" count.
    """
    from app.services.meta import MetaService

    _require_master_principal()
    svc = MetaService()
    specs = svc.list_entities(category=category)
    return {
        "entities": [svc.serialize(s) for s in specs],
        "total": len(specs),
    }


@mcp.tool
@canonical_mcp_errors
async def get_entity_schema(entity_type: str) -> dict:
    """Get the field schema for a specific entity type.

    Args:
        entity_type: Entity name (e.g. "work_item", "focus_session", "note").

    Returns:
        Dict with entity_type, table_name, primary_key, and fields list.
    """
    from app.services.meta import MetaService

    _require_master_principal()
    return MetaService().get_schema(entity_type)


# --------------------------------------------------------------------------- #
# Resources — Entity schema (read-only data sources)
# --------------------------------------------------------------------------- #

@mcp.resource("pomodoro://registry/health")
@canonical_mcp_errors
async def registry_health_resource() -> dict:
    """Registry health as an MCP resource (read-only)."""
    return await get_registry_health()


@mcp.resource("pomodoro://registry/entities")
@canonical_mcp_errors
async def all_entities_resource() -> dict:
    """Full entity registry as an MCP resource."""
    return await list_entities()


@mcp.resource("pomodoro://registry/entities/{entity_type}")
@canonical_mcp_errors
async def entity_schema_resource(entity_type: str) -> dict:
    """Single entity schema as an MCP resource.

    Args:
        entity_type: Entity name (e.g. "work_item", "focus_session", "note").
    """
    return await get_entity_schema(entity_type)


@mcp.resource("pomodoro://spaces")
@canonical_mcp_errors
async def spaces_resource() -> list[dict]:
    """List all spaces as an MCP resource."""
    return await list_all_spaces()


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
        f"Call get_habit_summary for the last 14 days, "
        f"get_schedule_summary for the last 14 days, and get_note_summary. "
        f"Identify patterns, suggest improvements, and highlight concerning "
        f"changes such as broken habit streaks or overdue schedules."
    )


@mcp.prompt
def weekly_review(space_id: str) -> str:
    """Generate a prompt for a weekly review.

    Args:
        space_id: The space to review.
    """
    return (
        f"Create a weekly review for space '{space_id}'. "
        f"Call get_habit_summary with days=7, get_schedule_summary with days=7, "
        f"and get_note_summary. Summarize achievements, identify overdue "
        f"schedules and broken streaks, and suggest priorities for next week."
    )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PomodoroXII MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="Transport mechanism (default: stdio)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host")
    parser.add_argument("--port", type=int, default=9000, help="HTTP port")
    parser.add_argument(
        "--trusted-stdio",
        action="store_true",
        help="Explicitly trust this local stdio transport",
    )
    args = parser.parse_args()

    if args.transport == "stdio" and not args.trusted_stdio:
        parser.error("stdio transport requires --trusted-stdio")
    if args.transport == "http" and args.trusted_stdio:
        parser.error("--trusted-stdio is valid only with stdio transport")
    return args


async def run_mcp(args: argparse.Namespace) -> None:
    """Run the MCP server inside the shared runtime bootstrap."""
    from app.runtime.bootstrap import bootstrap_runtime

    async with bootstrap_runtime(f"mcp-{args.transport}") as services:
        install_mcp_runtime_services(services)
        try:
            services.executor.gate.assert_ready()
            services.runtime.assert_ready()
            if args.transport == "http":
                await mcp.run_async(
                    transport="http", host=args.host, port=args.port
                )
            else:
                with trusted_stdio_context():
                    await mcp.run_async(transport="stdio")
        finally:
            install_mcp_runtime_services(None)


def main() -> None:
    """Run the MCP server."""
    asyncio.run(run_mcp(parse_args()))


if __name__ == "__main__":
    main()
