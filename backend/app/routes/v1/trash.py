"""REST routes for the recycle bin (trash).

Aggregated view across soft-deletable entity types (notes, folders, quick
notes) and hard-deleted entities (tasks, purged items) via tombstones.

- ``GET``        — list all trashed items across entity types + tombstones.
- ``POST /{entity_type}/{entity_id}/restore`` — un-trash a single item.
- ``DELETE /{entity_type}/{entity_id}``        — permanently purge an item
  (hard delete + sync tombstone).  Folders cascade to descendants.
- ``POST /cleanup`` — fail closed until client ACK retention exists.

Restore and purge operations delegate to ``KnowledgeStore``, which routes
writes through the durable mutation pipeline (journal + UoW + projections).
For notes, filesystem ``.trash/`` coordination is best-effort after the
durable DB commit.

Uses ``TombstoneService`` (sync deletion tracking). Writes use the durable
mutation UoW; the cleanup compatibility route rejects unsafe retention.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import (
    expected_version_from_request,
    get_file_system,
    get_knowledge_store,
    get_operation_id,
    get_space_context,
    get_space_db,
    get_space_runtime_handle,
)
from app.errors import NotFoundError, ValidationError
from app.file_system.interfaces import FileSystem
from app.models.folder import Folder
from app.models.note import Note
from app.models.quick_note import QuickNote
from app.models.tombstone import Tombstone
from app.registry import CATALOG
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.trash import TrashItemResponse
from app.services.tombstone import TombstoneService

router = APIRouter()

# P2.5: derived from the startup-frozen catalog — single source of truth.
# Maps entity_type (snake_case) -> ORM model class for soft-delete entities.
# Note: list_trash() still uses hardcoded SELECT per entity because each
# entity's title extraction logic differs (Note.title, Folder.name,
# QuickNote.content[:50]). YAGNI — refactor to TrashService only when
# a 4th soft-delete entity lands.
_ENTITY_MAP: dict[str, type] = {
    spec.name: CATALOG.model_for(spec.name)
    for spec in CATALOG.list_soft_delete()
}


def _catalog_model_for(entity_type: str) -> type:
    """Return the ORM model class for *entity_type* or raise ValidationError."""
    model = _ENTITY_MAP.get(entity_type)
    if model is None:
        raise ValidationError(f"Unknown entity type: {entity_type!r}")
    return model


@router.get("", response_model=PaginatedResponse[TrashItemResponse])
async def list_trash(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List all trashed items across notes, folders, and quick notes."""
    items: list[dict] = []

    # Notes
    res = await db.execute(select(Note).where(Note.trashed_at.is_not(None)))
    for n in res.scalars().all():
        items.append(
            {
                "entity_type": "note",
                "entity_id": n.id,
                "title": n.title or "(untitled)",
                "deleted_at": n.trashed_at,
            }
        )

    # Folders
    res = await db.execute(select(Folder).where(Folder.trashed_at.is_not(None)))
    for f in res.scalars().all():
        items.append(
            {
                "entity_type": "folder",
                "entity_id": f.id,
                "title": f.name,
                "deleted_at": f.trashed_at,
            }
        )

    # Quick notes (use a truncated content snippet as the display title)
    res = await db.execute(
        select(QuickNote).where(QuickNote.trashed_at.is_not(None))
    )
    for q in res.scalars().all():
        snippet = (q.content or "").strip()
        items.append(
            {
                "entity_type": "quick_note",
                "entity_id": q.id,
                "title": snippet[:50] if snippet else "(empty)",
                "deleted_at": q.trashed_at,
            }
        )

    # Tombstones — hard-deleted entities (tasks, purged notes/folders).
    # These have no trashed_at column; the tombstone is the only record.
    res = await db.execute(select(Tombstone))
    for t in res.scalars().all():
        items.append(
            {
                "entity_type": t.entity_type,
                "entity_id": t.entity_id,
                "title": f"(deleted {t.entity_type})",
                "deleted_at": t.deleted_at,
            }
        )

    total = len(items)
    offset = (page - 1) * per_page
    paged = items[offset : offset + per_page]
    return {
        "items": paged,
        "total": total,
        "limit": per_page,
        "offset": offset,
        "has_more": (offset + len(paged)) < total,
    }


