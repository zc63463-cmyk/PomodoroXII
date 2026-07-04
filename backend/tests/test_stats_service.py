"""Tests for StatsService -- overview, focus_trend, task_distribution, daily_detail.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations

import uuid

import pytest


@pytest.mark.asyncio
async def test_overview_counts_completed_work_sessions(space_session):
    """overview() should count completed work sessions only."""
    from app.services.stats import StatsService
    from app.models.session import Session as PomodoroSession
    from app.services.time import utc_now_iso

    svc = StatsService(space_session)

    # Create 3 completed work sessions.
    for _ in range(3):
        space_session.add(PomodoroSession(
            id=uuid.uuid4().hex,
            type="work",
            duration=25,
            completed=True,
            started_at=utc_now_iso(),
        ))
    # Create an incomplete session (should not be counted).
    space_session.add(PomodoroSession(
        id=uuid.uuid4().hex,
        type="work",
        duration=25,
        completed=False,
        started_at=utc_now_iso(),
    ))
    await space_session.flush()

    result = await svc.overview()
    assert result["total"]["count"] == 3


@pytest.mark.asyncio
async def test_overview_sums_durations(space_session):
    """overview() should sum durations of completed work sessions."""
    from app.services.stats import StatsService
    from app.models.session import Session as PomodoroSession
    from app.services.time import utc_now_iso

    svc = StatsService(space_session)

    for dur in [25, 25, 15]:
        space_session.add(PomodoroSession(
            id=uuid.uuid4().hex,
            type="work",
            duration=dur,
            completed=True,
            started_at=utc_now_iso(),
        ))
    await space_session.flush()

    result = await svc.overview()
    assert result["total"]["duration"] == 65


@pytest.mark.asyncio
async def test_focus_trend_fills_missing_dates(space_session):
    """focus_trend() should fill missing dates with zero counts."""
    from app.services.stats import StatsService
    from app.models.session import Session as PomodoroSession
    from app.services.time import utc_now, utc_now_iso

    svc = StatsService(space_session)

    # Create one session today.
    space_session.add(PomodoroSession(
        id=uuid.uuid4().hex,
        type="work",
        duration=25,
        completed=True,
        started_at=utc_now_iso(),
    ))
    await space_session.flush()

    result = await svc.focus_trend(days=7)
    assert len(result["data"]) == 7

    today = utc_now().date().isoformat()
    today_entry = [d for d in result["data"] if d["date"] == today][0]
    assert today_entry["count"] == 1

    zero_days = [d for d in result["data"] if d["count"] == 0]
    assert len(zero_days) == 6


@pytest.mark.asyncio
async def test_task_distribution_by_status_and_priority(space_session):
    """task_distribution() should group tasks by status and priority."""
    from app.services.stats import StatsService
    from app.models.task import Task

    svc = StatsService(space_session)

    space_session.add(Task(
        id=uuid.uuid4().hex, title="T1",
        status="todo", priority="high", tags="[]",
    ))
    space_session.add(Task(
        id=uuid.uuid4().hex, title="T2",
        status="todo", priority="low", tags="[]",
    ))
    space_session.add(Task(
        id=uuid.uuid4().hex, title="T3",
        status="done", priority="high", tags="[]",
    ))
    await space_session.flush()

    result = await svc.task_distribution()
    assert result["by_status"]["todo"] == 2
    assert result["by_status"]["done"] == 1
    assert result["by_priority"]["high"] == 2
    assert result["by_priority"]["low"] == 1


@pytest.mark.asyncio
async def test_daily_detail_for_specific_date(space_session):
    """daily_detail() should return count and duration for a specific date."""
    from app.services.stats import StatsService
    from app.models.session import Session as PomodoroSession
    from app.services.time import utc_now, utc_now_iso

    svc = StatsService(space_session)

    today = utc_now().date().isoformat()

    # Create 2 completed work sessions for today.
    for _ in range(2):
        space_session.add(PomodoroSession(
            id=uuid.uuid4().hex,
            type="work",
            duration=25,
            completed=True,
            started_at=utc_now_iso(),
        ))
    # Create an incomplete session (should not be counted).
    space_session.add(PomodoroSession(
        id=uuid.uuid4().hex,
        type="work",
        duration=25,
        completed=False,
        started_at=utc_now_iso(),
    ))
    await space_session.flush()

    result = await svc.daily_detail(today)
    assert result["count"] == 2
    assert result["duration"] == 50
