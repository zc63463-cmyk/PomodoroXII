"""StatSpec 登记 + parity 增强。

确保 StatsService 方法名、REST 路由、MCP 工具名三处通过 STAT_SPECS 单一事实源同步。
"""
from __future__ import annotations

from app.services.stats_spec import STAT_SPECS


def test_stat_specs_covers_all_rest_endpoints():
    """STAT_SPECS 必须覆盖所有 REST /stats 端点。"""
    rest_paths = {s.route_path for s in STAT_SPECS}
    expected = {
        "/overview", "/focus-trend", "/task-distribution", "/daily-detail",
        "/habit-summary", "/schedule-summary", "/note-summary",
    }
    missing = expected - rest_paths
    assert not missing, f"STAT_SPECS missing REST paths: {missing}"


def test_stat_specs_covers_all_mcp_tools():
    """STAT_SPECS 必须覆盖所有 MCP stats 工具(或显式 mcp_enabled=False)。"""
    mcp_names = {s.mcp_tool for s in STAT_SPECS if s.mcp_enabled}
    expected = {
        "get_stats_overview", "get_focus_trend", "get_task_distribution",
        "get_daily_detail", "get_habit_summary", "get_schedule_summary",
        "get_note_summary",
    }
    missing = expected - mcp_names
    assert not missing, f"STAT_SPECS MCP missing: {missing}"


def test_stat_specs_route_and_mcp_names_consistent():
    """每个 spec 的 route_path 和 mcp_tool 必须配对。"""
    for spec in STAT_SPECS:
        if spec.mcp_enabled:
            assert spec.mcp_tool is not None, (
                f"{spec.name}: mcp_enabled=True but mcp_tool=None"
            )
