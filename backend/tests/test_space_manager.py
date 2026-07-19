"""Tests for the identity-bound per-Space engine manager."""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.errors import (
    PathOutsideSpaceError,
    SpaceEnginePathMismatchError,
    SQLiteAuthorityRevokedError,
)
from app.runtime.contained_io import ContainedSpaceOpens, open_bound_space
from app.runtime.scope import _walk_existing_ancestors
from app.runtime.sqlite_vfs import MaintenanceOptions
from app.space_manager import SpaceEngineManager


def _opens(root: Path) -> ContainedSpaceOpens:
    root.mkdir(parents=True, exist_ok=True)
    notes = root / "notes"
    notes.mkdir(exist_ok=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root.parent,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    return open_bound_space(paths, _walk_existing_ancestors(paths))


@pytest.mark.asyncio
async def test_get_session_uses_transferred_bound_target(tmp_path: Path) -> None:
    manager = SpaceEngineManager(max_size=2)
    opens = _opens(tmp_path / "bound")
    session = await manager.get_session("spc_bound", opens)
    try:
        result = await session.execute(text("SELECT 1"))
        assert result.scalar() == 1
        assert opens._database_taken is True
    finally:
        await session.close()
        await opens.close_untransferred_resources()
        await manager.dispose_all()


@pytest.mark.asyncio
async def test_same_space_identity_reuses_cache_without_second_transfer(
    tmp_path: Path,
) -> None:
    manager = SpaceEngineManager(max_size=2)
    first = _opens(tmp_path / "same")
    second = _opens(tmp_path / "same")
    first_session = await manager.get_session("spc_same", first)
    second_session = await manager.get_session("spc_same", second)
    try:
        assert first._database_taken is True
        assert second._database_taken is False
        assert len(manager._engines) == 1
    finally:
        await first_session.close()
        await second_session.close()
        await first.close_untransferred_resources()
        await second.close_untransferred_resources()
        await manager.dispose_all()


@pytest.mark.asyncio
async def test_cached_engine_is_revoked_when_exit_revalidation_fails(
    monkeypatch, tmp_path: Path
) -> None:
    import app.runtime.scope as scope_module
    from app.runtime.scope import SpaceContainmentCapability

    manager = SpaceEngineManager(max_size=2)
    root = tmp_path / "spaces"
    parent = root / "same"
    parent.mkdir(parents=True)
    notes = parent / "notes"
    notes.mkdir()
    (parent / "space.db").touch()
    (parent / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root,
        db_path=parent / "space.db",
        notes_dir=notes,
        index_db=parent / "index.db",
    )
    first_capability = SpaceContainmentCapability._create(paths)
    async with first_capability.open_verified() as first:
        first_session = await manager.get_session("spc_same", first)
        await first_session.close()

    cached = manager._engines["spc_same"]
    second_capability = SpaceContainmentCapability._create(paths)
    original_revalidate = scope_module._require_same_safe_ancestors
    revalidations = 0

    def fail_only_on_exit(*args, **kwargs) -> None:
        nonlocal revalidations
        revalidations += 1
        original_revalidate(*args, **kwargs)
        if revalidations == 2:
            raise PathOutsideSpaceError("injected exit identity change")

    monkeypatch.setattr(
        scope_module, "_require_same_safe_ancestors", fail_only_on_exit
    )
    try:
        with pytest.raises(BaseExceptionGroup, match="containment cleanup failed"):
            async with second_capability.open_verified() as second:
                second_session = await manager.get_session("spc_same", second)
                await second_session.close()

        assert "spc_same" not in manager._engines
        with pytest.raises(SQLiteAuthorityRevokedError):
            cached.target.open_maintenance(MaintenanceOptions(read_only=True))
    finally:
        await manager.dispose_all()


@pytest.mark.asyncio
async def test_first_cached_engine_is_revoked_before_target_close_on_exit_drift(
    monkeypatch, tmp_path: Path
) -> None:
    import app.runtime.scope as scope_module
    from app.runtime.scope import SpaceContainmentCapability

    manager = SpaceEngineManager(max_size=2)
    root = tmp_path / "spaces"
    parent = root / "first"
    parent.mkdir(parents=True)
    notes = parent / "notes"
    notes.mkdir()
    (parent / "space.db").touch()
    (parent / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root,
        db_path=parent / "space.db",
        notes_dir=notes,
        index_db=parent / "index.db",
    )
    capability = SpaceContainmentCapability._create(paths)
    original_revalidate = scope_module._require_same_safe_ancestors
    revalidations = 0

    def fail_only_on_exit(*args, **kwargs) -> None:
        nonlocal revalidations
        revalidations += 1
        original_revalidate(*args, **kwargs)
        if revalidations == 2:
            raise PathOutsideSpaceError("injected first-open exit identity change")

    monkeypatch.setattr(
        scope_module, "_require_same_safe_ancestors", fail_only_on_exit
    )

    context = capability.open_verified()
    try:
        opens = await context.__aenter__()
        session = await manager.get_session("spc_first", opens)
        await session.close()
        assert "spc_first" in manager._engines
        assert revalidations == 1
        with pytest.raises(BaseExceptionGroup, match="containment cleanup failed"):
            await asyncio.wait_for(context.__aexit__(None, None, None), timeout=2)
        assert "spc_first" not in manager._engines
    finally:
        await manager.dispose_all()


@pytest.mark.asyncio
async def test_cached_space_rejects_different_identity_before_transfer(
    tmp_path: Path,
) -> None:
    manager = SpaceEngineManager(max_size=2)
    first = _opens(tmp_path / "first")
    mismatch = _opens(tmp_path / "mismatch")
    session = await manager.get_session("spc_bound", first)
    try:
        with pytest.raises(SpaceEnginePathMismatchError):
            await manager.get_session("spc_bound", mismatch)
        assert mismatch._database_taken is False
    finally:
        await session.close()
        await first.close_untransferred_resources()
        await mismatch.close_all()
        await manager.dispose_all()


@pytest.mark.asyncio
async def test_lru_disposes_engine_before_revoking_target_and_returning(
    tmp_path: Path,
) -> None:
    manager = SpaceEngineManager(max_size=1)
    first = _opens(tmp_path / "first")
    second = _opens(tmp_path / "second")
    first_session = await manager.get_session("spc_first", first)
    await first_session.close()
    second_session = await manager.get_session("spc_second", second)
    try:
        with pytest.raises(SQLiteAuthorityRevokedError):
            first.database_target.open_maintenance(
                MaintenanceOptions(read_only=True)
            )
    finally:
        await second_session.close()
        await first.close_untransferred_resources()
        await second.close_untransferred_resources()
        await manager.dispose_all()


@pytest.mark.asyncio
async def test_engine_initialization_failure_revokes_transferred_target(
    monkeypatch, tmp_path: Path
) -> None:
    manager = SpaceEngineManager(max_size=1)
    opens = _opens(tmp_path / "failure")
    monkeypatch.setattr(
        type(opens.database_target),
        "make_async_engine",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("injected engine failure")
        ),
    )
    with pytest.raises(RuntimeError, match="injected engine failure"):
        await manager.get_session("spc_failure", opens)
    with pytest.raises(SQLiteAuthorityRevokedError):
        opens.database_target.open_maintenance(
            MaintenanceOptions(read_only=True)
        )
    await opens.close_untransferred_resources()


