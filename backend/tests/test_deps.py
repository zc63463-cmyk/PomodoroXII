"""Tests for FastAPI dependency providers."""

from __future__ import annotations

from types import SimpleNamespace

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


class _FakeLease:
    fence = 1

    async def release(self) -> None:
        return None


class _FakeLeases:
    async def acquire_global(self, *_args):
        return _FakeLease()

    def register_pending_lease_cleanup(self, _lease) -> None:
        return None


class _FakeRuntime:
    def __init__(self) -> None:
        self.leases = _FakeLeases()
        self.open_count = 0

    async def open_resolved(
        self, scope, _mode, _global_lease, *, owns_global_lease: bool
    ):
        assert owns_global_lease is True
        self.open_count += 1
        return SimpleNamespace(scope=scope)


def _request_with_runtime(runtime):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(runtime=runtime)))


async def _register_space(space_id: str) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.settings import settings

    root = settings.spaces_data_dir / space_id
    notes = root / "notes"
    notes.mkdir(parents=True, exist_ok=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
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


async def _registered_space_context(space_id: str, user_id: str = "user_test"):
    await _register_space(space_id)
    runtime = _FakeRuntime()
    return await get_space_context(
        request=_request_with_runtime(runtime),
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

    await _register_space("spc_1")
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

    await _register_space("spc_1")
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
        await get_space_context(
            request=_request_with_runtime(_FakeRuntime()),
            user={"sub": "admin", "type": "master"},
        )


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
    from app.runtime.space import SpaceRuntimeHandle

    class Session:
        async def close(self) -> None:
            return None

    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="spc_session"),
        SimpleNamespace(session_factory=lambda: Session()),
        SimpleNamespace(),
        SimpleNamespace(),
        None,
        False,
        False,
        1,
        SimpleNamespace(leases=SimpleNamespace()),
    )

    dependency = get_space_db(handle)
    session = await dependency.__anext__()
    try:
        assert session is not None
    finally:
        with pytest.raises(StopAsyncIteration):
            await dependency.__anext__()


@pytest.mark.asyncio
async def test_get_file_system_yields_and_closes_contained_instance() -> None:
    from app.deps import get_file_system
    from app.runtime.space import SpaceRuntimeHandle

    file_system = SimpleNamespace()
    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="spc_file_system"),
        SimpleNamespace(),
        file_system,
        SimpleNamespace(),
        None,
        False,
        False,
        1,
        SimpleNamespace(leases=SimpleNamespace()),
    )

    dependency = get_file_system(handle)
    yielded = await dependency.__anext__()
    assert yielded is file_system
    await dependency.aclose()
