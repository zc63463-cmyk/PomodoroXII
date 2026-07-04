"""REST routes for the recycle bin (trash).

Aggregated view across soft-deletable entity types (notes, folders, quick
notes) and hard-deleted entities (tasks, purged items) via tombstones.

- ``GET``        — list all trashed items across entity types + tombstones.
- ``POST /{entity_type}/{entity_id}/restore`` — un-trash a single item.
- ``DELETE /{entity_type}/{entity_id}``        — permanently purge an item
  (hard delete + sync tombstone).  Folders cascade to descendants.
- ``POST /cleanup`` — remove expired sync tombstones (older than TTL).

Uses ``TombstoneService`` (sync deletion tracking) and ``CascadeService``
(folder descendant traversal).  Routes commit; the services only flush.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.errors import NotFoundError, ValidationError
from app.models.folder import Folder
from app.models.note import Note
from app.models.quick_note import QuickNote
from app.models.tombstone import Tombstone
from app.registry import REGISTRY
from app.registry.resolve import resolve_model
from app.schemas.common import PaginatedResponse
from app.schemas.trash import TrashItemResponse
from app.services.cascade import CascadeService
from app.services.tombstone import TombstoneService

router = APIRouter()

# P2.5: derived from REGISTRY.list_soft_delete() — single source of truth.
# Maps entity_type (snake_case) -> ORM model class for soft-delete entities.
# Note: list_trash() still uses hardcoded SELECT per entity because each
# entity's title extraction logic differs (Note.title, Folder.name,
# QuickNote.content[:50]). YAGNI — refactor to TrashService only when
# a 4th soft-delete entity lands.
_ENTITY_MAP: dict[str, type] = {
    spec.name: resolve_model(spec)
    for spec in REGISTRY.list_soft_delete()
}


def _resolve_model(entity_type: str) -> type:
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
    """Remove sync tombstones older than the TTL and return the count purged."""
    removed = await TombstoneService(db).cleanup_expired()
    await db.commit()
    return {"message": "Cleanup complete", "removed": removed}


@router.post("/{entity_type}/{entity_id}/restore")
async def restore_item(
    entity_type: str,
    entity_id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Restore a trashed item by clearing its ``trashed_at`` timestamp."""
    model = _resolve_model(entity_type)
    obj = await db.get(model, entity_id)
    if obj is None:
        raise NotFoundError(f"{entity_type} '{entity_id}' not found")
    obj.trashed_at = None
    await db.flush()
    await db.commit()
    return {
        "message": "Restored",
        "entity_type": entity_type,
        "entity_id": entity_id,
    }


@router.delete("/{entity_type}/{entity_id}")
async def purge_item(
    entity_type: str,
    entity_id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Permanently delete a trashed item (hard delete + sync tombstone).

    For folders, descendant folders discovered via ``CascadeService`` are
    also hard-deleted and tombstoned.
    """
    model = _resolve_model(entity_type)
    obj = await db.get(model, entity_id)
    if obj is None:
        raise NotFoundError(f"{entity_type} '{entity_id}' not found")

    tomb_svc = TombstoneService(db)

    # Folders: cascade-purge descendants before removing the root.
    if entity_type == "folder":
        cascade = CascadeService(db)
        desc_ids = await cascade.get_descendant_ids(entity_id)
        if desc_ids:
            # Batch-load all descendants in one query (avoid N+1).
            desc_rows = (
                await db.execute(
                    select(Folder).where(Folder.id.in_(desc_ids))
                )
            ).scalars().all()
            for desc in desc_rows:
                await db.delete(desc)
                await tomb_svc.create("folder", desc.id)

    await db.delete(obj)
    await tomb_svc.create(entity_type, entity_id)
    await db.flush()
    await db.commit()
    return {
        "message": "Purged",
        "entity_type": entity_type,
        "entity_id": entity_id,
    }
