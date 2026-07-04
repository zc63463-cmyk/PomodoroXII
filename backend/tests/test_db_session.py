"""Tests for app.db.session — engine and session factory helpers."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.session import create_engine, create_session_factory


class TestCreateEngine:
    def test_returns_async_engine(self):
        """create_engine should return an AsyncEngine instance."""
        engine = create_engine("sqlite+aiosqlite:///:memory:")
        assert isinstance(engine, AsyncEngine)

    def test_sqlite_ignores_pool_size(self):
        """SQLite URLs should not raise even when pool_size is provided."""
        engine = create_engine("sqlite+aiosqlite:///:memory:", pool_size=10)
        assert isinstance(engine, AsyncEngine)


class TestCreateSessionFactory:
    def test_returns_async_sessionmaker(self):
        """create_session_factory should return an async_sessionmaker."""
        engine = create_engine("sqlite+aiosqlite:///:memory:")
        factory = create_session_factory(engine)
        assert isinstance(factory, async_sessionmaker)

    async def test_factory_binds_to_engine(self):
        """Sessions produced by the factory should bind to the given engine."""
        engine = create_engine("sqlite+aiosqlite:///:memory:")
        factory = create_session_factory(engine)
        async with factory() as session:
            assert isinstance(session, AsyncSession)
            assert session.bind is engine
