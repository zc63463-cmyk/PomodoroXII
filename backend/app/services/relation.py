"""RelationService -- link/unlink quick notes to tasks, sessions, schedules.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ValidationError
from app.models.task_quick_note import TaskQuickNote
from app.models.session_quick_note import SessionQuickNote
from app.models.schedule_quick_note import ScheduleQuickNote


class RelationService:
    """Manage many-to-many links between quick notes and parent entities.

    Supported kinds:
      - ``"task"``     -> TaskQuickNote     (parent column: ``task_id``)
      - ``"session"``  -> SessionQuickNote  (parent column: ``session_id``)
      - ``"schedule"`` -> ScheduleQuickNote (parent column: ``schedule_id``)
    """

    _KIND_MAP: dict[str, tuple[type, str]] = {
        "task": (TaskQuickNote, "task_id"),
        "session": (SessionQuickNote, "session_id"),
        "schedule": (ScheduleQuickNote, "schedule_id"),
    }

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def _resolve(self, kind: str) -> tuple[type, str]:
        """Return (model_class, parent_column_name) for *kind*."""
        if kind not in self._KIND_MAP:
            raise ValidationError(f"Unknown relation kind: {kind!r}")
        return self._KIND_MAP[kind]

    async def link(self, kind: str, parent_id: str, quick_note_id: str) -> Any:
        """Create a junction row.  Idempotent -- returns existing if present.

        Handles TOCTOU races by catching IntegrityError and re-querying.
        """
        model, parent_col = self._resolve(kind)
        res = await self.db.execute(
            select(model).where(
                getattr(model, parent_col) == parent_id,
                model.quick_note_id == quick_note_id,
            )
        )
        existing = res.scalar_one_or_none()
        if existing is not None:
            return existing
        row = model(**{parent_col: parent_id, "quick_note_id": quick_note_id})
        self.db.add(row)
        try:
            await self.db.flush()
            await self.db.refresh(row)
            return row
        except IntegrityError:
            # Race: another concurrent request inserted the same row.
            await self.db.rollback()
            res = await self.db.execute(
                select(model).where(
                    getattr(model, parent_col) == parent_id,
                    model.quick_note_id == quick_note_id,
                )
            )
            existing = res.scalar_one_or_none()
            if existing is not None:
                return existing
            raise

    async def unlink(self, kind: str, parent_id: str, quick_note_id: str) -> None:
        """Remove a junction row if it exists."""
        model, parent_col = self._resolve(kind)
        res = await self.db.execute(
            select(model).where(
                getattr(model, parent_col) == parent_id,
                model.quick_note_id == quick_note_id,
            )
        )
        existing = res.scalar_one_or_none()
        if existing is not None:
            await self.db.delete(existing)
            await self.db.flush()

    async def list_quick_notes(self, kind: str, parent_id: str) -> list[Any]:
        """Return all junction rows for a parent entity."""
        model, parent_col = self._resolve(kind)
        res = await self.db.execute(
            select(model).where(getattr(model, parent_col) == parent_id)
        )
        return list(res.scalars().all())
