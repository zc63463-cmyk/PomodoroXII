"""REST routes for statistics / analytics.

Read-only aggregation endpoints backed by ``StatsService``.  Explicit response
models mirror the service output, preserving the runtime JSON shape while
keeping OpenAPI responses typed.  The service performs only SELECT queries.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.schemas.stats import (
    FocusSummaryResponse,
    HabitSummaryResponse,
    NoteSummaryResponse,
    ScheduleSummaryResponse,
)
from app.services.stats import StatsService

router = APIRouter()


@router.get("/habit-summary", response_model=HabitSummaryResponse)
async def stats_habit_summary(
    days: int = Query(30, ge=1, le=365, description="Period in days"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return habit check-in rates, streaks, and completion for the period."""
    return await StatsService(db).habit_summary(days=days)


@router.get("/schedule-summary", response_model=ScheduleSummaryResponse)
async def stats_schedule_summary(
    days: int = Query(30, ge=1, le=365, description="Period in days"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return schedule completion rates (completed/pending/overdue)."""
    return await StatsService(db).schedule_summary(days=days)


@router.get("/note-summary", response_model=NoteSummaryResponse)
async def stats_note_summary(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return note and folder counts (active + trashed)."""
    return await StatsService(db).note_summary()


@router.get("/focus-summary", response_model=FocusSummaryResponse)
async def stats_focus_summary(
    days: int = Query(30, ge=1, le=365, description="Period in days"),
    # ★ 为什么用 pattern 而不是 datetime（2026-09-14 «今日»口径工单 A1）：
    #   过滤走 SQLite 字符串比较（services/time.py 的格式契约：Z 后缀 UTC 秒精度），
    #   `start` 必须与存储格式**同构**才能正确比较。schema 级 pattern 直接挡住
    #   异形值（缺 Z / 毫秒 / 本地时区偏移），比运行期 datetime 转换的时区歧义更少。
    start: str | None = Query(
        None,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$",
        description="Inclusive window start (UTC, second precision)",
    ),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return focus-session quality by hour of day, plus estimate accuracy.

    The hourly distribution is the point of this endpoint: it answers
    "which hours produce uninterrupted sessions" rather than "how many
    sessions did I do", which is the least informative number available.

    ``start`` (optional) pins the window start explicitly; when omitted the
    window is derived from ``days`` exactly as before (see StatsService).
    """
    return await StatsService(db).focus_summary(days=days, start=start)
