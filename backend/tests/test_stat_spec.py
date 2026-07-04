"""StatSpec registration + parity gate.

Ensures StatsService method names, REST routes, and MCP tool names stay in
sync through STAT_SPECS. Actual REST paths and MCP tools are derived from
the live router / server modules rather than hardcoded lists.
"""
from __future__ import annotations

from app.services.stats_spec import STAT_SPECS
from tests.parity_helpers import (
    get_actual_stats_mcp_tools,
    get_stats_rest_paths,
    skip_if_mcp_unavailable,
)


def test_stat_specs_covers_all_rest_endpoints():
    """STAT_SPECS must match the actual REST /stats router bidirectionally."""
    actual_paths = get_stats_rest_paths()
    expected_paths = {s.route_path for s in STAT_SPECS}

    missing_from_router = expected_paths - actual_paths
    assert not missing_from_router, (
        f"STAT_SPECS paths not implemented in REST router: {missing_from_router}"
    )

    missing_from_specs = actual_paths - expected_paths
    assert not missing_from_specs, (
        f"REST /stats paths missing from STAT_SPECS: {missing_from_specs}"
    )


def test_stat_specs_covers_all_mcp_tools():
    """STAT_SPECS must match actual MCP stats tools bidirectionally."""
    skip_if_mcp_unavailable()

    actual_tools = get_actual_stats_mcp_tools()
    expected_tools = {s.mcp_tool for s in STAT_SPECS if s.mcp_enabled}

    missing = expected_tools - actual_tools
    assert not missing, f"STAT_SPECS MCP tools missing from server: {missing}"

    extra = actual_tools - expected_tools
    assert not extra, f"MCP has extra stats tools not in STAT_SPECS: {extra}"


def test_stat_specs_route_and_mcp_names_consistent():
    """Every enabled spec must pair a route_path with an mcp_tool."""
    for spec in STAT_SPECS:
        if spec.mcp_enabled:
            assert spec.mcp_tool is not None, (
                f"{spec.name}: mcp_enabled=True but mcp_tool=None"
            )
