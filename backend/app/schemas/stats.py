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


class FocusHourBucket(BaseModel):
    """One hour-of-day bucket of focus sessions."""

    hour: int
    sessions: int
    valid: int
    interrupted: int
    focused_seconds: int


class FocusSummaryResponse(BaseModel):
    """Focus-session statistics for a requested period.

    ``by_hour`` 固定 24 项（含全零的小时），便于前端直接画热力图。
    ``estimate_accuracy`` 为 focused/planned 的整体比值，1.0 表示估算准确。
    """

    period_days: int
    total_sessions: int
    valid_sessions: int
    interrupted_sessions: int
    focused_seconds: int
    planned_seconds: int
    estimate_accuracy: float
    by_hour: list[FocusHourBucket]
