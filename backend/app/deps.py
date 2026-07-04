"""FastAPI dependency providers for auth, DB sessions, and filesystem.

Token model:
- ``type == "master"`` → meta-layer access (spaces, global settings).
- ``type == "space"``  → access scoped to a single ``space_id``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

import jwt
from fastapi import Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import decode_access_token
from app.errors import AuthenticationError, AuthorizationError
from app.logging import request_id_var  # noqa: F401  (re-exported for convenience)
from app.space_manager import get_space_engine_manager

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
async def get_current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Decode the Bearer token and return its payload.

    Raises ``AuthenticationError`` if the header is missing/malformed or
    the token is invalid/expired.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthenticationError("Missing or invalid Authorization header")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
    except jwt.PyJWTError as exc:
        raise AuthenticationError("Invalid or expired token") from exc

    if "sub" not in payload or "type" not in payload:
        raise AuthenticationError("Malformed token payload")
    return payload


async def require_master_token(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Ensure the token is a master token (meta-layer access)."""
    if user.get("type") != "master":
        raise AuthorizationError("Master token required")
    return user


async def get_space_context(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Ensure the token is a space token and return its context.

    Returns ``{"space_id": ..., "user_id": ...}``.

    Verifies the space_id actually points at an existing Space row in the
    meta DB so forged tokens (or tokens pointing at deleted spaces) are
    rejected early instead of failing later with confusing errors.
    """
    if user.get("type") != "space":
        raise AuthorizationError("Space token required")
    space_id = user.get("space_id")
    if not space_id:
        raise AuthenticationError("Space token missing space_id")

    # Verify the space actually exists in the meta DB.
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space

    async for session in get_meta_session():
        exists = await session.get(Space, str(space_id))
        break

    if exists is None:
        raise AuthenticationError(f"Space '{space_id}' does not exist")

    return {"space_id": str(space_id), "user_id": str(user.get("sub"))}


# --------------------------------------------------------------------------- #
# DB sessions
# --------------------------------------------------------------------------- #
async def get_meta_db() -> AsyncIterator[AsyncSession]:
    """Yield an AsyncSession bound to the meta database."""
    from app.db.meta_session import get_meta_session

    async for session in get_meta_session():
        yield session


async def get_space_db(
    ctx: dict[str, Any] = Depends(get_space_context),
) -> AsyncIterator[AsyncSession]:
    """Yield an AsyncSession bound to the space's database."""
    manager = get_space_engine_manager()
    session = await manager.get_session(ctx["space_id"])
    try:
        yield session
    finally:
        await session.close()


# --------------------------------------------------------------------------- #
# Filesystem
# --------------------------------------------------------------------------- #
async def get_file_system(ctx: dict[str, Any] = Depends(get_space_context)) -> Any:
    """Return a FileSystem instance for the current space.

    Uses the project's ``FileSystemStorage`` implementation (from
    ``app.file_system.api``) to create and initialise a filesystem
    rooted at the space's notes directory.
    """
    from app.settings import settings
    from app.file_system.api import get_file_system as _create_fs

    space_id = ctx["space_id"]
    root_dir = settings.space_notes_dir(space_id)
    index_db = settings.spaces_data_dir / space_id / "index.db"

    return await _create_fs(root_dir=root_dir, index_db=index_db)
