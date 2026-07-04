"""Shared helpers for parity tests (REST routes vs MCP tools).

These helpers are used by ``test_parity_routes.py``, ``test_parity_stats_mcp.py``
and ``test_stat_spec.py`` to avoid logic drift across copies.
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Any

import pytest

# FastMCP is only installed in the project's .venv; plain system python
# cannot import app.mcp.server.  We defer the import and let callers skip
# the MCP parity tests gracefully when *and only when* the missing module
# is fastmcp.  Any other import error must surface as a real failure.
_MCP_AVAILABLE = False
_MCP_SKIP_REASON = ""
_mcp_server_module = None
try:
    import app.mcp.server as _mcp_server_module

    _MCP_AVAILABLE = True
except ModuleNotFoundError as _mcp_import_exc:
    missing = _mcp_import_exc.name or ""
    if missing == "fastmcp" or "fastmcp" in missing:
        _MCP_AVAILABLE = False
        _MCP_SKIP_REASON = (
            f"MCP server import failed (fastmcp missing): {_mcp_import_exc}"
        )
    else:
        raise


def get_stats_rest_paths() -> set[str]:
    """Collect actual REST path suffixes under ``/api/v1/stats``.

    The stats router is mounted with ``prefix="/stats"`` inside the v1
    router, so its own route paths are ``/overview``, ``/focus-trend``,
    etc. We return them as-is.
    """
    from app.routes.v1.stats import router

    return {route.path for route in router.routes if hasattr(route, "path")}


def is_mcp_available() -> bool:
    """Return True if app.mcp.server can be imported (fastmcp installed)."""
    return _MCP_AVAILABLE


def skip_if_mcp_unavailable() -> None:
    """Skip the calling test if MCP server cannot be imported."""
    if not _MCP_AVAILABLE:
        pytest.skip(_MCP_SKIP_REASON)


def _get_mcp_server_instance() -> Any:
    """Return the FastMCP instance exported by app.mcp.server.

    Raises AssertionError if module was loaded without fastmcp.  Callers
    should call :func:`skip_if_mcp_unavailable` first.
    """
    if not _MCP_AVAILABLE:
        raise AssertionError("MCP server is not available; skip first")
    server = getattr(_mcp_server_module, "mcp", None)
    if server is None:
        raise AssertionError(
            "app.mcp.server module does not export a `mcp` FastMCP instance"
        )
    return server


def get_registered_mcp_tool_names() -> set[str]:
    """Return the names of every tool registered on the FastMCP server.

    Uses ``FastMCP.list_tools()`` (stable public API).  This is the
    authoritative source of truth: it only returns tools that were
    actually decorated with ``@mcp.tool`` and registered.
    """
    skip_if_mcp_unavailable()

    server = _get_mcp_server_instance()
    try:
        tools = asyncio.run(server.list_tools())
    except Exception as exc:
        # If the public API fails, surface the error instead of silently
        # degrading to the source-scan fallback.  We prefer to fail loud
        # so we notice FastMCP upgrades that break list_tools().
        pytest.fail(
            f"FastMCP.list_tools() failed; cannot determine registered tools: {exc}"
        )
    return {tool.name for tool in tools}


def get_actual_stats_mcp_tools() -> set[str]:
    """Return the names of MCP tools whose implementation uses StatsService.

    Combines two signals for robustness:

    1. Primary: ``FastMCP.list_tools()`` returns the authoritative set of
       registered tools.  If this call fails the helper fails loud via
       ``pytest.fail`` (no silent fallback).
    2. Filter: only keep tools whose underlying function source references
       ``StatsService``.  This avoids flagging unrelated tools (e.g.
       ``list_entities``) while still catching tools like
       ``get_focus_trend`` / ``get_daily_detail`` that do not follow the
       ``get_stats_*`` naming convention.
    """
    skip_if_mcp_unavailable()

    registered = get_registered_mcp_tool_names()
    stats_tools: set[str] = set()
    for name in registered:
        # The function registered as a tool may be stored under the same
        # name on the module, or FastMCP may wrap it.  We check the module
        # attribute first; if missing, we still trust the registration.
        obj = getattr(_mcp_server_module, name, None)
        if obj is None:
            # Registered tool without a same-named module attribute: trust
            # the registration but cannot verify StatsService usage.  Skip
            # to avoid false positives.
            continue
        try:
            source = inspect.getsource(obj)
        except (OSError, TypeError):
            continue
        if "StatsService" in source:
            stats_tools.add(name)
    return stats_tools
