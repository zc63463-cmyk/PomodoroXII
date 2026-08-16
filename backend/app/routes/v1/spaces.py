"""Space management routes: create, list, get, issue tokens, and health.

All routes require a *master* token (``require_master_token``) except
``GET /{space_id}/health`` which requires a *space* token scoped to that
exact space.  Space health uses the real ``SpaceRuntime.health()`` API; a
degraded Space returns 503 without affecting other Spaces or global
readiness.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import create_space_token
from app.db.models.meta import Space
from app.deps import (
    get_meta_db,
    get_space_context,
    get_space_runtime,
    get_space_runtime_handle,
    require_master_token,
)
from app.errors import NotFoundError, SpaceRecoveryRequiredError
from app.runtime.space import SpaceProvisionSpec, SpaceRuntime
from app.schemas.space import SpaceResponse, SpaceTokenResponse

router = APIRouter()


class SpaceCreateRequest(BaseModel):
    """Request body for space creation."""

    name: str


class SpaceHealthResponse(BaseModel):
    """Health status for a single Space (bounded, non-secret fields)."""

    space_id: str
    available: bool
    migration_head: str
    index_schema_version: int
    catalog_hash: str
    degraded_reason: str | None = None


def _space_to_dict(space: Space) -> dict[str, Any]:
    """Serialise a Space ORM object to a plain dict."""
    return {
        "id": space.id,
        "name": space.name,
        "db_path": space.db_path,
        "notes_dir": space.notes_dir,
        "is_default": space.is_default,
        "created_at": space.created_at,
        "updated_at": space.updated_at,
    }


@router.post("", status_code=201, response_model=SpaceResponse)
async def create_space(
    body: SpaceCreateRequest,
    user: dict = Depends(require_master_token),
    runtime: SpaceRuntime = Depends(get_space_runtime),
) -> dict:
    """Provision a Space before publishing its Meta registration."""
    spec = SpaceProvisionSpec(space_id=uuid.uuid4().hex, name=body.name)
    handle = await runtime.provision(spec)
    async with handle:
        space = await runtime.get_registered(spec.space_id)
    if space is None:
        raise NotFoundError("Space is not registered")
    return _space_to_dict(space)


@router.get("", response_model=list[SpaceResponse])
async def list_spaces(
    user: dict = Depends(require_master_token),
    db: AsyncSession = Depends(get_meta_db),
) -> list[dict]:
    """List all registered spaces."""
    result = await db.execute(select(Space))
    spaces = result.scalars().all()
    return [_space_to_dict(s) for s in spaces]


@router.get("/{space_id}", response_model=SpaceResponse)
async def get_space(
    space_id: str,
    user: dict = Depends(require_master_token),
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    """Return a single space by id (404 if not found)."""
    result = await db.execute(select(Space).where(Space.id == space_id))
    space = result.scalar_one_or_none()
    if space is None:
        raise NotFoundError(f"Space {space_id} not found")
    return _space_to_dict(space)


@router.post("/{space_id}/token", response_model=SpaceTokenResponse)
async def issue_space_token(
    space_id: str,
    user: dict = Depends(require_master_token),
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    """Issue a space-scoped JWT for the given space.

    The ``user_id`` embedded in the space token is taken from the
    master token's ``sub`` claim.
    """
    result = await db.execute(select(Space).where(Space.id == space_id))
    space = result.scalar_one_or_none()
    if space is None:
        raise NotFoundError(f"Space {space_id} not found")

    user_id = str(user["sub"])
    return {
        "space_token": create_space_token(space_id, user_id, epoch=int(user["epoch"])),
        "token_type": "bearer",
    }


@router.get("/{space_id}/health", response_model=SpaceHealthResponse)
async def space_health(
    space_id: str,
    ctx: dict = Depends(get_space_context),
    handle: Any = Depends(get_space_runtime_handle),
    runtime: SpaceRuntime = Depends(get_space_runtime),
) -> dict:
    """Return one Space's health using the real ``SpaceRuntime.health()``.

    The space token must be scoped to this exact Space; a degraded Space
    yields 503 (``space_recovery_required``) but never affects other Spaces
    or the global ``/api/ready`` endpoint.  The runtime handle dependency
    closes the request-owned resources on exit.
    """
    if ctx["space_id"] != space_id:
        raise NotFoundError(f"Space {space_id} not found")
    result = await runtime.health(ctx["scope_result"])
    if not result.available:
        raise SpaceRecoveryRequiredError()
    return {
        "space_id": result.space_id,
        "available": True,
        "migration_head": result.migration_head,
        "index_schema_version": result.index_schema_version,
        "catalog_hash": result.catalog_hash,
        "degraded_reason": None,
    }
