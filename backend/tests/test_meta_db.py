"""Tests for the meta database lifecycle (app.db.meta_session)."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import meta_session as meta_session_module
from app.db.models.meta import MetaSetting, Space


@pytest.mark.asyncio
async def test_init_meta_db_creates_engine_and_factory():
    """init_meta_db() should populate the module-level engine + factory."""
    engine = await meta_session_module.init_meta_db()
    assert engine is not None
    assert meta_session_module.get_meta_session_factory() is not None
    await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_init_meta_db_creates_tables():
    """After init, the spaces + meta_settings tables must exist."""
    await meta_session_module.init_meta_db()
    engine = meta_session_module.get_meta_engine()

    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: set(sync_conn.dialect.get_table_names(sync_conn))
        )
    assert "spaces" in tables
    assert "meta_settings" in tables
    await meta_session_module.close_meta_db()


@pytest.mark.asyncio
async def test_init_meta_db_is_idempotent():
    """Calling init twice returns the same engine instance."""
    engine1 = await meta_session_module.init_meta_db()
    engine2 = await meta_session_module.init_meta_db()
    assert engine1 is engine2
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
