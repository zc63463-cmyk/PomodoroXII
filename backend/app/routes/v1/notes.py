"""REST routes for notes.

Notes have a split storage model: metadata lives in the DB (Note model)
while the full Markdown body lives on the filesystem.  ``NoteService``
coordinates both stores and requires a ``FileSystem`` instance.

- ``POST`` writes the .md file then inserts the ORM row.
- ``GET /{id}`` returns metadata only (no content).
- ``GET /{id}/content`` returns the raw .md body as plain text.
- ``PUT`` dispatches content to the filesystem and the rest to the DB.
- ``DELETE`` removes both the .md file and the DB row (idempotent + tombstone).

Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context, get_file_system
from app.file_system.interfaces import FileSystem
from app.schemas.common import PaginatedResponse
from app.schemas.note import NoteCreate, NoteUpdate, NoteResponse
from app.services.note import NoteService

router = APIRouter()


@router.post("", response_model=NoteResponse, status_code=201)
async def create_note(
    data: NoteCreate,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Create a note: write the .md file via fs, then insert the ORM row."""
    obj = await NoteService(db, fs).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get("", response_model=PaginatedResponse[NoteResponse])
async def list_notes(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """List non-trashed notes (excludes items in the recycle bin)."""
    items, total = await NoteService(db, fs).list(
        offset=(page - 1) * per_page,
        limit=per_page,
        filters={"trashed_at": None},
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }


@router.get("/{id}", response_model=NoteResponse)
async def get_note(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Return note metadata by id (content is fetched separately)."""
    return await NoteService(db, fs).get(id)


@router.get("/{id}/content", response_class=PlainTextResponse)
async def get_note_content(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Return the raw Markdown body for a note as plain text."""
    content = await NoteService(db, fs).get_content(id)
    return content


@router.put("/{id}", response_model=NoteResponse)
async def update_note(
    id: str,
    data: NoteUpdate,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Update a note: content goes to the filesystem, metadata to the DB."""
    obj = await NoteService(db, fs).update(id, data.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{id}")
async def delete_note(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Delete a note from both fs and DB (idempotent, records a tombstone)."""
    await NoteService(db, fs).delete(id)
    await db.commit()
    return {"message": "Deleted"}
