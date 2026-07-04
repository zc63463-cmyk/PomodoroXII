"""Low-level engine / session factory helpers.

These are thin wrappers over SQLAlchemy's async API so that callers
(meta session, space manager, tests) share one consistent construction
recipe for engines and session factories.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def create_engine(url: str, *, echo: bool = False, pool_size: int | None = None) -> AsyncEngine:
    """Create an async engine.

    For SQLite, ``pool_size`` is ignored (SQLite uses a SingletonThreadPool
    / StaticPool). For other backends it maps to QueuePool size.
    """
    kwargs: dict = {"echo": echo}
    if pool_size is not None and not url.startswith("sqlite"):
        kwargs["pool_size"] = pool_size
    return create_async_engine(url, **kwargs)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Create an ``async_sessionmaker`` bound to ``engine``."""
    return async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )


async def get_db() -> AsyncIterator[AsyncSession]:
    """DEPRECATED meta-db dependency kept for backward compatibility.

    New code should use ``app.deps.get_meta_db`` instead. This exists so
    that legacy test fixtures and conftest overrides still resolve.
    """
    from app.db.meta_session import get_meta_session

    async for session in get_meta_session():
        yield session