def test_manager_has_no_path_backed_entrypoint_or_url_construction() -> None:
    source = inspect.getsource(SpaceEngineManager)
    assert "_get_test_session_from_path" not in source
    assert "sqlite+aiosqlite" not in source
    assert "Path(" not in source
    assert "create_all" not in source
@pytest.mark.asyncio
async def test_engine_manager_rejects_bare_path_without_touching_it(tmp_path):
    from app.space_manager import SpaceEngineManager

    manager = SpaceEngineManager(max_size=2)
    missing = tmp_path / "missing" / "space.db"
    with pytest.raises(TypeError, match="ContainedSpaceOpens"):
        await manager.acquire("space-1", missing)
    assert not missing.exists()
    assert not missing.parent.exists()


@pytest.mark.asyncio
async def test_engine_acquire_handle_release_is_reference_counted(tmp_path: Path) -> None:
    manager = SpaceEngineManager(max_size=2)
    first = _opens(tmp_path / "ref")
    second = _opens(tmp_path / "ref")
    one = await manager.acquire("ref", first)
    two = await manager.acquire("ref", second)
    assert one.engine is two.engine
    await one.release()
    assert manager._engines["ref"].ref_count == 1
    await two.release()
    assert "ref" not in manager._engines
    await first.close_untransferred_resources()
    await second.close_untransferred_resources()
    await manager.dispose_all()
