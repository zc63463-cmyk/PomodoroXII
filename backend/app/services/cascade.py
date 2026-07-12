"""CascadeService — BFS descendant traversal and cascade soft-delete.

Does NOT import FastAPI.  Only flushes, never commits.
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError, ValidationError
from app.services.serializers import serialize_entity
from app.services.sync_outbox import record_sync_event
from app.services.time import utc_now_iso


class CascadeService:
    """Handle cascading deletions across the folder tree and junction tables."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_descendant_ids(self, folder_id: str) -> list[str]:
        """BFS-collect all descendant folder ids (including trashed).

        Trashed subtrees are skipped during traversal (their children
        are not visited) to prevent resurrecting already-deleted folders.
        A ``visited`` set guards against circular references.
        """
        from app.models.folder import Folder

        descendants: list[str] = []
        visited: set[str] = set()
        queue: list[str] = [folder_id]
        while queue:
            current = queue.pop()
            if current in visited:
                continue
            visited.add(current)
            # Collect ALL children (including trashed) as descendants.
            res = await self.db.execute(
                select(Folder.id, Folder.trashed_at).where(
                    Folder.parent_id == current,
                )
            )
            rows = res.all()
            for child_id, trashed_at in rows:
                descendants.append(child_id)
                # Only traverse into non-trashed children's subtrees.
                if trashed_at is None and child_id not in visited:
                    queue.append(child_id)
        return descendants

    async def soft_delete_folder(self, folder_id: str) -> dict:
        """Soft-delete a folder and all its descendants.

        - Sets ``trashed_at`` on the folder and every non-trashed descendant.
        - Clears ``folder_id`` on notes and quick_notes in the subtree
          (they become "unfiled" but remain visible).
        - Raises ``NotFoundError`` if the folder does not exist.
        - Raises ``ValidationError`` if the folder is a system folder.
        """
        from app.models.folder import Folder
        from app.models.note import Note
        from app.models.quick_note import QuickNote

        folder = await self.db.get(Folder, folder_id)
        if folder is None:
            raise NotFoundError(f"Folder '{folder_id}' not found")
        if folder.is_system:
            raise ValidationError("System folder cannot be deleted")

        now = utc_now_iso()
        desc_ids = await self.get_descendant_ids(folder_id)
        all_ids = [folder_id, *desc_ids]

        # Trash descendants that are not already trashed (batch query).
        if desc_ids:
            res = await self.db.execute(
                select(Folder).where(Folder.id.in_(desc_ids))
            )
            for desc in res.scalars().all():
                if desc.trashed_at is None:
                    desc.trashed_at = now
                    desc.updated_at = now

        # Trash the root folder.
        folder.trashed_at = now
        folder.updated_at = now

        notes = (
            await self.db.execute(select(Note).where(Note.folder_id.in_(all_ids)))
        ).scalars().all()
        quick_notes = (
            await self.db.execute(
                select(QuickNote).where(QuickNote.folder_id.in_(all_ids))
            )
        ).scalars().all()
        for note in notes:
            note.folder_id = None
            note.updated_at = now
        for quick_note in quick_notes:
            quick_note.folder_id = None
            quick_note.updated_at = now

        await self.db.flush()
        changed_folders = [folder]
        if desc_ids:
            changed_folders.extend(
                row
                for row in (
                    await self.db.execute(select(Folder).where(Folder.id.in_(desc_ids)))
                ).scalars().all()
                if row.trashed_at == now
            )
        for changed in [*changed_folders, *notes, *quick_notes]:
            entity_type = (
                "folder" if isinstance(changed, Folder)
                else "note" if isinstance(changed, Note)
                else "quickNote"
            )
            await record_sync_event(
                self.db,
                entity_type=entity_type,
                entity_id=changed.id,
                action="update",
                payload=serialize_entity(changed),
            )
        return {"trashed_folder_ids": all_ids}

    async def delete_task_cascade(self, task_id: str) -> None:
        """Hard-delete a task and its junction rows in task_quick_notes.

        This is a hard delete (not soft) because tasks do not have
        ``trashed_at``.  Tombstone creation is the caller's responsibility.
        """
        from app.models.task import Task
        from app.models.task_quick_note import TaskQuickNote

        task = await self.db.get(Task, task_id)
        if task is not None:
            await self.db.execute(
                delete(TaskQuickNote).where(TaskQuickNote.task_id == task_id)
            )
            await self.db.delete(task)
            await self.db.flush()
