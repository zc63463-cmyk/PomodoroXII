"""FastAPI dependency providers for auth, DB sessions, and filesystem.

Token model:
- ``type == "master"`` → meta-layer access (spaces, global settings).
- ``type == "space"``  → access scoped to a single ``space_id``.
"""

import hashlib
import logging
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Any
from uuid import uuid4

from fastapi import Depends, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal, verify_with_fresh_meta_session
from app.errors import AuthenticationError, AuthorizationError, ValidationError
from app.logging import request_id_var  # noqa: F401  (re-exported for convenience)
from app.mutation.types import validate_operation_id
from app.runtime.scope import AuthorizedSpaceScope
from app.runtime.space import SpaceRuntimeHandle

logger = logging.getLogger(__name__)


def get_space_runtime(request: Request):
    """Return the sole runtime instance installed by application bootstrap."""
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None:
        raise RuntimeError("SpaceRuntime is not installed")
    return runtime


@lru_cache(maxsize=1)
def get_compiled_entity_catalog():
    """Return the process-stable catalog used by route mutation dependencies."""
    from app.registry import CATALOG

    return CATALOG


def get_mutation_compiler(catalog=Depends(get_compiled_entity_catalog)):
    """Build the shared compiler composition for request-scoped UoW wiring."""
    from app.commands import FolderDomainPolicy, RelationDomainPolicy
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.mutation.unit_of_work import MutationCompiler
    from app.services.time import utc_now_iso_ms
    from app.task_space.compiler import TaskSpaceCompiler

    return MutationCompiler(
        catalog,
        policies=(
            FolderDomainPolicy(),
            RelationDomainPolicy(),
            KnowledgeDomainPolicy(),
            TaskSpaceCompiler(utc_now_iso_ms),
        ),
    )


def get_mutation_uow(request: Request):
    """Return the runtime-owned mutation UoW for the current application."""
    runtime = get_space_runtime(request)
    uow = getattr(runtime, "recovery_provider", None)
    if uow is None:
        raise RuntimeError("MutationUnitOfWork is not installed")
    return uow


def get_entity_command(catalog=Depends(get_compiled_entity_catalog)):
    """Return the pure EntityCommand factory bound to the shared catalog."""
    from app.commands import EntityCommand

    return EntityCommand(catalog)


def expected_version_from_request(request: Request, current_version: int) -> int:
    """Resolve an update CAS version from If-Match or the current row."""
    header = request.headers.get("If-Match")
    if header is None or not header.strip():
        return current_version
    value = header.strip()
    if value.startswith("W/"):
        value = value[2:].strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    try:
        version = int(value)
    except ValueError as exc:
        raise ValidationError("If-Match must contain a nonnegative integer version") from exc
    if version < 0:
        raise ValidationError("If-Match must contain a nonnegative integer version")
    return version


def get_operation_id(request: Request, response: Response) -> str:
    """Resolve the durable operation identity for one mutation request."""
    supplied = request.headers.get("Idempotency-Key")
    operation_id = supplied.strip() if supplied else f"req-{uuid4().hex}"
    try:
        validate_operation_id(operation_id)
    except ValueError as exc:
        raise ValidationError("Idempotency-Key must be 1-128 printable ASCII characters") from exc
    response.headers["X-Operation-ID"] = operation_id
    return operation_id


def entity_id_for_operation(operation_id: str, entity_type: str) -> str:
    """Derive a retry-stable entity ID for a create request without one."""
    validate_operation_id(operation_id)
    return hashlib.sha256(
        f"entity-id-v1\\0{entity_type}\\0{operation_id}".encode("ascii")
    ).hexdigest()[:32]


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
    request: Request,
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

    runtime = get_space_runtime(request)
    async for session in get_meta_session():
        opened = await AuthorizedSpaceScope(
            session, settings.spaces_data_dir, runtime
        ).open(principal, str(space_id), "read")
        break

    runtime_handle = opened
    scope_result = runtime_handle.scope

    result = {
        "space_id": str(space_id),
        "user_id": principal.subject,
        "scope_result": scope_result,
    }
    result["runtime_handle"] = runtime_handle
    return result


async def get_space_runtime_handle(
    ctx: dict[str, Any] = Depends(get_space_context),
) -> AsyncIterator[SpaceRuntimeHandle]:
    """Yield one request-owned runtime handle for all Space resources."""
    existing = ctx.get("runtime_handle")
    if not isinstance(existing, SpaceRuntimeHandle):
        raise RuntimeError("SpaceRuntimeHandle is required")
    try:
        yield existing
    finally:
        await existing.aclose()


# --------------------------------------------------------------------------- #
# DB sessions
# --------------------------------------------------------------------------- #
async def get_meta_db() -> AsyncIterator[AsyncSession]:
    """Yield an AsyncSession bound to the meta database."""
    from app.db.meta_session import get_meta_session

    async for session in get_meta_session():
        yield session


async def get_space_db(
    handle: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
) -> AsyncIterator[AsyncSession]:
    """Yield an AsyncSession bound to the space's database."""
    session = handle.session_factory()
    try:
        yield session
    finally:
        await session.close()


# --------------------------------------------------------------------------- #
# Filesystem
# --------------------------------------------------------------------------- #
async def get_file_system(
    handle: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
) -> AsyncIterator[Any]:
    """Yield a contained FileSystem instance for the current request.

    Uses the project's ``FileSystemStorage`` implementation (from
    ``app.file_system.api``) to create and initialise a filesystem
    rooted at the space's notes directory.
    """
    if handle.file_system is None:
        raise RuntimeError("Space runtime has no active filesystem")
    yield handle.file_system


# --------------------------------------------------------------------------- #
# KnowledgeStore (durable mutation facade)
# --------------------------------------------------------------------------- #
def get_knowledge_store(
    request: Request,
    handle: SpaceRuntimeHandle = Depends(get_space_runtime_handle),
) -> Any:
    """Construct a KnowledgeStore from the runtime's MutationUnitOfWork.

    The KnowledgeStore delegates all writes through the durable mutation
    pipeline (journal + UoW + projections).  Reads stay on the direct
    DB session.
    """
    from app.commands import EntityCommand
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.store import KnowledgeStore
    uow = get_mutation_uow(request)
    if uow is None:
        raise RuntimeError("MutationUnitOfWork is not installed")
    return KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(get_compiled_entity_catalog()),
        uow=uow,
    )
