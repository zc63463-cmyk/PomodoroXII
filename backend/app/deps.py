"""FastAPI dependency providers for auth, DB sessions, and filesystem.

Token model:
- ``type == "master"`` → meta-layer access (spaces, global settings).
- ``type == "space"``  → access scoped to a single ``space_id``.
"""

import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Depends, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal, verify_with_fresh_meta_session
from app.errors import AuthenticationError, AuthorizationError
from app.logging import request_id_var  # noqa: F401  (re-exported for convenience)
from app.runtime.scope import AuthorizedSpaceScope, AuthorizedSpaceScopeResult
from app.space_manager import get_space_engine_manager

logger = logging.getLogger(__name__)


def get_space_runtime(request: Request):
    """Return the sole runtime instance installed by application bootstrap."""
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None:
        raise RuntimeError("SpaceRuntime is not installed")
    return runtime


class _LegacyCompatibleHTTPBearer(HTTPBearer):
    """Keep the raw-header parser's Bearer whitespace behavior."""

    async def __call__(
        self,
        request: Request,
    ) -> HTTPAuthorizationCredentials | None:
        credentials = await super().__call__(request)
        if credentials is not None:
            return credentials

        authorization = request.headers.get("Authorization")
        if authorization and authorization.lower().startswith("bearer "):
            return HTTPAuthorizationCredentials(scheme="Bearer", credentials="")
        return None


# Security scheme for OpenAPI docs - auto_error=False so we can raise
# our own AuthenticationError with the project's error envelope.
_bearer_scheme = _LegacyCompatibleHTTPBearer(
    auto_error=False,
    scheme_name="HTTPBearer",
)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> dict[str, Any]:
    """Decode the Bearer token and return its payload.

    Raises ``AuthenticationError`` if the header is missing/malformed or
    the token is invalid/expired.
    """
    if credentials is None:
        raise AuthenticationError("Missing or invalid Authorization header")
    token = credentials.credentials.strip()
    principal = await verify_with_fresh_meta_session(token, required_scope=None)
    return {
        "sub": principal.subject,
        "type": principal.token_type,
        "space_id": principal.space_id,
        "epoch": principal.epoch,
        "exp": principal.expires_at,
    }


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
    from app.runtime.sqlite_vfs import require_windows_native_runtime

    require_windows_native_runtime()
    if user.get("type") != "space":
        raise AuthorizationError("Space token required")
    space_id = user.get("space_id")
    if not space_id:
        raise AuthenticationError("Space token missing space_id")

    principal = Principal(
        subject=str(user.get("sub")),
        token_type="space",
        epoch=int(user.get("epoch", 0)),
        expires_at=user.get("exp") if isinstance(user.get("exp"), int) else None,
        space_id=str(space_id),
    )
    from app.db.meta_session import get_meta_session
    from app.settings import settings

    async for session in get_meta_session():
        scope_result = await AuthorizedSpaceScope(
            session, settings.spaces_data_dir
        ).open(principal, str(space_id), "read")
        break

    return {
        "space_id": str(space_id),
        "user_id": principal.subject,
        "scope_result": scope_result,
    }


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
    scope_result: AuthorizedSpaceScopeResult = ctx["scope_result"]
    async with scope_result.containment.open_verified() as opens:
        session = await get_space_engine_manager().get_session(ctx["space_id"], opens)
        try:
            yield session
        finally:
            await session.close()


# --------------------------------------------------------------------------- #
# Filesystem
# --------------------------------------------------------------------------- #
async def get_file_system(
    ctx: dict[str, Any] = Depends(get_space_context),
) -> AsyncIterator[Any]:
    """Yield a contained FileSystem instance for the current request.

    Uses the project's ``FileSystemStorage`` implementation (from
    ``app.file_system.api``) to create and initialise a filesystem
    rooted at the space's notes directory.
    """
    from app.file_system.api import open_contained_file_system

    scope_result: AuthorizedSpaceScopeResult = ctx["scope_result"]
    async with scope_result.containment.open_verified() as opens:
        file_system = await open_contained_file_system(opens)
        try:
            yield file_system
        finally:
            await file_system.close()
