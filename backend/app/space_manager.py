"""Per-space engine manager with LRU eviction.

Each *space* has its own SQLite database. Creating an
:class:`~sqlalchemy.ext.asyncio.AsyncEngine` per space is cheap, but
holding every engine open forever leaks file descriptors. This manager
keeps at most ``settings.engine_pool_max_size`` engines resident and
evicts the least-recently-used one (disposing its engine) when full.

Concurrency notes:
- A single ``asyncio.Lock`` guards the LRU dict. The lock is held only
  for the bookkeeping (move-to-end / popitem); engine creation happens
  outside the lock via a double-check pattern so two concurrent callers
  for the same *new* space don't create two engines.
- Schema initialisation (``create_all``) runs once per engine inside the
  creation critical section.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.migrations import run_migrations
from app.db.session import create_engine, create_session_factory
from app.settings import settings

logger = logging.getLogger(__name__)


class SpaceEngineManager:
    """LRU cache of per-space async engines and session factories."""

    def __init__(self, max_size: int | None = None) -> None:
        self._max_size: int = max_size if max_size is not None else settings.engine_pool_max_size
        # value: (engine, session_factory)
        self._engines: OrderedDict[str, tuple[AsyncEngine, async_sessionmaker[AsyncSession]]] = (
            OrderedDict()
        )
        self._lock = asyncio.Lock()
        self._initializations: dict[str, asyncio.Task[AsyncEngine]] = {}

    # ------------------------------------------------------------------ #
    # Engine access
    # ------------------------------------------------------------------ #
    async def get_engine(self, space_id: str, db_path: Any | None = None) -> AsyncEngine:
        """Return the engine for ``space_id``, creating it if needed.

        Args:
            space_id: Stable space identifier.
            db_path: Optional explicit DB path. Defaults to
                ``settings.space_db_path(space_id)``.
        """
        path = (
            Path(str(db_path)) if db_path is not None else settings.space_db_path(space_id)
        ).expanduser().resolve()
        path_key = str(path)
        async with self._lock:
            entry = self._engines.get(space_id)
            if entry is not None:
                self._engines.move_to_end(space_id)
                return entry[0]
            task = self._initializations.get(path_key)
            if task is None:
                task = asyncio.create_task(self._create_engine(space_id, path))
                self._initializations[path_key] = task

        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                async with self._lock:
                    if self._initializations.get(path_key) is task:
                        self._initializations.pop(path_key, None)

    async def _create_engine(self, space_id: str, path: Path) -> AsyncEngine:
        path.parent.mkdir(parents=True, exist_ok=True)
        await self._init_schema(path)
        engine = create_engine(f"sqlite+aiosqlite:///{path.as_posix()}", echo=settings.debug)
        async with self._lock:
            entry = self._engines.get(space_id)
            if entry is not None:
                await engine.dispose()
                self._engines.move_to_end(space_id)
                return entry[0]
            self._engines[space_id] = (engine, create_session_factory(engine))
            self._engines.move_to_end(space_id)
            self._evict_if_needed()
        logger.info("Created engine for space %s at %s", space_id, path)
        return engine

    async def get_session_factory(
        self, space_id: str, db_path: Any | None = None
    ) -> async_sessionmaker[AsyncSession]:
        """Return the session factory for ``space_id``."""
        # Ensure the engine exists.
        await self.get_engine(space_id, db_path=db_path)
        async with self._lock:
            return self._engines[space_id][1]

    async def get_session(
        self, space_id: str, db_path: Any | None = None
    ) -> AsyncSession:
        """Return a new AsyncSession bound to the space's engine."""
        factory = await self.get_session_factory(space_id, db_path=db_path)
        return factory()

    # ------------------------------------------------------------------ #
    # Eviction / disposal
    # ------------------------------------------------------------------ #
    def _evict_if_needed(self) -> None:
        """Pop LRU entries while over capacity. Caller must hold the lock."""
        while len(self._engines) > self._max_size:
            evicted_id, (engine, _factory) = self._engines.popitem(last=False)
            # Schedule disposal without awaiting inside the lock.
            asyncio.create_task(self._dispose_engine(evicted_id, engine))

    @staticmethod
    async def _dispose_engine(space_id: str, engine: AsyncEngine) -> None:
        try:
            await engine.dispose()
            logger.info("Disposed evicted engine for space %s", space_id)
        except Exception:  # noqa: BLE001
            logger.warning("Failed to dispose engine for space %s", space_id, exc_info=True)

    async def dispose(self, space_id: str) -> None:
        """Dispose and remove a single space's engine."""
        async with self._lock:
            entry = self._engines.pop(space_id, None)
        if entry is not None:
            engine, _factory = entry
            await engine.dispose()
            logger.info("Disposed engine for space %s", space_id)

    async def dispose_all(self) -> None:
        """Dispose every cached engine (used on shutdown)."""
        async with self._lock:
            items = list(self._engines.items())
            self._engines.clear()
        for _space_id, (engine, _factory) in items:
            try:
                await engine.dispose()
            except Exception:  # noqa: BLE001
                logger.warning("Failed to dispose engine", exc_info=True)

    # ------------------------------------------------------------------ #
    # Schema init
    # ------------------------------------------------------------------ #
    @staticmethod
    async def _init_schema(db_path: Path) -> None:
        """Run per-space migrations without blocking the event loop."""
        await asyncio.to_thread(run_migrations, "space", db_path)


# Module-level singleton, instantiated lazily so tests can patch settings.
_space_manager: SpaceEngineManager | None = None


def get_space_engine_manager() -> SpaceEngineManager:
    """Return the process-wide :class:`SpaceEngineManager` singleton."""
    global _space_manager
    if _space_manager is None:
        _space_manager = SpaceEngineManager()
    return _space_manager


async def dispose_space_engine_manager() -> None:
    """Dispose the singleton manager (shutdown)."""
    global _space_manager
    if _space_manager is not None:
        await _space_manager.dispose_all()
        _space_manager = None
