"""Space management routes: create, list, get, and issue space tokens.

All routes require a *master* token (``require_master_token``) and
operate on the *meta* database (``get_meta_db``).
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import create_space_token
from app.db.models.meta import Space
from app.deps import require_master_token, get_meta_db
from app.errors import NotFoundError
from app.settings import settings

router = APIRouter()


class SpaceCreateRequest(BaseModel):
    """Request body for space creation."""

    name: str


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


@router.post("", status_code=201)
async def create_space(
    body: SpaceCreateRequest,
    user: dict = Depends(require_master_token),
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    """Create a new space: insert a row, create directories, commit."""
    space_id = uuid.uuid4().hex
    db_path = str(settings.space_db_path(space_id))
    notes_dir = str(settings.space_notes_dir(space_id))

    # Ensure the directories exist on disk.
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    Path(notes_dir).mkdir(parents=True, exist_ok=True)

    space = Space(
        id=space_id,
        name=body.name,
        db_path=db_path,
        notes_dir=notes_dir,
    )
    db.add(space)
    await db.commit()
    await db.refresh(space)
    return _space_to_dict(space)


@router.get("")
async def list_spaces(
    user: dict = Depends(require_master_token),
    db: AsyncSession = Depends(get_meta_db),
) -> list[dict]:
    """List all registered spaces."""
    result = await db.execute(select(Space))
    spaces = result.scalars().all()
    return [_space_to_dict(s) for s in spaces]


@router.get("/{space_id}")
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


@router.post("/{space_id}/token")
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
        "space_token": create_space_token(space_id, user_id),
        "token_type": "bearer",
    }
