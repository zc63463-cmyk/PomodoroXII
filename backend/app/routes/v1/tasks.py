"""REST routes for tasks.

CRUD endpoints for the Task entity.  Uses ``TaskService`` which handles
tag list -> JSON serialisation, search-enabled listing, and idempotent
delete with tombstone creation.  Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.schemas.common import PaginatedResponse
from app.schemas.task import TaskCreate, TaskResponse, TaskUpdate
from app.services.task import TaskService

router = APIRouter()


@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(
    data: TaskCreate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Create a new task."""
    obj = await TaskService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get("", response_model=PaginatedResponse[TaskResponse])
async def list_tasks(
    status: str | None = Query(
        None, description="Filter by status: todo|in_progress|done|archived"
    ),
    priority: str | None = Query(
        None, description="Filter by priority: low|medium|high|urgent"
    ),
    search: str | None = Query(None, description="Case-insensitive search on title"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List tasks with optional status / priority / search filters."""
    filters: dict = {}
    if status is not None:
        filters["status"] = status
    if priority is not None:
        filters["priority"] = priority
    items, total = await TaskService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
        filters=filters or None,
        search=search,
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }


@router.get("/{id}", response_model=TaskResponse)
async def get_task(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single task by id."""
    return await TaskService(db).get(id)


@router.put("/{id}", response_model=TaskResponse)
async def update_task(
    id: str,
    data: TaskUpdate,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Update an existing task (partial update)."""
    obj = await TaskService(db).update(id, data.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{id}")
async def delete_task(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Delete a task (idempotent, records a tombstone for sync)."""
    await TaskService(db).delete(id)
    await db.commit()
    return {"message": "Deleted"}
