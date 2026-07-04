"""StatsService -- aggregate statistics for sessions, tasks, habits, schedules.

Does NOT import FastAPI.  Read-only queries, never commits.

Endpoints:
  - overview: session counts/durations by period (today/week/month/total)
  - focus_trend: daily focus trend for last N days
  - task_distribution: task counts by status and priority
  - daily_detail: session stats for a specific date
  - habit_summary: habit check-in rates and streaks
  - schedule_summary: schedule completion rates by period
  - note_summary: note/folder counts
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session as PomodoroSession
from app.models.task import Task
from app.models.habit import Habit
from app.models.habit_check_in import HabitCheckIn
from app.models.schedule import Schedule
from app.models.note import Note
from app.models.folder import Folder
from app.services.time import utc_now


class StatsService:
    """Compute aggregate statistics from sessions, tasks, habits, schedules."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def overview(self, periods: list[str] | None = None) -> dict:
        """Return session counts and total durations by time period.

        Periods default to today, week, month, and total.  Only completed
        work sessions are counted.
        """
        if periods is None:
            periods = ["today", "week", "month", "total"]

        now_dt = utc_now()
        today = now_dt.date().isoformat()
        start_of_week = (
            now_dt - timedelta(days=now_dt.weekday())
        ).date().isoformat()
        start_of_month = now_dt.replace(day=1).date().isoformat()

        period_starts: dict[str, str | None] = {
            "today": today,
            "week": start_of_week,
            "month": start_of_month,
            "total": None,
        }

        result: dict = {}
        for name in periods:
            start_date = period_starts.get(name)
            q = select(
                func.count(PomodoroSession.id),
                func.sum(PomodoroSession.duration),
            ).where(
                PomodoroSession.type == "work",
                PomodoroSession.completed == True,  # noqa: E712
            )
            if start_date is not None:
                q = q.where(PomodoroSession.started_at >= start_date)
            res = await self.db.execute(q)
            count, total_duration = res.one()
            result[name] = {
                "count": count or 0,
                "duration": total_duration or 0,
            }
        return result

    async def focus_trend(self, days: int = 7) -> dict:
        """Return daily focus trend for the last *days* days.

        Missing dates are filled with zero counts and durations.
        """
        end = utc_now().date()
        start = end - timedelta(days=days - 1)

        date_expr = func.substr(PomodoroSession.started_at, 1, 10)
        q = (
            select(
                date_expr.label("date"),
                func.count(PomodoroSession.id).label("count"),
                func.sum(PomodoroSession.duration).label("duration"),
            )
            .where(
                PomodoroSession.type == "work",
                PomodoroSession.completed == True,  # noqa: E712
                date_expr >= start.isoformat(),
                date_expr <= end.isoformat(),
            )
            .group_by(date_expr)
            .order_by("date")
        )
        res = await self.db.execute(q)
        rows = res.all()

        data = {
            row.date: {"count": row.count, "duration": row.duration}
            for row in rows
        }

        filled: list[dict] = []
        current = start
        while current <= end:
            date_str = current.isoformat()
            entry = data.get(date_str, {})
            filled.append(
                {
                    "date": date_str,
                    "count": entry.get("count", 0),
                    "duration": entry.get("duration", 0),
                }
            )
            current += timedelta(days=1)

        return {"data": filled}

    async def task_distribution(self) -> dict:
        """Return task distribution by status and priority."""
        status_q = select(Task.status, func.count(Task.id)).group_by(
            Task.status
        )
        status_res = await self.db.execute(status_q)
        status_dist = {row[0]: row[1] for row in status_res.all()}

        priority_q = select(
            Task.priority, func.count(Task.id)
        ).group_by(Task.priority)
        priority_res = await self.db.execute(priority_q)
        priority_dist = {row[0]: row[1] for row in priority_res.all()}

        return {
            "by_status": status_dist,
            "by_priority": priority_dist,
        }

    async def daily_detail(self, date: str) -> dict:
        """Return session count and total duration for a specific date."""
        date_expr = func.substr(PomodoroSession.started_at, 1, 10)
        q = select(
            func.count(PomodoroSession.id),
            func.sum(PomodoroSession.duration),
        ).where(
            PomodoroSession.type == "work",
            PomodoroSession.completed == True,  # noqa: E712
            date_expr == date,
        )
        res = await self.db.execute(q)
        count, duration = res.one()
        return {
            "date": date,
            "count": count or 0,
            "duration": duration or 0,
        }

    # ----------------------------------------------------------------- #
    # Habit statistics
    # ----------------------------------------------------------------- #

    async def habit_summary(self, days: int = 30) -> dict:
        """Return habit check-in statistics for the last *days* days.

        For each active (non-archived) habit:
        - total_check_ins: count of check-in records in the period
        - check_in_days: distinct days with at least one check-in
        - current_streak: consecutive days ending today with check-ins
        - completion_rate: check_in_days / days (capped at 1.0)

        Returns ``{"habits": [...], "period_days": days}``.
        """
        now_dt = utc_now()
        end_date = now_dt.date().isoformat()
        start_date = (now_dt - timedelta(days=days - 1)).date().isoformat()

        # Fetch active habits.
        habits_res = await self.db.execute(
            select(Habit).where(Habit.archived == False)  # noqa: E712
        )
        habits = habits_res.scalars().all()

        result_habits: list[dict] = []
        for habit in habits:
            # Count check-ins in period.
            count_q = select(
                func.count(HabitCheckIn.id)
            ).where(
                HabitCheckIn.habit_id == habit.id,
                HabitCheckIn.date >= start_date,
                HabitCheckIn.date <= end_date,
            )
            total_check_ins = (await self.db.execute(count_q)).scalar() or 0

            # Distinct check-in days.
            days_q = select(
                func.count(func.distinct(HabitCheckIn.date))
            ).where(
                HabitCheckIn.habit_id == habit.id,
                HabitCheckIn.date >= start_date,
                HabitCheckIn.date <= end_date,
            )
            check_in_days = (await self.db.execute(days_q)).scalar() or 0

            # Current streak: walk backwards from today counting consecutive
            # days that have a check-in. Stops at first gap.
            dates_q = select(HabitCheckIn.date).where(
                HabitCheckIn.habit_id == habit.id,
                HabitCheckIn.date <= end_date,
            ).order_by(HabitCheckIn.date.desc())
            check_in_dates_raw = (await self.db.execute(dates_q)).scalars().all()
            check_in_dates = set(check_in_dates_raw)

            current_streak = 0
            cursor = now_dt.date()
            while cursor.isoformat() in check_in_dates:
                current_streak += 1
                cursor -= timedelta(days=1)

            completion_rate = min(check_in_days / days, 1.0) if days > 0 else 0.0

            result_habits.append({
                "habit_id": habit.id,
                "title": habit.title,
                "total_check_ins": total_check_ins,
                "check_in_days": check_in_days,
                "current_streak": current_streak,
                "completion_rate": round(completion_rate, 4),
            })

        return {"habits": result_habits, "period_days": days}

    # ----------------------------------------------------------------- #
    # Schedule statistics
    # ----------------------------------------------------------------- #

    async def schedule_summary(self, days: int = 30) -> dict:
        """Return schedule completion statistics for the last *days* days.

        Counts schedules by completion status whose due_at falls within
        the period:
        - total: all schedules due in the period
        - completed: completed_at is not null
        - pending: completed_at is null and due_at >= now
        - overdue: completed_at is null and due_at < now

        Returns ``{"total": N, "completed": N, "pending": N, "overdue": N,
        "completion_rate": float, "period_days": days}``.
        """
        now_dt = utc_now()
        now_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        start_date = (now_dt - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")

        q = select(
            func.count(Schedule.id),
        ).where(
            Schedule.due_at >= start_date,
        )
        total = (await self.db.execute(q)).scalar() or 0

        completed_q = select(
            func.count(Schedule.id)
        ).where(
            Schedule.due_at >= start_date,
            Schedule.completed_at.is_not(None),
        )
        completed = (await self.db.execute(completed_q)).scalar() or 0

        pending_q = select(
            func.count(Schedule.id)
        ).where(
            Schedule.due_at >= start_date,
            Schedule.completed_at.is_(None),
            Schedule.due_at >= now_iso,
        )
        pending = (await self.db.execute(pending_q)).scalar() or 0

        overdue_q = select(
            func.count(Schedule.id)
        ).where(
            Schedule.due_at >= start_date,
            Schedule.completed_at.is_(None),
            Schedule.due_at < now_iso,
        )
        overdue = (await self.db.execute(overdue_q)).scalar() or 0

        completion_rate = completed / total if total > 0 else 0.0

        return {
            "total": total,
            "completed": completed,
            "pending": pending,
            "overdue": overdue,
            "completion_rate": round(completion_rate, 4),
            "period_days": days,
        }

    # ----------------------------------------------------------------- #
    # Note / Folder counts
    # ----------------------------------------------------------------- #

    async def note_summary(self) -> dict:
        """Return note and folder counts.

        - total_notes: all non-trashed notes
        - total_folders: all non-trashed folders
        - trashed_notes: notes with trashed_at set
        - trashed_folders: folders with trashed_at set

        Returns ``{"notes": N, "folders": N, "trashed_notes": N,
        "trashed_folders": N}``.
        """
        notes_q = select(func.count(Note.id)).where(Note.trashed_at.is_(None))
        total_notes = (await self.db.execute(notes_q)).scalar() or 0

        folders_q = select(func.count(Folder.id)).where(Folder.trashed_at.is_(None))
        total_folders = (await self.db.execute(folders_q)).scalar() or 0

        trashed_notes_q = select(func.count(Note.id)).where(Note.trashed_at.is_not(None))
        trashed_notes = (await self.db.execute(trashed_notes_q)).scalar() or 0

        trashed_folders_q = select(func.count(Folder.id)).where(Folder.trashed_at.is_not(None))
        trashed_folders = (await self.db.execute(trashed_folders_q)).scalar() or 0

        return {
            "notes": total_notes,
            "folders": total_folders,
            "trashed_notes": trashed_notes,
            "trashed_folders": trashed_folders,
        }
