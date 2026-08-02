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
