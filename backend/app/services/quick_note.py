"""QuickNoteService -- CRUD for quick notes (rapid capture).

Does NOT import FastAPI.  Only flushes, never commits.
"""
from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from app.errors import ConflictError, ValidationError
from app.models.memo_comment import MemoComment
from app.models.quick_note import QuickNote
from app.services.base import BaseService
from app.services.serializers import serialize_entity
from app.services.sync_outbox import record_sync_event
from app.services.time import utc_now_iso

if TYPE_CHECKING:
    from app.services.note import NoteService


class QuickNoteService(BaseService):
    """Thin service for QuickNote — tags serialisation, trashed exclusion, pin ordering."""

    model = QuickNote
    entity_type = "quickNote"

    async def create(self, data: dict) -> object:
        data = dict(data)
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])
        return await super().create(data)

    async def update(self, id: str, data: dict) -> object:
        data = dict(data)
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])
        return await super().update(id, data)

    async def list(
        self,
        *,
        offset: int = 0,
        limit: int = 50,
        filters: dict | None = None,
    ) -> tuple[list, int]:
        q = select(self.model)
        if filters:
            for k, v in filters.items():
                q = q.where(getattr(self.model, k) == v)
        # Exclude trashed quick notes from the regular listing.
        q = q.where(QuickNote.trashed_at.is_(None))
        # D-4: also exclude archived (converted-to-Note) quick notes.
        q = q.where(QuickNote.archived_at.is_(None))
        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar() or 0
        # Pinned first, then newest.
        q = q.order_by(QuickNote.pinned.desc(), QuickNote.created_at.desc(), QuickNote.id.desc())
        rows = (
            await self.db.execute(q.offset(offset).limit(limit))
        ).scalars().all()
        return rows, total

    async def convert(
        self,
        id: str,
        *,
        note_service: "NoteService",
        store: Any | None = None,
        scope: Any | None = None,
    ) -> dict[str, Any]:
        """Convert a QuickNote into a full Note (transactional).

        When *store* and *scope* are provided, delegates to
        ``KnowledgeStore.convert_quick_note`` which routes the entire
        conversion (note create + quick note archive + memo comment
        copies) through the durable mutation pipeline as one atomic
        batch.  This ensures sync events, projections, and journal
        entries are created atomically.

        Without *store*/*scope*, falls back to the legacy direct ORM
        path (used by service-layer tests that don't have a runtime).

        Raises:
            NotFoundError: quick note missing (via ``self.get``).
            ConflictError: already converted.
            ValidationError: quick note is trashed (restore first).

        Only flushes; the caller (route) is responsible for ``commit``.
        """
        qn = await self.get(id)  # raises NotFoundError if missing
        if qn.trashed_at is not None:
            raise ValidationError(
                f"QuickNote {id} is in trash; restore before converting"
            )
        if qn.archived_at is not None or qn.migrated_to_note_id is not None:
            raise ConflictError(f"QuickNote {id} already converted")

        # ── Durable path: delegate to KnowledgeStore ──
        if store is not None and scope is not None:
            import uuid

            operation_id = f"convert:quick_note:{id}:{uuid.uuid4().hex[:16]}"
            await store.convert_quick_note(
                scope, id, qn.version, operation_id,
            )
            # Compute deterministic note_id (same algorithm as store).
            note_id = hashlib.sha256(
                f"{operation_id}\0note".encode("ascii")
            ).hexdigest()[:32]
            # Count memo comments for the response.
            comments = (
                await self.db.execute(
                    select(MemoComment).where(MemoComment.note_id == id)
                )
            ).scalars().all()
            return {
                "note_id": note_id,
                "quick_note_id": id,
                "migrated_comments_count": len(comments),
            }

        # ── Legacy path: direct ORM (service-layer tests) ──
        tags = json.loads(qn.tags) if qn.tags else []
        raw = (qn.content or "").strip()
        if raw:
            title = raw[:80] + ("..." if len(raw) > 80 else "")
        else:
            title = "(converted quick note)"

        note = await note_service.create({
            "content": qn.content or "",
            "title": title,
            "tags": tags,
            "folder_id": qn.folder_id,
        })

        qn.migrated_to_note_id = note.id
        qn.archived_at = utc_now_iso()
        await self.db.flush()
        await self.db.refresh(qn)
        await record_sync_event(
            self.db,
            entity_type=self.entity_type,
            entity_id=qn.id,
            action="update",
            payload=serialize_entity(qn),
            visible=True,
        )

        # Copy memo_comments (note_id points to new Note.id; originals kept).
        comments = (
            await self.db.execute(
                select(MemoComment).where(MemoComment.note_id == id)
            )
        ).scalars().all()
        copied_comments: list[MemoComment] = []
        for c in comments:
            copied = MemoComment(note_id=note.id, content=c.content)
            self.db.add(copied)
            copied_comments.append(copied)
        if copied_comments:
            await self.db.flush()
            for copied in copied_comments:
                await self.db.refresh(copied)
                await record_sync_event(
                    self.db,
                    entity_type="memoComment",
                    entity_id=copied.id,
                    action="create",
                    payload=serialize_entity(copied),
                    visible=True,
                )

        return {
            "note_id": note.id,
            "quick_note_id": id,
            "migrated_comments_count": len(comments),
        }
