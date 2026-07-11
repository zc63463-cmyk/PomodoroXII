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
    DailyDetailResponse,
    FocusTrendResponse,
    HabitSummaryResponse,
    NoteSummaryResponse,
    ScheduleSummaryResponse,
    StatsOverviewResponse,
    TaskDistributionResponse,
)
from app.services.stats import StatsService

router = APIRouter()


@router.get("/overview", response_model=StatsOverviewResponse)
async def stats_overview(
    periods: list[str] | None = Query(
        None,
        description="Periods to aggregate: today|week|month|total",
    ),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return session counts and total durations by time period."""
    return await StatsService(db).overview(periods=periods)


@router.get("/focus-trend", response_model=FocusTrendResponse)
async def stats_focus_trend(
    days: int = Query(7, ge=1, le=365, description="Number of days to trend"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return daily focus trend (count + duration) for the last *days* days."""
    return await StatsService(db).focus_trend(days=days)


@router.get("/task-distribution", response_model=TaskDistributionResponse)
async def stats_task_distribution(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return task distribution grouped by status and by priority."""
    return await StatsService(db).task_distribution()


@router.get("/daily-detail", response_model=DailyDetailResponse)
async def stats_daily_detail(
    date: str = Query(..., max_length=10, description="Date in YYYY-MM-DD format"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return session count and total duration for a specific date."""
    return await StatsService(db).daily_detail(date=date)


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
