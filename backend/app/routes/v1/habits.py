"""REST routes for habits and habit check-ins.

CRUD endpoints for the Habit entity plus nested check-in sub-resources.
Uses inline ``HabitService`` and ``HabitCheckInService`` subclasses of
``BaseService``.  ``HabitService`` serialises the ``rest_days`` list to a
JSON string before persisting (the column is a String).  Check-ins are
scoped under ``/{habit_id}/check-ins``.
Writes use the durable mutation UoW; read-only endpoints use the query services.
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
from app.models.habit import Habit
from app.runtime.space import SpaceRuntimeHandle
from app.schemas.common import PaginatedResponse
from app.schemas.habit import HabitCreate, HabitResponse, HabitUpdate
from app.schemas.habit_check_in import (
    HabitCheckInCreate,
    HabitCheckInResponse,
)
from app.services.habit import HabitCheckInService, HabitService

router = APIRouter()


# --------------------------------------------------------------------------- #
# Habit CRUD
# --------------------------------------------------------------------------- #
@router.post("", response_model=HabitResponse, status_code=201)
async def create_habit(
    data: HabitCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Create a new habit."""
    import json
    payload = data.model_dump()
    payload["id"] = payload.get("id") or entity_id_for_operation(operation_id, "habit")
    payload["rest_days"] = json.dumps(payload.get("rest_days", []))
    result = await store.uow.execute(
        scope, store.entity_commands.create(scope, "habit", payload, None), operation_id
    )
    return dict(result.value)


@router.get("", response_model=PaginatedResponse[HabitResponse])
async def list_habits(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List all habits ordered by sort_order."""
    items, total = await HabitService(db).list(
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


@router.get("/{id}", response_model=HabitResponse)
async def get_habit(
    id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return a single habit by id."""
    return await HabitService(db).get(id)


@router.put("/{id}", response_model=HabitResponse)
async def update_habit(
    id: str,
    data: HabitUpdate,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Update an existing habit (partial update)."""
    import json
    current = await db.get(Habit, id)
    if current is None:
        raise NotFoundError(f"Habit '{id}' not found")
    patch = data.model_dump(exclude_unset=True)
    if "rest_days" in patch:
        patch["rest_days"] = json.dumps(patch["rest_days"])
    result = await store.uow.execute(
        scope,
        store.entity_commands.update(
            scope, "habit", id, patch,
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return dict(result.value)


@router.delete("/{id}")
async def delete_habit(
    id: str,
    request: Request,
    db: AsyncSession = Depends(get_space_db),
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Delete a habit."""
    current = await db.get(Habit, id)
    if current is None:
        raise NotFoundError(f"Habit '{id}' not found")
    await store.uow.execute(
        scope,
        store.entity_commands.delete(
            scope, "habit", id,
            expected_version_from_request(request, current.version),
        ),
        operation_id,
    )
    return {"message": "Deleted"}


# --------------------------------------------------------------------------- #
# Habit check-ins (nested under /{habit_id}/check-ins)
# --------------------------------------------------------------------------- #
@router.post(
    "/{habit_id}/check-ins",
    response_model=HabitCheckInResponse,
    status_code=201,
)
async def create_check_in(
    habit_id: str,
    data: HabitCheckInCreate,
    store=Depends(get_knowledge_store),
    scope: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
    operation_id: str = Depends(get_operation_id),
):
    """Record a check-in for the given habit (path habit_id is authoritative)."""
    payload = data.model_dump()
    payload["habit_id"] = habit_id
    payload["id"] = payload.get("id") or entity_id_for_operation(
        operation_id, "habit_check_in"
    )
    result = await store.uow.execute(
        scope,
        store.entity_commands.create(scope, "habit_check_in", payload, None),
        operation_id,
    )
    return dict(result.value)


@router.get(
    "/{habit_id}/check-ins",
    response_model=PaginatedResponse[HabitCheckInResponse],
)
async def list_check_ins(
    habit_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """List check-ins for a habit (newest date first)."""
    items, total = await HabitCheckInService(db).list(
        offset=(page - 1) * per_page,
        limit=per_page,
        filters={"habit_id": habit_id},
    )
    return {
        "items": items,
        "total": total,
        "limit": per_page,
        "offset": (page - 1) * per_page,
        "has_more": ((page - 1) * per_page + len(items)) < total,
    }
