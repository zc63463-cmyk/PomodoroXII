"""StatSpec — 统计维度的统一登记。

替代 StatsService 方法名、REST 路由、MCP 工具名三处手工同步。
单一事实源:新增统计维度只需在此处追加一个 StatSpec,parity test 自动校验
REST /stats 端点与 MCP 工具的覆盖关系。

参考:
- app/services/stats.py (StatsService 方法实现)
- app/routes/v1/stats.py (REST 路由)
- app/mcp/server.py (@mcp.tool 装饰器)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class StatSpec:
    """单个统计维度的元数据。

    Attributes:
        name: 维度名,如 "daily_detail" (与 StatsService 方法名同源)
        service_method: StatsService 上的方法名,如 "daily_detail"
        route_path: REST /stats 下的子路径,如 "/daily-detail"
        mcp_tool: MCP 工具名,如 "get_daily_detail"
        mcp_enabled: 是否暴露为 MCP 工具(False = 仅 REST,需在例外表登记)
        params: 参数约束,如 {"days": {"default": 30, "ge": 1, "le": 365}}
    """
    name: str
    service_method: str
    route_path: str
    mcp_tool: str
    mcp_enabled: bool = True
    params: dict[str, Any] = field(default_factory=dict)


STAT_SPECS: tuple[StatSpec, ...] = (
    StatSpec(
        name="overview",
        service_method="overview",
        route_path="/overview",
        mcp_tool="get_stats_overview",
        params={"periods": {"default": None}},
    ),
    StatSpec(
        name="focus_trend",
        service_method="focus_trend",
        route_path="/focus-trend",
        mcp_tool="get_focus_trend",
        params={"days": {"default": 7, "ge": 1, "le": 365}},
    ),
    StatSpec(
        name="task_distribution",
        service_method="task_distribution",
        route_path="/task-distribution",
        mcp_tool="get_task_distribution",
    ),
    StatSpec(
        name="daily_detail",
        service_method="daily_detail",
        route_path="/daily-detail",
        mcp_tool="get_daily_detail",
        params={"date": {"required": True, "max_length": 10}},
    ),
    StatSpec(
        name="habit_summary",
        service_method="habit_summary",
        route_path="/habit-summary",
        mcp_tool="get_habit_summary",
        params={"days": {"default": 30, "ge": 1, "le": 365}},
    ),
    StatSpec(
        name="schedule_summary",
        service_method="schedule_summary",
        route_path="/schedule-summary",
        mcp_tool="get_schedule_summary",
        params={"days": {"default": 30, "ge": 1, "le": 365}},
    ),
    StatSpec(
        name="note_summary",
        service_method="note_summary",
        route_path="/note-summary",
        mcp_tool="get_note_summary",
    ),
)
