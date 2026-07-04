"""REST routes for statistics / analytics.

Read-only aggregation endpoints backed by ``StatsService``.  All endpoints
return plain dicts (no ``response_model``) so the flexible aggregation
output of the service passes through unchanged.  Routes commit (no-op for
reads); the service performs only SELECT queries.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.services.stats import StatsService

router = APIRouter()


@router.get("/overview")
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


@router.get("/focus-trend")
async def stats_focus_trend(
    days: int = Query(7, ge=1, le=365, description="Number of days to trend"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return daily focus trend (count + duration) for the last *days* days."""
    return await StatsService(db).focus_trend(days=days)


@router.get("/task-distribution")
async def stats_task_distribution(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return task distribution grouped by status and by priority."""
    return await StatsService(db).task_distribution()


@router.get("/daily-detail")
async def stats_daily_detail(
    date: str = Query(..., max_length=10, description="Date in YYYY-MM-DD format"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return session count and total duration for a specific date."""
    return await StatsService(db).daily_detail(date=date)
