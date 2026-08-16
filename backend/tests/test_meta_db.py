"""Tests for the meta database lifecycle (app.db.meta_session)."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from app.db import meta_session as meta_session_module
from app.db.models.meta import Space


@pytest.mark.asyncio
async def test_init_meta_db_opens_migrated_db_before_engine_creation(monkeypatch):
    events: list[tuple[str, object]] = []
    real_create_engine = meta_session_module.create_engine

    def tracking_create_engine(*args, **kwargs):
        events.append(("engine", args))
        return real_create_engine(*args, **kwargs)

    monkeypatch.setattr(meta_session_module, "create_engine", tracking_create_engine)

    await meta_session_module.init_meta_db()
    try:
        assert [name for name, _args in events] == ["engine"]
    finally:
        await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_init_meta_db_creates_engine_and_factory():
    """init_meta_db() should populate the module-level engine + factory."""
    engine = await meta_session_module.init_meta_db()
    assert engine is not None
    assert meta_session_module.get_meta_session_factory() is not None
    await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_init_meta_db_creates_tables():
    """After init, all meta tables must exist."""
    await meta_session_module.init_meta_db()
    engine = meta_session_module.get_meta_engine()

    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: set(sync_conn.dialect.get_table_names(sync_conn))
        )
    assert "spaces" in tables
    assert "meta_settings" in tables
    assert "active_session_locator" in tables
    assert "active_session_operations" in tables
    await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_init_meta_db_is_idempotent():
    """Calling init twice returns the same engine instance."""
    engine1 = await meta_session_module.init_meta_db()
    engine2 = await meta_session_module.init_meta_db()
    assert engine1 is engine2
    await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_concurrent_init_meta_db_is_single_flight(monkeypatch):
    await meta_session_module.close_meta_db()
    calls = 0
    release = asyncio.Event()
    original_initialize = meta_session_module._initialize_meta_db

    async def blocking_initialize():
        nonlocal calls
        calls += 1
        await release.wait()
        return await original_initialize()

    monkeypatch.setattr(meta_session_module, "_initialize_meta_db", blocking_initialize)
    tasks = [asyncio.create_task(meta_session_module.init_meta_db()) for _ in range(3)]
    await asyncio.sleep(0)
    release.set()
    engines = await asyncio.gather(*tasks)
    try:
        assert calls == 1
        assert engines[0] is engines[1] is engines[2]
    finally:
        await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_meta_session_can_persist_space():
    """A Space row written through the session should round-trip."""
    await meta_session_module.init_meta_db()

    async for session in meta_session_module.get_meta_session():
        session.add(
            Space(
                id="spc_1",
                name="My Space",
                db_path="/tmp/space.db",
                notes_dir="/tmp/notes",
                is_default=True,
            )
        )
        await session.commit()

        result = await session.execute(select(Space).where(Space.id == "spc_1"))
        fetched = result.scalar_one()
        assert fetched.name == "My Space"
        assert fetched.is_default is True
        break

    await meta_session_module.close_meta_db()
