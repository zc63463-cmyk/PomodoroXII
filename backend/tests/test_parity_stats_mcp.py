"""Parity gate: REST /stats 端点 vs MCP stats 工具。

用 STAT_SPECS 作为单一事实源,确保每个 REST stats 端点有对应 MCP 工具(或显式豁免)。
新增统计维度时,只需在 app/services/stats_spec.py 追加 StatSpec,本测试自动校验。
"""
from __future__ import annotations

import inspect

from app.services.stats_spec import STAT_SPECS


def _get_mcp_tool_names() -> set[str]:
    """从 app.mcp.server 模块收集所有 @mcp.tool 装饰的函数名。

    FastMCP 2.x 的 @mcp.tool 装饰器不会改变函数的可调用性,函数名保持不变,
    可被 inspect.getmembers 发现。用 name 前缀(get_/list_/sync_)过滤,
    避开模块级的辅助函数(list_spaces / get_space_session 等)。
    """
    import app.mcp.server as mcp_module
    names: set[str] = set()
    for name, obj in inspect.getmembers(mcp_module):
        if callable(obj) and not name.startswith("_"):
            if name.startswith("get_") or name.startswith("list_") or name.startswith("sync_"):
                names.add(name)
    return names


def test_mcp_has_all_stats_tools():
    """MCP server 必须注册所有 STAT_SPECS 中 mcp_enabled=True 的工具。

    从 STAT_SPECS 派生期望集合,而非硬编码 EXPECTED_MAPPING,
    确保新增维度时 MCP 自动跟随。
    """
    tool_names = _get_mcp_tool_names()
    expected = {spec.mcp_tool for spec in STAT_SPECS if spec.mcp_enabled}
    missing = expected - tool_names
    assert not missing, f"MCP missing stats tools: {missing}"


def test_stat_specs_covers_all_rest_endpoints():
    """STAT_SPECS 必须覆盖所有 REST /stats 端点(反向校验)。

    防止开发者新增 REST 端点却忘记登记到 STAT_SPECS,
    导致 MCP 跟随缺失。expected 集合来自 app/routes/v1/stats.py 实际路由。
    """
    rest_paths = {s.route_path for s in STAT_SPECS}
    expected = {
        "/overview", "/focus-trend", "/task-distribution", "/daily-detail",
        "/habit-summary", "/schedule-summary", "/note-summary",
    }
    missing = expected - rest_paths
    assert not missing, f"STAT_SPECS missing REST paths: {missing}"


def test_daily_detail_mcp_tool_exists():
    """daily_detail 必须有对应 MCP 工具(或显式豁免)。

    REST /stats/daily-detail 存在,MCP 必须有 get_daily_detail 对应。
    本测试是 P1.6 的回归保护:之前 daily_detail 在 REST 有但 MCP 缺失,
    现已通过 STAT_SPECS 强制对齐。
    """
    import app.mcp.server as mcp_module
    assert hasattr(mcp_module, "get_daily_detail"), (
        "MCP server missing get_daily_detail tool "
        "(REST /daily-detail has no MCP equivalent)"
    )
