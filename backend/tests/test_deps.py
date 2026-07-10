"""Tests for FastAPI dependency providers (app.deps)."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import create_master_token, create_space_token
from app.deps import get_current_user, get_space_context, require_master_token
from app.errors import AuthorizationError


async def _run(coro):
    """Tiny helper so synchronous test bodies can await dependencies."""
    import asyncio

    return await asyncio.get_event_loop().run_until_complete(coro)


@pytest.mark.asyncio
async def test_get_current_user_decodes_valid_token():
    """A valid space token should decode to its payload."""
    token = create_space_token("spc_1", "user_1")
    payload = await get_current_user(authorization=f"Bearer {token}")
    assert payload["sub"] == "user_1"
    assert payload["type"] == "space"
    assert payload["space_id"] == "spc_1"


@pytest.mark.asyncio
async def test_require_master_token_rejects_space_token():
    """A space token must not satisfy require_master_token."""
    token = create_space_token("spc_1", "user_1")
    user = await get_current_user(authorization=f"Bearer {token}")
    with pytest.raises(AuthorizationError):
        await require_master_token(user=user)

    # And a master token should pass.
    master = create_master_token("admin")
    master_user = await get_current_user(authorization=f"Bearer {master}")
    result = await require_master_token(user=master_user)
    assert result["type"] == "master"


@pytest.mark.asyncio
async def test_get_space_context_returns_space_id_and_user_id():
    """get_space_context should extract space_id + user_id from a space token.

    P3.6 added meta-DB existence check, so the test must seed a real Space
    row in the meta DB before calling get_space_context with a token that
    references it.
    """
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.db.models.meta import Space

    await init_meta_db()
    try:
        from app.db.meta_session import get_meta_session

        # Seed a Space row matching the token's space_id.
        async for session in get_meta_session():
            session.add(Space(
                id="spc_ctx",
                name="Ctx Test Space",
                db_path="/tmp/spc_ctx.db",
                notes_dir="/tmp/spc_ctx_notes",
                is_default=False,
            ))
            await session.commit()
            break

        token = create_space_token("spc_ctx", "user_ctx")
        user = await get_current_user(authorization=f"Bearer {token}")
        ctx = await get_space_context(user=user)
        assert ctx == {"space_id": "spc_ctx", "user_id": "user_ctx"}

        # A master token should be rejected by get_space_context.
        with pytest.raises(AuthorizationError):
            master = create_master_token("admin")
            master_user = await get_current_user(authorization=f"Bearer {master}")
            await get_space_context(user=master_user)
    finally:
        await close_meta_db()


# --------------------------------------------------------------------------- #
# DB session dependencies
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_get_meta_db_yields_session():
    """get_meta_db should yield an AsyncSession bound to the meta database."""
    from app.db.meta_session import close_meta_db, init_meta_db

    await init_meta_db()
    try:
        from app.deps import get_meta_db

        gen = get_meta_db()
        session = await gen.__anext__()
        assert isinstance(session, AsyncSession)
        # Close the generator properly
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()
    finally:
        await close_meta_db()


@pytest.mark.asyncio
async def test_get_space_db_yields_session():
    """get_space_db should yield an AsyncSession bound to the space's database."""
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.space_manager import dispose_space_engine_manager

    await init_meta_db()
    try:
        from app.deps import get_space_db

        # Build a fake space context
        ctx = {"space_id": "spc_test", "user_id": "user_test"}

        gen = get_space_db(ctx)
        session = await gen.__anext__()
        assert isinstance(session, AsyncSession)
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()
    finally:
        await dispose_space_engine_manager()
        await close_meta_db()


# --------------------------------------------------------------------------- #
# get_file_system dependency (Gate #10)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_get_file_system_returns_filesystem_instance():
    """get_file_system should return a FileSystem instance, not a Path.

    This is Gate #10: the dependency must return an actual FileSystem
    implementation, not a fallback pathlib.Path.
    """
    from app.deps import get_file_system
    from app.file_system.interfaces import FileSystem

    ctx = {"space_id": "spc_fs_test", "user_id": "user_test"}
    result = await get_file_system(ctx)
    assert isinstance(result, FileSystem), (
        f"Expected FileSystem instance, got {type(result).__name__}"
    )
    assert not isinstance(result, Path), (
        "get_file_system returned a Path fallback instead of a FileSystem instance"
    )
