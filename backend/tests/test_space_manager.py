"""Tests for the identity-bound per-Space engine manager."""

from __future__ import annotations

import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.errors import SpaceEnginePathMismatchError, SQLiteAuthorityRevokedError
from app.runtime.contained_io import ContainedSpaceOpens, open_bound_space
from app.runtime.sqlite_vfs import MaintenanceOptions
from app.space_manager import SpaceEngineManager


def _opens(root: Path) -> ContainedSpaceOpens:
    root.mkdir(parents=True, exist_ok=True)
    notes = root / "notes"
    notes.mkdir(exist_ok=True)
    paths = SimpleNamespace(
        space_root=root,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    return open_bound_space(paths, ())


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
    import app.space_manager as manager_module

    class BrokenMetadata:
        @staticmethod
        def create_all(_connection) -> None:
            raise RuntimeError("injected schema failure")

    monkeypatch.setattr(manager_module, "get_space_metadata", lambda: BrokenMetadata())
    manager = SpaceEngineManager(max_size=1)
    opens = _opens(tmp_path / "failure")
    with pytest.raises(RuntimeError, match="injected schema failure"):
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
