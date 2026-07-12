"""NoteService -- CRUD for notes with filesystem-backed content.

The Note model stores metadata only (content_hash, word_count).  The
full Markdown content lives in the filesystem.  This service coordinates
both stores using a Saga Try-Compensate pattern:

- ``create``: FS write → DB flush; on DB failure compensate by deleting
  the .md file.
- ``update_content``: save old content → FS rewrite → DB flush; on DB
  failure compensate by restoring the old .md content.
- ``delete``: default soft-delete (sets trashed_at + moves .md to .trash/);
  hard=True (sync/REST purge) does DB delete + tombstone + FS best-effort.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.file_system.interfaces import FileSystem
from app.models.note import Note
from app.services.base import BaseService
from app.services.serializers import serialize_entity
from app.services.sync_outbox import record_sync_event
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
    - ``delete`` (default) soft-deletes: sets trashed_at + moves .md to
      .trash/; hard=True removes DB row + tombstone + FS best-effort. Both idempotent.
    """

    entity_type = "note"

    def __init__(
        self,
        db: AsyncSession,
        fs: FileSystem,
        sync_mode: bool = False,
    ) -> None:
        super().__init__(db, record_sync_events=not sync_mode)
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
            obj = await super().create(data, record_event=False)
            if self.record_sync_events:
                payload = serialize_entity(obj)
                payload["content"] = content
                await record_sync_event(
                    self.db,
                    entity_type=self.entity_type,
                    entity_id=obj.id,
                    action="create",
                    payload=payload,
                )
            return obj
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

    async def update_content(
        self,
        id: str,
        content: str,
        *,
        updated_at_override: str | None = None,
        record_event: bool = True,
    ) -> Any:
        """Rewrite the .md file and sync content_hash/word_count.

        Saga: save old content before FS rewrite; if DB flush fails,
        restore the old .md content.

        When *updated_at_override* is provided (sync_mode=True), the DB
        row's updated_at is set to this value instead of server-now.
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
            obj.updated_at = (
                updated_at_override if updated_at_override is not None
                else utc_now_iso()
            )
            if updated_at_override is not None:
                # P1-3: Force updated_at into the UPDATE SET clause so
                # SyncMixin.onupdate=utc_now_iso_ms does not fire and
                # overwrite the client-provided timestamp.
                flag_modified(obj, "updated_at")
            await self.db.flush()
            await self.db.refresh(obj)
            if self.record_sync_events and record_event:
                payload = serialize_entity(obj)
                payload["content"] = content
                await record_sync_event(
                    self.db,
                    entity_type=self.entity_type,
                    entity_id=obj.id,
                    action="update",
                    payload=payload,
                )
            return obj
        except Exception:
            # Compensate: restore old .md content.
            if old_content is not None:
                try:
                    await self.fs.edit_note(id, old_content)
                except (KeyError, FileNotFoundError):
                    pass
            raise

    async def update_metadata(
        self,
        id: str,
        data: dict[str, Any],
        *,
        updated_at_override: str | None = None,
        record_event: bool = True,
    ) -> Any:
        """Update DB-only fields (title, tags, category, etc.).

        Content-managed fields (content, content_hash, word_count) are
        stripped -- they must be updated via ``update_content``.

        When *updated_at_override* is provided (sync_mode=True), the
        caller's timestamp is preserved instead of bumping to server-now.
        """
        # E-5: REST guard -- reject metadata updates on trashed notes.
        # Sync push path (sync_mode=True) bypasses this check to preserve
        # the existing wire-format semantics where sync drives the lifecycle.
        if not self.sync_mode:
            existing = await self.get(id)
            if existing.trashed_at is not None:
                from app.errors import ValidationError

                raise ValidationError(
                    f"Note {id} is in trash; restore before editing"
                )

        data = dict(data)
        data.pop("content", None)
        data.pop("content_hash", None)
        data.pop("word_count", None)
        if "tags" in data:
            data["tags"] = json.dumps(_parse_tags(data["tags"]))
        if updated_at_override is not None:
            # Sync path: preserve the client-provided timestamp and do NOT
            # bump version.  Bump only happens for normal REST/service calls.
            data["updated_at"] = updated_at_override
            return await super().update(
                id, data, bump_updated_at=False, record_event=record_event,
            )
        # Normal REST/service path: bump updated_at and version via BaseService.
        return await super().update(id, data, record_event=record_event)

    async def update(
        self, id: str, data: dict[str, Any],
        *, updated_at_override: str | None = None,
    ) -> Any:
        """Dispatch update: content goes to fs, the rest to DB.

        When *updated_at_override* is provided (sync_mode=True), the
        client timestamp is preserved across both content and metadata
        updates instead of being bumped to server-now.
        """
        data = dict(data)
        content = data.pop("content", None)
        obj = None
        if content is not None and data:
            obj = await self.update_content(
                id, content, updated_at_override=updated_at_override,
                record_event=False,
            )
            obj = await self.update_metadata(
                id, data, updated_at_override=updated_at_override,
                record_event=False,
            )
            if self.record_sync_events:
                payload = serialize_entity(obj)
                payload["content"] = content
                await record_sync_event(
                    self.db,
                    entity_type=self.entity_type,
                    entity_id=obj.id,
                    action="update",
                    payload=payload,
                )
        elif content is not None:
            obj = await self.update_content(
                id, content, updated_at_override=updated_at_override,
            )
        elif data:
            obj = await self.update_metadata(
                id, data, updated_at_override=updated_at_override,
            )
        if obj is None:
            obj = await self.get(id)
        return obj

    async def delete(self, id: str, *, hard: bool = False) -> None:
        """Delete note: soft-delete by default, hard-delete when requested.

        - REST default (``hard=False``, ``sync_mode=False``): sets
          ``trashed_at`` and moves the .md file to ``.trash/``. No
          tombstone is written -- the note can be restored. Idempotent.
        - ``hard=True`` or ``sync_mode=True``: removes the DB row, writes
          a tombstone (skipped in sync_mode -- the sync layer writes it),
          and best-effort deletes the .md file. Idempotent.

        DB delete and tombstone creation happen before FS deletion so
        that if FS fails, the DB state is still consistent (the orphan
        .md file is harmless and can be cleaned by a consistency check).
        """
        obj = await self.db.get(self.model, id)

        if self.sync_mode or hard:
            # Hard delete: DB delete + tombstone + FS best-effort.
            if obj is not None:
                await self.db.delete(obj)
                await self.db.flush()
            # M1: Create tombstone via BaseService helper (skipped in sync_mode).
            if not self.sync_mode:
                await self._ensure_tombstone(id)
            if obj is not None and self.record_sync_events:
                await record_sync_event(
                    self.db,
                    entity_type=self.entity_type,
                    entity_id=id,
                    action="delete",
                )
            # FS deletion is best-effort (orphan .md is harmless).
            try:
                await self.fs.delete_note(id)
            except (KeyError, FileNotFoundError):
                pass
            return

        # REST soft delete: set trashed_at + move .md to .trash/.
        # Idempotent: missing row or already-trashed row is a no-op.
        if obj is None:
            return
        if obj.trashed_at is not None:
            return
        obj.trashed_at = utc_now_iso()
        await self.db.flush()
        await self.fs.delete_note(id)
        await self.db.refresh(obj)
        if self.record_sync_events:
            await record_sync_event(
                self.db,
                entity_type=self.entity_type,
                entity_id=id,
                action="update",
                payload=serialize_entity(obj),
            )

    async def restore(self, id: str) -> Any:
        """Restore a soft-deleted note: clear ``trashed_at`` + move .md back.

        Raises ``NotFoundError`` if the note does not exist, or
        ``ValidationError`` if it is not in the trash. The filesystem
        ``restore`` may raise ``FileExistsError`` if the target path is
        occupied -- the route layer maps this to a 409 ConflictError.
        """
        obj = await self.get(id)  # raises NotFoundError if missing
        if obj.trashed_at is None:
            from app.errors import ValidationError

            raise ValidationError(f"Note {id} is not in trash")
        obj.trashed_at = None
        await self.db.flush()
        await self.fs.restore(id)
        await self.db.refresh(obj)
        if self.record_sync_events:
            payload = serialize_entity(obj)
            payload["content"] = await self.fs.read_note(id)
            await record_sync_event(
                self.db,
                entity_type=self.entity_type,
                entity_id=id,
                action="update",
                payload=payload,
            )
        return obj
