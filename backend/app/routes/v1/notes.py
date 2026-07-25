"""REST routes for notes.

Notes have a split storage model: metadata lives in the DB (Note model)
while the full Markdown body lives on the filesystem.  ``NoteService``
coordinates both stores and requires a ``FileSystem`` instance.

- ``POST`` writes the .md file then inserts the ORM row.
- ``GET /{id}`` returns metadata only (no content).
- ``GET /{id}/content`` returns the raw .md body as plain text.
- ``PATCH /{id}`` updates metadata only (DB-only, does NOT write .md).
- ``PUT /{id}/content`` rewrites the .md body and updates content_hash.
- ``PUT /{id}`` (deprecated) dispatches content to fs + metadata to DB.
- ``DELETE`` soft-deletes: sets trashed_at + moves .md to .trash/ (idempotent, no tombstone). Use DELETE /trash/note/{id} to purge.

Writes use the durable mutation UoW; read-only endpoints use the query service.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import (
    entity_id_for_operation,
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
from app.models.note import Note
from app.routes.v1.responses import PLAIN_TEXT_VALIDATION_ERROR_RESPONSES
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.note import (
    NoteCreate,
    NoteMetadataUpdate,
    NoteResponse,
    NoteSearchResultItem,
    NoteUpdate,
    VersionRecordResponse,
)
from app.services.note import NoteService
from app.services.time import utc_now_iso_ms

router = APIRouter()


@router.post("", response_model=NoteResponse, status_code=201)
async def create_note(
    data: NoteCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a note: write the .md file via fs, then insert the ORM row."""
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "note")
    result = await store.create_note(scope, payload, None, operation_id)
    return dict(result.value)


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


@router.get("/search", response_model=list[NoteSearchResultItem])
async def search_notes(
    q: str = Query(..., min_length=1, description="搜索关键词"),
    limit: int = Query(20, ge=1, le=100),
    folder_id: str | None = Query(None),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full-text search across notes (FTS5 with LIKE fallback for short queries)."""
    query = q.strip()
    if not query:
        raise ValidationError("q must not be empty")
    if folder_id:
        results = await fs.search_in_folder(folder_id, query, limit=limit)
    else:
        results = await fs.search(query, limit=limit)
    return [
        NoteSearchResultItem(
            note_id=r.note_id,
            title=r.title,
            folder_id=r.folder_id,
            excerpt=r.excerpt,
            score=r.score,
        )
        for r in results
    ]


@router.get(
    "/{id}/content",
    response_class=PlainTextResponse,
    responses=PLAIN_TEXT_VALIDATION_ERROR_RESPONSES,
)
async def get_note_content(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Return the raw Markdown body for a note as plain text."""
    content = await NoteService(db, fs).get_content(id)
    return content


@router.get("/{id}/versions", response_model=list[VersionRecordResponse])
async def list_note_versions(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """List version history backups for a note (newest first)."""
    # Validate the note exists (raises NotFoundError via BaseService.get).
    await NoteService(db, fs).get(id)
    return await fs.list_versions(id)


@router.get(
    "/{id}/versions/{version_id}",
    response_class=PlainTextResponse,
    responses=PLAIN_TEXT_VALIDATION_ERROR_RESPONSES,
)
async def get_note_version(
    id: str,
    version_id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Fetch a specific version's plain-text content (the prior .md body)."""
    # Validate the note exists.
    await NoteService(db, fs).get(id)
    try:
        return await fs.get_version(id, version_id)
    except (KeyError, FileNotFoundError) as exc:
        raise NotFoundError(str(exc)) from exc


@router.put("/{id}/content", response_model=NoteResponse)
async def update_note_content(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Replace the .md body for a note.

    Updates ``content_hash`` and ``word_count`` on the DB row. Accepts
    either ``application/json`` (``{"content": "..."}``) or ``text/plain``
    (raw body).
    """
    content_type = request.headers.get("content-type", "").lower()
    if "application/json" in content_type:
        payload = await request.json()
        if not isinstance(payload, dict) or "content" not in payload:
            raise ValidationError("JSON body must be an object with a 'content' field")
        content = payload["content"]
    else:
        # text/plain or other -- read raw body and decode as UTF-8.
        raw = await request.body()
        content = raw.decode("utf-8", errors="replace")
    if not isinstance(content, str):
        raise ValidationError("'content' must be a string")
    if len(content) > 100000:
        raise ValidationError("content exceeds max length 100000")

    try:
        current = await db.get(Note, id)
        if current is None:
            raise NotFoundError(f"Note {id} not found")
        result = await store.update_note_content(
            scope,
            id,
            content,
            expected_version_from_request(request, current.version),
            operation_id,
        )
    except (KeyError, FileNotFoundError) as exc:
        raise NotFoundError(f"Note {id} not found") from exc
    return dict(result.value)


@router.patch("/{id}", response_model=NoteResponse)
async def update_note_metadata(
    id: str,
    data: NoteMetadataUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update note metadata (title/tags/etc) -- does NOT write the .md file.

    Content-managed fields (content_hash, word_count) are intentionally
    not accepted here; use ``PUT /{id}/content`` to rewrite the body.
    """
    current = await db.get(Note, id)
    if current is None:
        raise NotFoundError(f"Note {id} not found")
    result = await store.update_note_metadata(
        scope,
        id,
        data.model_dump(exclude_unset=True),
        expected_version_from_request(request, current.version),
        operation_id,
    )
    return dict(result.value)


@router.get("/{id}", response_model=NoteResponse)
async def get_note(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Return note metadata by id (content is fetched separately)."""
    return await NoteService(db, fs).get(id)


@router.put("/{id}", response_model=NoteResponse, deprecated=True)
async def update_note(
    id: str,
    data: NoteUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """[Deprecated] Update a note via the legacy dispatcher.

    Prefer ``PATCH /{id}`` for metadata + ``PUT /{id}/content`` for content.
    This route is kept for backward compatibility and will be removed in the
    next major.
    """
    current = await db.get(Note, id)
    if current is None:
        raise NotFoundError(f"Note {id} not found")
    result = await store.update_note(
        scope,
        id,
        data.model_dump(exclude_unset=True),
        expected_version_from_request(request, current.version),
        operation_id,
    )
    return dict(result.value)


@router.delete("/{id}")
async def delete_note(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Soft-delete a note: set trashed_at + move .md to .trash/ (idempotent, no tombstone)."""
    current = await db.get(Note, id)
    if current is None:
        raise NotFoundError(f"Note {id} not found")
    await store.update_note(
        scope,
        id,
        {"trashed_at": utc_now_iso_ms()},
        expected_version_from_request(request, current.version),
        operation_id,
    )
    return {"message": "Deleted"}
