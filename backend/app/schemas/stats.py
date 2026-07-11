"""Pydantic schemas for statistics / analytics responses."""

from pydantic import BaseModel, RootModel


class FocusStatsResponse(BaseModel):
    """Aggregated focus-session statistics.

    ``by_day`` and ``by_task`` are lists of flat dicts (e.g.
    ``{"date": "2026-07-01", "minutes": 150}``) produced by the stats
    service — kept as ``list[dict]`` so the aggregation SQL can stay
    flexible without a rigid per-row schema.
    """

    total_sessions: int
    total_minutes: int
    by_day: list[dict] = []
    by_task: list[dict] = []

    model_config = {"from_attributes": True}


class CountDuration(BaseModel):
    """Count and aggregate duration shared by focus statistics."""

    count: int
    duration: int


class StatsOverviewResponse(RootModel[dict[str, CountDuration]]):
    """Bare dynamic mapping from requested period names to aggregates."""


class FocusTrendPoint(BaseModel):
    """One date in a focus trend."""

    date: str
    count: int
    duration: int


class FocusTrendResponse(BaseModel):
    """Daily focus aggregates for a requested date range."""

    data: list[FocusTrendPoint]


class TaskDistributionResponse(BaseModel):
    """Task counts grouped by status and priority."""

    by_status: dict[str, int]
    by_priority: dict[str, int]


class DailyDetailResponse(BaseModel):
    """Focus aggregates for one requested date."""

    date: str
    count: int
    duration: int


class HabitSummaryItem(BaseModel):
    """Check-in statistics for one active habit."""

    habit_id: str
    title: str
    total_check_ins: int
    check_in_days: int
    current_streak: int
    completion_rate: float


class HabitSummaryResponse(BaseModel):
    """Habit statistics for a requested period."""

    habits: list[HabitSummaryItem]
    period_days: int


class ScheduleSummaryResponse(BaseModel):
    """Schedule completion statistics for a requested period."""

    total: int
    completed: int
    pending: int
    overdue: int
    period_days: int
    completion_rate: float


class NoteSummaryResponse(BaseModel):
    """Active and trashed note/folder counts."""

    notes: int
    folders: int
    trashed_notes: int
    trashed_folders: int
