"""REST routes for folders (virtual file system hierarchy).

CRUD endpoints for the Folder entity.  Uses an inline ``FolderService``
subclass of ``BaseService`` that excludes trashed folders from listings
and orders by ``sort_order`` then ``name``.  Deletion is a *soft* delete
performed by ``CascadeService.soft_delete_folder`` which trashes the
folder and all its descendants, and detaches contained notes / quick notes.
Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.schemas.common import PaginatedResponse
from app.schemas.folder import FolderCreate, FolderUpdate, FolderResponse
from app.services.cascade import CascadeService
from app.services.folder import FolderService

router = APIRouter()


@router.post("", response_model=FolderResponse, status_code=201)
async def create_folder(
    data: FolderCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new folder."""
    obj = await FolderService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


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
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Update an existing folder (partial update)."""
    obj = await FolderService(db).update(id, data.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{id}")
async def delete_folder(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Soft-delete a folder and all its descendants via cascade.

    System folders cannot be deleted (raises ValidationError).  Notes and
    quick notes inside the subtree are detached (folder_id set to None)
    so they remain visible as "unfiled".
    """
    result = await CascadeService(db).soft_delete_folder(id)
    await db.commit()
    return {"message": "Deleted", **result}
