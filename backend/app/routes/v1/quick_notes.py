"""REST routes for quick notes (rapid capture).

CRUD endpoints for the QuickNote entity.  Uses an inline
``QuickNoteService(BaseService)`` subclass that serialises the ``tags``
list to a JSON string (matching the String column), excludes trashed
items from listings, and orders pinned notes first (then newest).
Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_file_system, get_space_context, get_space_db
from app.file_system.interfaces import FileSystem
from app.schemas.common import PaginatedResponse
from app.schemas.quick_note import (
    QuickNoteConvertResponse,
    QuickNoteCreate,
    QuickNoteResponse,
    QuickNoteUpdate,
)
from app.services.note import NoteService
from app.services.quick_note import QuickNoteService

router = APIRouter()


@router.post("", response_model=QuickNoteResponse, status_code=201)
async def create_quick_note(
    data: QuickNoteCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new quick note."""
    obj = await QuickNoteService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


@router.post("/{id}/convert", response_model=QuickNoteConvertResponse)
async def convert_quick_note(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Convert a quick note into a full Note (transactional).

    - Creates a Note with the quick note's content/tags/folder_id.
    - Marks the quick note as archived (``archived_at`` + ``migrated_to_note_id``).
    - Copies ``memo_comments`` rows to the new Note.

    The original quick note row is kept (GET /{id} still 200) but excluded
    from GET /quick-notes listings. Repeated convert returns 409.
    """
    note_svc = NoteService(db, fs)
    result = await QuickNoteService(db).convert(id, note_service=note_svc)
    await db.commit()
    return result


@router.get("", response_model=PaginatedResponse[QuickNoteResponse])
async def list_quick_notes(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List non-trashed quick notes (pinned first, then newest)."""
    items, total = await QuickNoteService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }


@router.get("/{id}", response_model=QuickNoteResponse)
async def get_quick_note(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single quick note by id."""
    return await QuickNoteService(db).get(id)


@router.put("/{id}", response_model=QuickNoteResponse)
async def update_quick_note(
    id: str,
    data: QuickNoteUpdate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Update an existing quick note (partial update)."""
    obj = await QuickNoteService(db).update(id, data.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{id}")
async def delete_quick_note(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a quick note."""
    await QuickNoteService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}
