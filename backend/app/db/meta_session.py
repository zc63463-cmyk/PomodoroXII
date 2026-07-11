"""Meta database lifecycle.

The *meta* database holds the space registry and global settings. It is
a single SQLite file (``Settings.database_url``) created on startup and
disposed on shutdown. Per-space databases are managed separately by
:class:`app.space_manager.SpaceEngineManager`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.migrations import run_migrations
from app.db.session import create_engine, create_session_factory
from app.settings import settings

logger = logging.getLogger(__name__)

# Module-level singletons populated by init_meta_db().
_meta_engine: AsyncEngine | None = None
_meta_session_factory: async_sessionmaker[AsyncSession] | None = None
_meta_init_task: asyncio.Task[AsyncEngine] | None = None


def _sqlite_path(database_url: str) -> Path:
    url = make_url(database_url)
    if not url.drivername.startswith("sqlite"):
        raise RuntimeError("Meta migrations currently require a local SQLite database URL")
    if not url.database or url.database == ":memory:":
        raise RuntimeError("Meta migrations require a file-backed SQLite database")
    return Path(url.database)


async def _initialize_meta_db() -> AsyncEngine:
    global _meta_engine, _meta_session_factory

    await asyncio.to_thread(run_migrations, "meta", _sqlite_path(settings.database_url))
    _meta_engine = create_engine(settings.database_url, echo=settings.debug)
    _meta_session_factory = create_session_factory(_meta_engine)
    logger.info("Meta database initialised at %s", settings.database_url)
    return _meta_engine


async def init_meta_db() -> AsyncEngine:
    """Create the meta database once for all concurrent callers."""
    global _meta_init_task

    if _meta_engine is not None:
        return _meta_engine
    task = _meta_init_task
    if task is None:
        task = asyncio.create_task(_initialize_meta_db())
        _meta_init_task = task
    try:
        return await asyncio.shield(task)
    finally:
        if task.done() and _meta_init_task is task:
            _meta_init_task = None


async def close_meta_db() -> None:
    """Dispose the meta engine (shutdown)."""
    global _meta_engine, _meta_session_factory, _meta_init_task

    if _meta_init_task is not None:
        try:
            await asyncio.shield(_meta_init_task)
        except Exception:  # noqa: BLE001
            pass
        _meta_init_task = None
    if _meta_engine is not None:
        await _meta_engine.dispose()
        _meta_engine = None
        _meta_session_factory = None
        logger.info("Meta database closed.")


def get_meta_engine() -> AsyncEngine:
    """Return the initialised meta engine, or raise."""
    if _meta_engine is None:
        raise RuntimeError("Meta database not initialised — call init_meta_db() first.")
    return _meta_engine


def get_meta_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return the meta session factory, or raise."""
    if _meta_session_factory is None:
        raise RuntimeError("Meta database not initialised — call init_meta_db() first.")
    return _meta_session_factory


async def get_meta_session() -> AsyncIterator[AsyncSession]:
    """Yield a meta-db AsyncSession."""
    factory = get_meta_session_factory()
    async with factory() as session:
        yield session
