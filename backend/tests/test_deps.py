"""Tests for FastAPI dependency providers."""

from __future__ import annotations

import pytest
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import create_master_token, create_space_token
from app.deps import get_current_user, get_space_context, require_master_token
from app.errors import AuthorizationError


@pytest.fixture(autouse=True)
async def _meta_database():
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.space_manager import dispose_space_engine_manager

    await init_meta_db()
    try:
        yield
    finally:
        await dispose_space_engine_manager()
        await close_meta_db()


def _cred(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


async def _registered_space_context(space_id: str, user_id: str = "user_test"):
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.settings import settings

    root = settings.spaces_data_dir / space_id
    notes = root / "notes"
    notes.mkdir(parents=True, exist_ok=True)
    async for session in get_meta_session():
        session.add(
            Space(
                id=space_id,
                name=f"Context {space_id}",
                db_path=str(root / "space.db"),
                notes_dir=str(notes),
                is_default=False,
            )
        )
        await session.commit()
        break
    return await get_space_context(
        user={
            "sub": user_id,
            "type": "space",
            "space_id": space_id,
            "epoch": 1,
        }
    )


@pytest.mark.asyncio
async def test_get_current_user_decodes_valid_token() -> None:
    from app.auth.authority import bootstrap_credential_epoch

    await _registered_space_context("spc_1")
    epoch = await bootstrap_credential_epoch()
    token = create_space_token("spc_1", "user_1", epoch=epoch)
    payload = await get_current_user(credentials=_cred(token))
    assert payload["sub"] == "user_1"
    assert payload["type"] == "space"
    assert payload["space_id"] == "spc_1"
    assert payload["epoch"] == epoch


@pytest.mark.asyncio
async def test_require_master_token_rejects_space_token() -> None:
    from app.auth.authority import bootstrap_credential_epoch

    await _registered_space_context("spc_1")
    epoch = await bootstrap_credential_epoch()
    user = await get_current_user(
        credentials=_cred(create_space_token("spc_1", "user_1", epoch=epoch))
    )
    with pytest.raises(AuthorizationError):
        await require_master_token(user=user)

    master_user = await get_current_user(
        credentials=_cred(create_master_token("admin", epoch=epoch))
    )
    assert (await require_master_token(user=master_user))["type"] == "master"


@pytest.mark.asyncio
async def test_get_space_context_returns_private_scope_result() -> None:
    ctx = await _registered_space_context("spc_ctx", "user_ctx")
    assert ctx["space_id"] == "spc_ctx"
    assert ctx["user_id"] == "user_ctx"
    assert ctx["scope_result"].space_id == "spc_ctx"

    with pytest.raises(AuthorizationError):
        await get_space_context(user={"sub": "admin", "type": "master"})


@pytest.mark.asyncio
async def test_get_meta_db_yields_session() -> None:
    from app.deps import get_meta_db

    dependency = get_meta_db()
    session = await dependency.__anext__()
    assert isinstance(session, AsyncSession)
    with pytest.raises(StopAsyncIteration):
        await dependency.__anext__()


@pytest.mark.asyncio
async def test_get_space_db_yields_identity_bound_session() -> None:
    from app.deps import get_space_db
    from app.space_manager import dispose_space_engine_manager

    ctx = await _registered_space_context("spc_session")
    dependency = get_space_db(ctx)
    session = await dependency.__anext__()
    try:
        assert isinstance(session, AsyncSession)
    finally:
        with pytest.raises(StopAsyncIteration):
            await dependency.__anext__()
        await dispose_space_engine_manager()


@pytest.mark.asyncio
async def test_get_file_system_yields_and_closes_contained_instance() -> None:
    from app.deps import get_file_system
    from app.file_system.interfaces import FileSystem

    ctx = await _registered_space_context("spc_file_system")
    dependency = get_file_system(ctx)
    file_system = await dependency.__anext__()
    assert isinstance(file_system, FileSystem)
    assert file_system._storage_mode == "contained"
    await dependency.aclose()
    assert file_system._notes._handle._descriptor == -1
