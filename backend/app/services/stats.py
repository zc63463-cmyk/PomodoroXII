"""StatsService -- aggregate statistics for sessions and tasks.

Does NOT import FastAPI.  Read-only queries, never commits.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session as PomodoroSession
from app.models.task import Task
from app.services.time import utc_now


class StatsService:
    """Compute aggregate statistics from sessions and tasks."""

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
