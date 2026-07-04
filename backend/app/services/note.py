"""NoteService -- CRUD for notes with filesystem-backed content.

The Note model stores metadata only (content_hash, word_count).  The
full Markdown content lives in the filesystem.  This service coordinates
both stores using a Saga Try-Compensate pattern:

- ``create``: FS write → DB flush; on DB failure compensate by deleting
  the .md file.
- ``update_content``: save old content → FS rewrite → DB flush; on DB
  failure compensate by restoring the old .md content.
- ``delete``: DB delete + tombstone first → FS best-effort; if FS fails
  the orphan .md is harmless (consistency check can clean it later).

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.file_system.interfaces import FileSystem
from app.models.note import Note
from app.services.base import BaseService
from app.services.time import utc_now_iso


def _parse_tags(tags: Any) -> list[str]:
    """Parse tags from str (JSON) or list, raising ValidationError on bad JSON."""
    if isinstance(tags, str):
        if not tags:
            return []
        try:
            return json.loads(tags)
        except (json.JSONDecodeError, ValueError) as exc:
            from app.errors import ValidationError

            raise ValidationError(f"Invalid tags JSON: {exc}") from exc
    if isinstance(tags, list):
        return tags
    return []


class NoteService(BaseService):
    """Service for Note entities with filesystem-backed content.

    - ``create`` writes the .md file via the filesystem, then inserts
      the ORM row with content_hash and word_count from the file system.
      If the DB flush fails, the .md file is deleted as compensation.
    - ``get_content`` reads the .md file.
    - ``update_content`` rewrites the .md file and syncs hash/count.
      If the DB flush fails, the old .md content is restored.
    - ``update_metadata`` updates DB-only fields (title, tags, etc.).
    - ``delete`` removes the DB row and writes a tombstone first, then
      best-effort deletes the .md file.  Idempotent.
    """

    entity_type = "note"

    def __init__(
        self,
        db: AsyncSession,
        fs: FileSystem,
        sync_mode: bool = False,
    ) -> None:
        super().__init__(db)
        self.fs = fs
        self.model = Note
        self.sync_mode = sync_mode

    async def create(self, data: dict[str, Any]) -> Any:
        """Create a note: write .md via fs, then insert ORM row.

        Saga: if DB flush fails after FS write, the .md file is deleted
        to avoid leaving an orphan.
        """
        data = dict(data)
        content = data.pop("content", "")
        title = data.get("title", "")
        folder_id = data.get("folder_id")
        tags = _parse_tags(data.get("tags", []))
        external_id = data.get("id")

        meta = await self.fs.create_note(
            title=title,
            content=content,
            folder_id=folder_id,
            tags=tags,
            external_id=external_id,
        )

        # Ensure DB id matches fs note id.
        data["id"] = meta.id
        data["content_hash"] = meta.content_hash
        data["word_count"] = meta.word_count
        if "tags" in data and isinstance(data["tags"], list):
            data["tags"] = json.dumps(data["tags"])

        try:
            return await super().create(data)
        except Exception:
            # Compensate: delete the orphan .md file.
            try:
                await self.fs.delete_note(meta.id)
            except (KeyError, FileNotFoundError):
                pass
            raise

    async def get_content(self, id: str) -> str:
        """Read the .md content for a note."""
        return await self.fs.read_note(id)

    async def update_content(self, id: str, content: str) -> Any:
        """Rewrite the .md file and sync content_hash/word_count.

        Saga: save old content before FS rewrite; if DB flush fails,
        restore the old .md content.
        """
        # Save old content for compensation.
        old_content: str | None = None
        try:
            old_content = await self.fs.read_note(id)
        except (KeyError, FileNotFoundError):
            pass

        meta = await self.fs.edit_note(id, content)
        try:
            obj = await self.get(id)
            obj.content_hash = meta.content_hash
            obj.word_count = meta.word_count
            obj.updated_at = utc_now_iso()
            await self.db.flush()
            await self.db.refresh(obj)
            return obj
        except Exception:
            # Compensate: restore old .md content.
            if old_content is not None:
                try:
                    await self.fs.edit_note(id, old_content)
                except (KeyError, FileNotFoundError):
                    pass
            raise

    async def update_metadata(self, id: str, data: dict[str, Any]) -> Any:
        """Update DB-only fields (title, tags, category, etc.).

        Content-managed fields (content, content_hash, word_count) are
        stripped -- they must be updated via ``update_content``.
        """
        data = dict(data)
        data.pop("content", None)
        data.pop("content_hash", None)
        data.pop("word_count", None)
        if "tags" in data:
            data["tags"] = json.dumps(_parse_tags(data["tags"]))
        return await super().update(id, data)

    async def update(self, id: str, data: dict[str, Any]) -> Any:
        """Dispatch update: content goes to fs, the rest to DB."""
        data = dict(data)
        content = data.pop("content", None)
        obj = None
        if content is not None:
            obj = await self.update_content(id, content)
        if data:
            obj = await self.update_metadata(id, data)
        if obj is None:
            obj = await self.get(id)
        return obj

    async def delete(self, id: str) -> None:
        """Delete note: DB row + tombstone first, then FS best-effort.

        DB delete and tombstone creation happen before FS deletion so
        that if FS fails, the DB state is still consistent (the orphan
        .md file is harmless and can be cleaned by a consistency check).

        Idempotent: if the .md file or DB row is already gone, the
        operation completes without raising.  In ``sync_mode=True`` the
        tombstone write is skipped — the remote tombstone decision is
        authoritative and we must not overwrite it.
        """
        # DB delete first (tombstone is the source of truth for deletion).
        obj = await self.db.get(self.model, id)
        if obj is not None:
            await self.db.delete(obj)
            await self.db.flush()
        # M1: Create tombstone via BaseService helper (skipped in sync_mode).
        if not self.sync_mode:
            await self._ensure_tombstone(id)
        # FS deletion is best-effort (orphan .md is harmless).
        try:
            await self.fs.delete_note(id)
        except (KeyError, FileNotFoundError):
            pass
