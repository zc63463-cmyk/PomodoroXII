"""Tests for StatsService.focus_summary — 番茄钟的时段质量分布与估算准确度。

设计意图（不是随便加的聚合）：
- 番茄钟数据里**每日会话数是最没用的数字**（易刷、信息量低），真正有价值的是
  「哪些时段产出的是完整无中断的会话」。所以本端点的核心输出是 by_hour。
- 会话本身有 gross / paused / break / focused 四类时长，这里用 paused_seconds
  判定"被打断过"，用 validity 判定"这次专注有效"。
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.services.time import utc_now


def _iso(dt) -> str:
    """与生产写入一致的 ISO 格式（秒精度，UTC）。"""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


async def _add_session(
    space_session,
    *,
    started_at: str,
    planned_seconds: int = 1500,
    focused_seconds: int = 1500,
    paused_seconds: int = 0,
    validity: str = "valid",
) -> None:
    from app.models.focus_session import FocusSession

    space_session.add(
        FocusSession(
            id=uuid.uuid4().hex,
            started_at=started_at,
            ended_at=started_at,
            planned_seconds=planned_seconds,
            gross_seconds=focused_seconds + paused_seconds,
            paused_seconds=paused_seconds,
            focused_seconds=focused_seconds,
            validity=validity,
            review_state="not_required",
            ownership_state="authoritative",
        )
    )
    await space_session.flush()


@pytest.mark.asyncio
async def test_focus_summary_empty(space_session):
    """无会话时返回全零，但 by_hour 仍固定 24 项（便于前端直接画热力图）。"""
    from app.services.stats import StatsService

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["period_days"] == 30
    assert result["total_sessions"] == 0
    assert result["estimate_accuracy"] == 0.0
    assert len(result["by_hour"]) == 24
    assert result["by_hour"][0]["hour"] == 0
    assert all(bucket["sessions"] == 0 for bucket in result["by_hour"])


@pytest.mark.asyncio
async def test_focus_summary_buckets_by_hour(space_session):
    """★ 核心：按「开始时间所在的小时」分桶。"""
    from app.services.stats import StatsService

    now = utc_now()
    base = now.replace(minute=0, second=0, microsecond=0)

    # 9 点两场、14 点一场
    await _add_session(space_session, started_at=_iso(base.replace(hour=9)))
    await _add_session(space_session, started_at=_iso(base.replace(hour=9)))
    await _add_session(space_session, started_at=_iso(base.replace(hour=14)))

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["total_sessions"] == 3
    assert result["by_hour"][9]["sessions"] == 2
    assert result["by_hour"][14]["sessions"] == 1
    assert result["by_hour"][10]["sessions"] == 0


@pytest.mark.asyncio
async def test_focus_summary_counts_interrupted_and_valid(space_session):
    """★ 被打断（paused_seconds > 0）与有效（validity == 'valid'）分别计数。"""
    from app.services.stats import StatsService

    now = utc_now()
    base = now.replace(minute=0, second=0, microsecond=0)

    await _add_session(space_session, started_at=_iso(base.replace(hour=9)), paused_seconds=0)
    await _add_session(
        space_session,
        started_at=_iso(base.replace(hour=9)),
        paused_seconds=120,
        validity="valid",
    )
    await _add_session(
        space_session,
        started_at=_iso(base.replace(hour=9)),
        paused_seconds=0,
        validity="invalid",
    )

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["total_sessions"] == 3
    assert result["interrupted_sessions"] == 1
    assert result["valid_sessions"] == 2
    assert result["by_hour"][9]["interrupted"] == 1
    assert result["by_hour"][9]["valid"] == 2


@pytest.mark.asyncio
async def test_focus_summary_estimate_accuracy(space_session):
    """估算准确度 = focused / planned。1.0 为估得准，<1 提前结束，>1 超时。"""
    from app.services.stats import StatsService

    now = utc_now()
    base = now.replace(minute=0, second=0, microsecond=0)

    # 计划 1500，实际 750 → 合计 3000/3000 = 1.0
    await _add_session(
        space_session,
        started_at=_iso(base.replace(hour=9)),
        planned_seconds=1500,
        focused_seconds=750,
    )
    await _add_session(
        space_session,
        started_at=_iso(base.replace(hour=10)),
        planned_seconds=1500,
        focused_seconds=2250,
    )

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["planned_seconds"] == 3000
    assert result["focused_seconds"] == 3000
    assert result["estimate_accuracy"] == 1.0


@pytest.mark.asyncio
async def test_focus_summary_excludes_sessions_outside_period(space_session):
    """超出 period 的会话不计入。"""
    from app.services.stats import StatsService

    now = utc_now()
    old = now - timedelta(days=90)

    await _add_session(space_session, started_at=_iso(old))
    await _add_session(space_session, started_at=_iso(now))

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["total_sessions"] == 1


@pytest.mark.asyncio
async def test_focus_summary_start_bounds_window(space_session):
    """★ 工单 A1：显式 ``start`` 生效 —— 窗口（含起点）之前排除、之内计入。

    窗口是 ``[start, +∞)`` 的字符串比较（与存储格式同构）。
    """
    from app.services.stats import StatsService

    now = utc_now()
    window_start = now - timedelta(days=1)

    # 窗口外（3 天前）与窗口内（1 小时前）各一条
    await _add_session(space_session, started_at=_iso(now - timedelta(days=3)))
    await _add_session(space_session, started_at=_iso(now - timedelta(hours=1)))

    result = await StatsService(space_session).focus_summary(days=30, start=_iso(window_start))

    assert result["total_sessions"] == 1
    assert result["focused_seconds"] == 1500
    # 排除要同时传导到小时分布（不是只砍总量）
    assert sum(bucket["sessions"] for bucket in result["by_hour"]) == 1
    # days 仅用于回显：响应形状与不传 start 时一致
    assert result["period_days"] == 30


@pytest.mark.asyncio
async def test_focus_summary_start_overrides_days(space_session):
    """★ 工单 A1：``start`` 提供时 ``days`` 不参与窗口推导。

    对照组证明「days 更宽也不会把窗口放大」—— 同一行数据只给 days 时计入，
    同时给 start（晚于该会话）时被排除。
    """
    from app.services.stats import StatsService

    now = utc_now()
    await _add_session(space_session, started_at=_iso(now - timedelta(hours=2)))

    # 对照：只给 days，该会话在 30 天窗口内 → 计入
    baseline = await StatsService(space_session).focus_summary(days=30)
    assert baseline["total_sessions"] == 1

    # 同时给 start（1 小时前）：窗口起点由 start 决定 → 该会话被排除
    result = await StatsService(space_session).focus_summary(
        days=30, start=_iso(now - timedelta(hours=1))
    )
    assert result["total_sessions"] == 0


@pytest.mark.asyncio
async def test_focus_summary_without_start_uses_days_window(space_session):
    """回归：不传 ``start`` 时窗口仍由 ``days`` 推导（与引入 start 前一致）。"""
    from app.services.stats import StatsService

    now = utc_now()

    # 29 天前在窗口内，31 天前在窗口外（days=30 → 起点为 30 天前的 UTC 零点）
    await _add_session(space_session, started_at=_iso(now - timedelta(days=29)))
    await _add_session(space_session, started_at=_iso(now - timedelta(days=31)))

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["total_sessions"] == 1
    assert result["period_days"] == 30


@pytest.mark.asyncio
async def test_focus_summary_response_shape_is_stable(space_session):
    """★ 工单 A1 红线：新增 ``start`` 后响应键集零变化。

    固定键集（services/stats.py 的 return 块与 FocusSummaryResponse 同源）：
    start 是"输入"不是"输出"；period_days 在提供 start 时仍回显 days。
    """
    from app.services.stats import StatsService

    expected_keys = {
        "period_days",
        "total_sessions",
        "valid_sessions",
        "interrupted_sessions",
        "focused_seconds",
        "planned_seconds",
        "estimate_accuracy",
        "by_hour",
    }

    without_start = await StatsService(space_session).focus_summary(days=30)
    with_start = await StatsService(space_session).focus_summary(
        days=30, start="2026-01-01T00:00:00Z"
    )

    assert set(without_start) == expected_keys
    assert set(with_start) == expected_keys
    # 每个小时桶的形状也不变
    for bucket in with_start["by_hour"]:
        assert set(bucket) == {"hour", "sessions", "valid", "interrupted", "focused_seconds"}


@pytest.mark.asyncio
async def test_focus_summary_tolerates_unparsable_timestamp(space_session):
    """★ 时间戳格式异常时：不进小时分布，但仍计入总量（不静默丢数据）。"""
    from app.services.stats import StatsService

    await _add_session(space_session, started_at="not-a-timestamp")

    result = await StatsService(space_session).focus_summary(days=30)

    assert result["total_sessions"] == 1
    assert result["focused_seconds"] == 1500
    assert all(bucket["sessions"] == 0 for bucket in result["by_hour"])


def test_parse_iso_hour_handles_both_precisions():
    from app.services.stats import parse_iso_hour

    # 秒精度与毫秒精度都要能解析（生产上两种写入路径都存在）
    assert parse_iso_hour("2026-09-04T09:30:00Z") == 9
    assert parse_iso_hour("2026-09-04T09:30:00.000Z") == 9
    assert parse_iso_hour("2026-09-04T23:59:59Z") == 23

    assert parse_iso_hour("") is None
    assert parse_iso_hour(None) is None
    assert parse_iso_hour("not-a-timestamp") is None
    assert parse_iso_hour("2026-09-04 09:30:00") is None  # 空格分隔而非 T
    assert parse_iso_hour("2026-09-04TAB:30:00Z") is None  # 小时非数字
