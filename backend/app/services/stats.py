"""StatsService -- aggregate statistics for habits, schedules, notes.

Does NOT import FastAPI.  Read-only queries, never commits.

Endpoints:
  - habit_summary: habit check-in rates and streaks
  - schedule_summary: schedule completion rates by period
  - note_summary: note/folder counts
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.folder import Folder
from app.models.habit import Habit
from app.models.habit_check_in import HabitCheckIn
from app.models.note import Note
from app.models.schedule import Schedule
from app.services.time import utc_now


class StatsService:
    """Compute aggregate statistics from habits, schedules, notes."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

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
