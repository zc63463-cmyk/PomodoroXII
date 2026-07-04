"""Meta database lifecycle.

The *meta* database holds the space registry and global settings. It is
a single SQLite file (``Settings.database_url``) created on startup and
disposed on shutdown. Per-space databases are managed separately by
:class:`app.space_manager.SpaceEngineManager`.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.base import Base
from app.db.session import create_engine, create_session_factory
from app.settings import settings

logger = logging.getLogger(__name__)

# Module-level singletons populated by init_meta_db().
_meta_engine: AsyncEngine | None = None
_meta_session_factory: async_sessionmaker[AsyncSession] | None = None


async def init_meta_db() -> AsyncEngine:
    """Create the meta engine, schema, and session factory.

    Safe to call multiple times — returns the existing engine on subsequent
    calls. Imports the meta models so their tables register on
    ``Base.metadata`` before ``create_all`` runs.
    """
    global _meta_engine, _meta_session_factory

    if _meta_engine is not None:
        return _meta_engine

    # Import models so Base.metadata is populated.
    from app.db.models import meta  # noqa: F401
    from app.db.models.meta import MetaSetting, Space

    _meta_engine = create_engine(settings.database_url, echo=settings.debug)
    _meta_session_factory = create_session_factory(_meta_engine)

    async with _meta_engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[Space.__table__, MetaSetting.__table__],
        )

    logger.info("Meta database initialised at %s", settings.database_url)
    return _meta_engine


async def close_meta_db() -> None:
    """Dispose the meta engine (shutdown)."""
    global _meta_engine, _meta_session_factory

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
