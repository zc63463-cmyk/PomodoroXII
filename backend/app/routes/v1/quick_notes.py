"""REST routes for quick notes (rapid capture).

CRUD endpoints for the QuickNote entity.  Uses an inline
``QuickNoteService(BaseService)`` subclass that serialises the ``tags``
list to a JSON string (matching the String column), excludes trashed
items from listings, and orders pinned notes first (then newest).
Writes use the durable mutation UoW; read-only endpoints use the query service.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import (
    entity_id_for_operation,
    expected_version_from_request,
    get_knowledge_store,
    get_operation_id,
    get_space_context,
    get_space_db,
    get_space_runtime_handle,
)
from app.errors import NotFoundError
from app.models.quick_note import QuickNote
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.quick_note import (
    QuickNoteConvertResponse,
    QuickNoteCreate,
    QuickNoteResponse,
    QuickNoteUpdate,
)
from app.services.quick_note import QuickNoteService

router = APIRouter()


@router.post("", response_model=QuickNoteResponse, status_code=201)
async def create_quick_note(
    data: QuickNoteCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a new quick note."""
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "quick_note")
    payload["tags"] = json.dumps(payload.get("tags", []))
    request = store.entity_commands.create(scope, "quick_note", payload, None)
    result = await store.uow.execute(scope, request, operation_id)
    return dict(result.value)


@router.post("/{id}/convert", response_model=QuickNoteConvertResponse)
async def convert_quick_note(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Convert a quick note into a full Note (transactional).

    Delegates to ``KnowledgeStore.convert_quick_note`` via the durable
    mutation pipeline, which creates the Note, archives the QuickNote,
    and copies memo_comments atomically.

    The original quick note row is kept (GET /{id} still 200) but excluded
    from GET /quick-notes listings. Repeated convert returns 409.
    """
    current = await db.get(QuickNote, id)
    if current is None:
        raise NotFoundError(f"QuickNote '{id}' not found")
    result = await store.convert_quick_note(
        scope,
        id,
        expected_version_from_request(request, current.version),
        operation_id,
    )
    return {
        "note_id": result.applied[0].value["id"],
        "quick_note_id": id,
        "migrated_comments_count": max(len(result.applied) - 2, 0),
    }


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
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update an existing quick note (partial update)."""
    current = await db.get(QuickNote, id)
    if current is None:
        raise NotFoundError(f"QuickNote '{id}' not found")
    patch = data.model_dump(exclude_unset=True)
    if isinstance(patch.get("tags"), list):
        patch["tags"] = json.dumps(patch["tags"])
    request_obj = store.entity_commands.update(
        scope,
        "quick_note",
        id,
        patch,
        expected_version_from_request(request, current.version),
    )
    result = await store.uow.execute(scope, request_obj, operation_id)
    return dict(result.value)


@router.delete("/{id}")
async def delete_quick_note(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Delete a quick note."""
    current = await db.get(QuickNote, id)
    if current is None:
        raise NotFoundError(f"QuickNote '{id}' not found")
    request_obj = store.entity_commands.delete(
        scope,
        "quick_note",
        id,
        expected_version_from_request(request, current.version),
    )
    await store.uow.execute(scope, request_obj, operation_id)
    return {"message": "Deleted"}
