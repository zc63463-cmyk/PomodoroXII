"""REST routes for folders (virtual file system hierarchy).

CRUD endpoints for the Folder entity.  Uses an inline ``FolderService``
subclass of ``BaseService`` that excludes trashed folders from listings
and orders by ``sort_order`` then ``name``.  Deletion is a *soft* delete
performed by ``CascadeService.soft_delete_folder`` which trashes the
folder and all its descendants, and detaches contained notes / quick notes.
When a KnowledgeStore is available, the cascade soft-delete is routed
through the durable mutation pipeline.
Writes use the durable mutation UoW; read-only endpoints use the query service.
"""
from __future__ import annotations

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
from app.models.folder import Folder
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.folder import FolderCreate, FolderResponse, FolderUpdate
from app.services.folder import FolderService

router = APIRouter()


@router.post("", response_model=FolderResponse, status_code=201)
async def create_folder(
    data: FolderCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a new folder."""
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "folder")
    result = await store.create_folder(scope, payload, None, operation_id)
    return dict(result.value)


@router.get("", response_model=PaginatedResponse[FolderResponse])
async def list_folders(
    parent_id: str | None = Query(
        None, description="Filter by parent folder id (omit to list all levels)"
    ),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List non-trashed folders, optionally filtered by parent_id."""
    filters: dict = {}
    if parent_id is not None:
        filters["parent_id"] = parent_id
    items, total = await FolderService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
        filters=filters or None,
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }


@router.get("/{id}", response_model=FolderResponse)
async def get_folder(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single folder by id."""
    return await FolderService(db).get(id)


@router.put("/{id}", response_model=FolderResponse)
async def update_folder(
    id: str,
    data: FolderUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update an existing folder (partial update)."""
    current = await db.get(Folder, id)
    if current is None:
        raise NotFoundError(f"Folder '{id}' not found")
    result = await store.update_folder(
        scope,
        id,
        data.model_dump(exclude_unset=True),
        expected_version_from_request(request, current.version),
        operation_id,
    )
    return dict(result.value)


@router.delete("/{id}")
async def delete_folder(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Soft-delete a folder and all its descendants via cascade.

    System folders cannot be deleted (raises ValidationError).  Notes and
    quick notes inside the subtree are detached (folder_id set to None)
    so they remain visible as "unfiled".
    """
    current = await db.get(Folder, id)
    if current is None:
        raise NotFoundError(f"Folder '{id}' not found")
    result = await store.soft_delete_folder(
        scope,
        id,
        expected_version_from_request(request, current.version),
        operation_id,
    )
    return {"message": "Deleted", **dict(result.value)}
