"""Tests for StatsService extended dimensions — habit/schedule/note stats.

Verifies the three new StatsService methods added to cover habit
check-in rates, schedule completion rates, and note/folder counts.
"""
from __future__ import annotations

import uuid

import pytest


@pytest.mark.asyncio
async def test_habit_summary_returns_empty_when_no_habits(space_session):
    """habit_summary should return empty list when no active habits exist."""
    from app.services.stats import StatsService

    result = await StatsService(space_session).habit_summary(days=30)
    assert result["period_days"] == 30
    assert result["habits"] == []


@pytest.mark.asyncio
async def test_habit_summary_returns_check_in_stats(space_session):
    """habit_summary should return check-in counts, streaks, completion rate."""
    from datetime import timedelta

    from app.models.habit_check_in import HabitCheckIn
    from app.services.habit import HabitService
    from app.services.stats import StatsService
    from app.services.time import utc_now

    # Create a habit.
    habit_svc = HabitService(space_session)
    habit = await habit_svc.create({
        "id": uuid.uuid4().hex,
        "title": "Drink Water",
        "color": "#3b82f6",
        "icon": "💧",
        "target_count": 1,
    })

    # Create check-ins for last 3 days.
    now = utc_now()
    check_in_dates = []
    for i in range(3):
        d = (now - timedelta(days=i)).date().isoformat()
        check_in_dates.append(d)
        space_session.add(HabitCheckIn(
            id=uuid.uuid4().hex,
            habit_id=habit.id,
            date=d,
            count=1,
        ))
    await space_session.flush()

    result = await StatsService(space_session).habit_summary(days=30)
    assert len(result["habits"]) == 1
    h = result["habits"][0]
    assert h["title"] == "Drink Water"
    assert h["total_check_ins"] == 3
    assert h["check_in_days"] == 3
    assert h["current_streak"] == 3
    assert 0 < h["completion_rate"] <= 1.0


@pytest.mark.asyncio
async def test_habit_summary_excludes_archived_habits(space_session):
    """habit_summary should only include non-archived habits."""
    from app.services.habit import HabitService
    from app.services.stats import StatsService

    habit_svc = HabitService(space_session)
    await habit_svc.create({
        "id": uuid.uuid4().hex,
        "title": "Active Habit",
    })
    await habit_svc.create({
        "id": uuid.uuid4().hex,
        "title": "Archived Habit",
        "archived": True,
    })
    await space_session.flush()

    result = await StatsService(space_session).habit_summary(days=7)
    titles = [h["title"] for h in result["habits"]]
    assert "Active Habit" in titles
    assert "Archived Habit" not in titles


@pytest.mark.asyncio
async def test_schedule_summary_returns_empty_when_no_schedules(space_session):
    """schedule_summary should return zeros when no schedules exist."""
    from app.services.stats import StatsService

    result = await StatsService(space_session).schedule_summary(days=30)
    assert result["total"] == 0
    assert result["completed"] == 0
    assert result["pending"] == 0
    assert result["overdue"] == 0
    assert result["completion_rate"] == 0.0


@pytest.mark.asyncio
async def test_schedule_summary_counts_completion_status(space_session):
    """schedule_summary should correctly count completed/pending/overdue."""
    from datetime import timedelta

    from app.services.schedule import ScheduleService
    from app.services.stats import StatsService
    from app.services.time import utc_now

    svc = ScheduleService(space_session)
    now = utc_now()
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%dT23:59:59Z")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%dT12:00:00Z")
    yesterday_morning = (now - timedelta(days=1)).strftime("%Y-%m-%dT08:00:00Z")

    # Completed schedule (due yesterday, completed).
    await svc.create({
        "id": uuid.uuid4().hex,
        "title": "Done",
        "due_at": yesterday,
        "completed_at": now_iso,
    })
    # Pending schedule (due tomorrow).
    await svc.create({
        "id": uuid.uuid4().hex,
        "title": "Upcoming",
        "due_at": tomorrow,
    })
    # Overdue schedule (due yesterday morning, not completed).
    await svc.create({
        "id": uuid.uuid4().hex,
        "title": "Late",
        "due_at": yesterday_morning,
    })
    await space_session.flush()

    result = await StatsService(space_session).schedule_summary(days=30)
    assert result["total"] >= 3
    assert result["completed"] >= 1
    assert result["pending"] >= 1
    assert result["overdue"] >= 1


@pytest.mark.asyncio
async def test_note_summary_returns_counts(space_session):
    """note_summary should return note/folder counts (active + trashed)."""
    from app.models.folder import Folder
    from app.models.note import Note
    from app.services.stats import StatsService

    # Create notes.
    for i in range(3):
        space_session.add(Note(
            id=uuid.uuid4().hex,
            title=f"Note {i}",
            tags="[]",
            trashed_at=None,
        ))
    # Trashed note.
    space_session.add(Note(
        id=uuid.uuid4().hex,
        title="Trashed",
        tags="[]",
        trashed_at="2026-07-01T00:00:00Z",
    ))
    # Folders.
    space_session.add(Folder(id=uuid.uuid4().hex, name="F1"))
    space_session.add(Folder(
        id=uuid.uuid4().hex, name="TrashedFolder",
        trashed_at="2026-07-01T00:00:00Z",
    ))
    await space_session.flush()

    result = await StatsService(space_session).note_summary()
    assert result["notes"] == 3
    assert result["trashed_notes"] == 1
    assert result["folders"] == 1
    assert result["trashed_folders"] == 1