@router.post("/cleanup")
async def cleanup_expired(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Retain the compatibility route while S1 rejects unsafe cleanup."""
    removed = await TombstoneService(db).cleanup_expired()
    return {"message": "Cleanup complete", "removed": removed}


@router.post("/{entity_type}/{entity_id}/restore")
async def restore_item(
    entity_type: str,
    entity_id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
    store: Any = Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Restore a trashed item via the durable mutation pipeline.

    Notes, folders, and quick notes all clear ``trashed_at`` through
    the KnowledgeStore, which handles DB update, sync events, and
    projections atomically.  For notes, the filesystem ``.trash/``
    file is moved back best-effort after the durable commit.
    """
    if entity_type == "note":
        obj = await db.get(Note, entity_id)
        if obj is None:
            raise NotFoundError(f"note '{entity_id}' not found")
        if obj.trashed_at is None:
            raise ValidationError(
                f"note '{entity_id}' is not trashed; refuse to restore"
            )
        await store.restore_note(
            scope, entity_id,
            expected_version_from_request(request, obj.version),
            operation_id,
        )
        # Best-effort FS restore (orphan .trash/ file is harmless).
        # The durable pipeline may have already restored the FS state
        # (is_deleted=0, .md moved back), so ValueError is expected.
        try:
            await fs.restore(entity_id)
        except (FileNotFoundError, FileExistsError, KeyError, ValueError):
            pass
        return {
            "message": "Restored",
            "entity_type": entity_type,
            "entity_id": entity_id,
        }

    if entity_type == "folder":
        obj = await db.get(Folder, entity_id)
        if obj is None:
            raise NotFoundError(f"folder '{entity_id}' not found")
        if obj.trashed_at is None:
            raise ValidationError(
                f"folder '{entity_id}' is not trashed; refuse to restore"
            )
        await store.restore_folder(
            scope, entity_id,
            expected_version_from_request(request, obj.version),
            operation_id,
        )
        return {
            "message": "Restored",
            "entity_type": entity_type,
            "entity_id": entity_id,
        }

    if entity_type == "quick_note":
        obj = await db.get(QuickNote, entity_id)
        if obj is None:
            raise NotFoundError(f"quick_note '{entity_id}' not found")
        if obj.trashed_at is None:
            raise ValidationError(
                f"quick_note '{entity_id}' is not trashed; refuse to restore"
            )
        await store.restore_quick_note(
            scope, entity_id,
            expected_version_from_request(request, obj.version),
            operation_id,
        )
        return {
            "message": "Restored",
            "entity_type": entity_type,
            "entity_id": entity_id,
        }

    # Unknown entity type — derive model from catalog (raises ValidationError).
    _catalog_model_for(entity_type)
    raise ValidationError(f"{entity_type!r} does not support restore")


@router.delete("/{entity_type}/{entity_id}")
async def purge_item(
    entity_type: str,
    entity_id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
    store: Any = Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Permanently delete a trashed item via the durable mutation pipeline.

    Notes and folders are purged through the KnowledgeStore, which
    handles DB deletion, tombstone creation, sync events, and
    projections atomically.  Filesystem cleanup for notes is
    best-effort after the durable commit.
    """
    if entity_type == "note":
        obj = await db.get(Note, entity_id)
        if obj is None:
            raise NotFoundError(f"note '{entity_id}' not found")
        if obj.trashed_at is None:
            raise ValidationError(
                f"note '{entity_id}' is not trashed; refuse to purge"
            )
        await store.purge_note(
            scope, entity_id,
            expected_version_from_request(request, obj.version),
            operation_id,
        )
        # Best-effort FS cleanup (orphan .trash/ file is harmless).
        try:
            await fs.purge(entity_id)
        except (KeyError, FileNotFoundError):
            pass
        return {
            "message": "Purged",
            "entity_type": entity_type,
            "entity_id": entity_id,
        }

    if entity_type == "folder":
        obj = await db.get(Folder, entity_id)
        if obj is None:
            raise NotFoundError(f"folder '{entity_id}' not found")
        if obj.trashed_at is None:
            raise ValidationError(
                f"folder '{entity_id}' is not trashed; refuse to purge"
            )
        await store.purge_folder(
            scope, entity_id,
            expected_version_from_request(request, obj.version),
            operation_id,
        )
        return {
            "message": "Purged",
            "entity_type": entity_type,
            "entity_id": entity_id,
        }

    if entity_type == "quick_note":
        obj = await db.get(QuickNote, entity_id)
        if obj is None:
            raise NotFoundError(f"quick_note '{entity_id}' not found")
        await store.uow.execute(
            scope,
            store.entity_commands.delete(
                scope,
                "quick_note",
                entity_id,
                expected_version_from_request(request, obj.version),
            ),
            operation_id,
        )
        return {
            "message": "Purged",
            "entity_type": entity_type,
            "entity_id": entity_id,
        }

    # Unknown entity type — derive model from catalog (raises ValidationError).
    _catalog_model_for(entity_type)
    raise ValidationError(f"{entity_type!r} does not support purge")
