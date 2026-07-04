"""Tests for the per-space engine manager (app.space_manager)."""

from __future__ import annotations

import pytest

from app.space_manager import SpaceEngineManager


@pytest.mark.asyncio
async def test_get_engine_creates_file_and_returns_engine(tmp_path):
    """get_engine() should create the DB file path and return an engine."""
    manager = SpaceEngineManager(max_size=3)
    space_id = "spc_alpha"
    db_path = tmp_path / "alpha.db"

    engine = await manager.get_engine(space_id, db_path=db_path)
    assert engine is not None
    # The parent dir is created by get_engine.
    assert db_path.parent.exists()
    await manager.dispose_all()


@pytest.mark.asyncio
async def test_get_engine_is_cached_per_space(tmp_path):
    """Two calls for the same space return the same engine instance."""
    manager = SpaceEngineManager(max_size=3)
    db_path = tmp_path / "cached.db"

    engine1 = await manager.get_engine("spc_cached", db_path=db_path)
    engine2 = await manager.get_engine("spc_cached", db_path=db_path)
    assert engine1 is engine2
    await manager.dispose_all()


@pytest.mark.asyncio
async def test_lru_eviction_disposes_oldest(tmp_path):
    """When over capacity, the least-recently-used engine is evicted."""
    manager = SpaceEngineManager(max_size=2)

    e1 = await manager.get_engine("spc_1", db_path=tmp_path / "1.db")
    e2 = await manager.get_engine("spc_2", db_path=tmp_path / "2.db")
    # Touch spc_1 so spc_2 becomes LRU.
    await manager.get_engine("spc_1", db_path=tmp_path / "1.db")
    # Insert a third -> evicts spc_2.
    e3 = await manager.get_engine("spc_3", db_path=tmp_path / "3.db")

    assert e1 is not None
    assert e3 is not None
    # After eviction the cached engines should be spc_1 and spc_3 only.
    async with manager._lock:
        assert set(manager._engines.keys()) == {"spc_1", "spc_3"}
    await manager.dispose_all()


@pytest.mark.asyncio
async def test_get_session_yields_working_session(tmp_path):
    """get_session() should return a session bound to the space engine."""
    manager = SpaceEngineManager(max_size=2)
    session = await manager.get_session("spc_sess", db_path=tmp_path / "sess.db")
    try:
        # A trivial round-trip proves the session is usable.
        result = await session.execute(__import__("sqlalchemy").text("SELECT 1"))
        assert result.scalar() == 1
    finally:
        await session.close()
    await manager.dispose_all()
