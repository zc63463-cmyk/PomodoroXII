"""Pydantic schemas for statistics / analytics responses."""

from pydantic import BaseModel


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
