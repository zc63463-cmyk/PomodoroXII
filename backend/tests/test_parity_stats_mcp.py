"""Parity gate: REST /stats endpoints vs MCP stats tools.

Uses STAT_SPECS as the single source of truth while deriving the actual
REST paths and MCP tool names from the live router / server modules.
Adding a new stats dimension only requires appending a StatSpec in
app/services/stats_spec.py; this test will automatically verify both
REST and MCP coverage.
"""
from __future__ import annotations

from app.services.stats_spec import STAT_SPECS
from tests.parity_helpers import (
    get_actual_stats_mcp_tools,
    get_stats_rest_paths,
    is_mcp_available,
    skip_if_mcp_unavailable,
)


def test_mcp_has_all_stats_tools_and_no_extras():
    """MCP server tools match STAT_SPECS exactly (mcp_enabled=True).

    Bidirectional check: neither missing tools nor unexpected extra stats
    tools are allowed.
    """
    skip_if_mcp_unavailable()

    actual_tools = get_actual_stats_mcp_tools()
    expected_tools = {spec.mcp_tool for spec in STAT_SPECS if spec.mcp_enabled}

    missing = expected_tools - actual_tools
    assert not missing, f"MCP missing stats tools: {missing}"

    extra = actual_tools - expected_tools
    assert not extra, f"MCP has extra stats tools not in STAT_SPECS: {extra}"


def test_stat_specs_covers_all_rest_endpoints():
    """STAT_SPECS matches the actual REST /stats router paths bidirectionally.

    Prevents drift where a REST endpoint is added without updating
    STAT_SPECS (and therefore MCP).
    """
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


def test_daily_detail_mcp_tool_exists():
    """daily_detail must have a corresponding MCP tool (regression guard).

    REST /stats/daily-detail previously existed without an MCP equivalent.
    This test ensures the drift does not recur.
    """
    skip_if_mcp_unavailable()

    import app.mcp.server as mcp_module

    assert hasattr(mcp_module, "get_daily_detail"), (
        "MCP server missing get_daily_detail tool "
        "(REST /daily-detail has no MCP equivalent)"
    )


def test_mcp_tools_consistent_with_registration():
    """Extra sanity: every StatsService-using function in the MCP module
    that is also registered as a tool must be in STAT_SPECS.

    This guards against regressions where a stats tool is renamed in code
    but STAT_SPECS is not updated, even if list_tools + source filter
    would otherwise mask the rename.
    """
    if not is_mcp_available():
        import pytest

        pytest.skip("MCP server not available")
    actual = get_actual_stats_mcp_tools()
    expected = {spec.mcp_tool for spec in STAT_SPECS if spec.mcp_enabled}
    # Same assertion as test_mcp_has_all_stats_tools_and_no_extras but
    # kept as a separate test so a regression points at the rename case.
    assert actual == expected, (
        f"MCP registered stats tools drift from STAT_SPECS: "
        f"missing={expected - actual}, extra={actual - expected}"
    )
