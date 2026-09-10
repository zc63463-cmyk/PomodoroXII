"""StatsService -- aggregate statistics for habits, schedules, notes.

Does NOT import FastAPI.  Read-only queries, never commits.

Endpoints:
  - habit_summary: habit check-in rates and streaks
  - schedule_summary: schedule completion rates by period
  - note_summary: note/folder counts
  - focus_summary: focus-session quality by hour + estimate accuracy
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.focus_session import FocusSession
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

    # ----------------------------------------------------------------- #

    async def focus_summary(self, days: int = 30) -> dict:
        """Return focus-session statistics for the last *days* days.

        ★ 为什么按小时聚合：番茄钟数据里**最没用的数字是每日会话数**（易刷、
          信息量低），最有价值的是「一天里哪些时段产出的会话是完整无中断的、
          哪些是碎片化的」——这接近一份个人 chronotype map，可以直接指导
          「把最难的工作排在什么时候」。

        ★ 为什么在 Python 里聚合而不是用 SQL 的 substr：`started_at` 是 ISO
          字符串，毫秒精度在不同写入路径下长度不一致（`...00Z` 与 `...000Z`），
          用固定偏移的 SQL 字符串函数很脆。个人量级的会话数很小，取回来解析
          更简单也更好测。超过 MAX_SESSIONS 时截断，避免极端数据把内存吃光。

        Returns ``{"period_days", "total_sessions", "valid_sessions",
        "interrupted_sessions", "focused_seconds", "planned_seconds",
        "estimate_accuracy", "by_hour": [{hour, sessions, valid, interrupted,
        focused_seconds}] * 24}``.
        """
        now_dt = utc_now()
        start_date = (now_dt - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")

        rows = (
            await self.db.execute(
                select(
                    FocusSession.started_at,
                    FocusSession.planned_seconds,
                    FocusSession.focused_seconds,
                    FocusSession.paused_seconds,
                    FocusSession.validity,
                )
                .where(FocusSession.started_at >= start_date)
                .limit(MAX_FOCUS_SESSIONS)
            )
        ).all()

        by_hour: list[dict] = [
            {"hour": h, "sessions": 0, "valid": 0, "interrupted": 0, "focused_seconds": 0}
            for h in range(24)
        ]
        total = len(rows)
        valid = 0
        interrupted = 0
        focused_total = 0
        planned_total = 0

        for started_at, planned, focused, paused, validity in rows:
            focused_total += focused or 0
            planned_total += planned or 0
            interrupted_flag = (paused or 0) > 0
            if interrupted_flag:
                interrupted += 1
            if validity == "valid":
                valid += 1

            hour = parse_iso_hour(started_at)
            if hour is None:
                # 时间戳格式异常时不进小时分布，但仍计入上面的总量
                continue
            bucket = by_hour[hour]
            bucket["sessions"] += 1
            bucket["focused_seconds"] += focused or 0
            if validity == "valid":
                bucket["valid"] += 1
            if interrupted_flag:
                bucket["interrupted"] += 1

        # 估算准确度：整体 focused / planned。1.0 = 估得准；>1 超时，<1 提前结束。
        accuracy = round(focused_total / planned_total, 4) if planned_total > 0 else 0.0

        return {
            "period_days": days,
            "total_sessions": total,
            "valid_sessions": valid,
            "interrupted_sessions": interrupted,
            "focused_seconds": focused_total,
            "planned_seconds": planned_total,
            "estimate_accuracy": accuracy,
            "by_hour": by_hour,
        }


MAX_FOCUS_SESSIONS = 10_000


def parse_iso_hour(value: str | None) -> int | None:
    """从 ISO 时间戳里取小时（0–23）。格式异常时返回 None。

    `YYYY-MM-DDTHH:MM:SSZ` 与 `YYYY-MM-DDTHH:MM:SS.mmmZ` 都能处理 —— 取 `T`
    之后的头两位，不受毫秒段长度影响。
    """
    if not value or len(value) < 13 or value[10] != "T":
        return None
    try:
        hour = int(value[11:13])
    except ValueError:
        return None
    return hour if 0 <= hour <= 23 else None
