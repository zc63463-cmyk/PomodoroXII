"""Per-Space engine cache bound to opaque SQLite storage identities."""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.metadata import get_space_metadata
from app.db.session import create_session_factory
from app.errors import SpaceEnginePathMismatchError
from app.runtime.contained_io import ContainedSpaceOpens
from app.runtime.joined_thread import run_joined_awaitable
from app.runtime.sqlite_vfs import (
    AsyncEngineOptions,
    BoundSQLiteTarget,
    StorageIdentity,
)
from app.settings import settings

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _EngineEntry:
    identity: StorageIdentity
    target: BoundSQLiteTarget
    engine: AsyncEngine
    sessions: async_sessionmaker[AsyncSession]


class SpaceEngineManager:
    """LRU cache that never derives or accepts a database pathname."""

    def __init__(self, max_size: int | None = None) -> None:
        self._max_size = max_size if max_size is not None else settings.engine_pool_max_size
        self._engines: OrderedDict[str, _EngineEntry] = OrderedDict()
        self._lock = asyncio.Lock()

    @staticmethod
    def _engine_options(_space_id: str) -> AsyncEngineOptions:
        return AsyncEngineOptions(echo=settings.debug)

    async def get_session(
        self, space_id: str, opens: ContainedSpaceOpens
    ) -> AsyncSession:
        requested_identity = opens.database_target.identity
        async with self._lock:
            cached = self._engines.get(space_id)
            if cached is not None:
                if cached.identity != requested_identity:
                    raise SpaceEnginePathMismatchError()
                self._engines.move_to_end(space_id)
                opens._register_revocation_callback(
                    lambda: self._dispose_if_current(space_id, cached)
                )
                return cached.sessions()

            target = opens.take_database_target()
            engine: AsyncEngine | None = None
            try:
                engine = target.make_async_engine(self._engine_options(space_id))
                async with engine.begin() as connection:
                    await connection.run_sync(get_space_metadata().create_all)
            except BaseException:
                if engine is not None:
                    await run_joined_awaitable(engine.dispose())
                await run_joined_awaitable(target.aclose())
                raise
            assert engine is not None
            entry = _EngineEntry(
                identity=target.identity,
                target=target,
                engine=engine,
                sessions=create_session_factory(engine),
            )
            self._engines[space_id] = entry
            self._engines.move_to_end(space_id)
            evicted = self._pop_evicted_locked()

        for evicted_id, evicted_entry in evicted:
            await self._dispose_entry(evicted_id, evicted_entry)
        logger.info("Created identity-bound engine for Space %s", space_id)
        return entry.sessions()

    def _pop_evicted_locked(self) -> list[tuple[str, _EngineEntry]]:
        evicted: list[tuple[str, _EngineEntry]] = []
        while len(self._engines) > self._max_size:
            evicted.append(self._engines.popitem(last=False))
        return evicted

    @staticmethod
    async def _dispose_entry(space_id: str, entry: _EngineEntry) -> None:
        try:
            await run_joined_awaitable(entry.engine.dispose())
        finally:
            await run_joined_awaitable(entry.target.aclose())
        logger.info("Disposed identity-bound engine for Space %s", space_id)

    async def _dispose_if_current(
        self, space_id: str, expected: _EngineEntry
    ) -> None:
        async with self._lock:
            current = self._engines.get(space_id)
            if current is not expected:
                return
            self._engines.pop(space_id)
        await self._dispose_entry(space_id, expected)

    async def dispose(self, space_id: str) -> None:
        async with self._lock:
            entry = self._engines.pop(space_id, None)
        if entry is not None:
            await self._dispose_entry(space_id, entry)

    async def dispose_all(self) -> None:
        async with self._lock:
            items = list(self._engines.items())
            self._engines.clear()
        errors: list[BaseException] = []
        for space_id, entry in items:
            try:
                await self._dispose_entry(space_id, entry)
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("Space engine disposal failed", errors)


_space_manager: SpaceEngineManager | None = None


def get_space_engine_manager() -> SpaceEngineManager:
    global _space_manager
    if _space_manager is None:
        _space_manager = SpaceEngineManager()
    return _space_manager


async def dispose_space_engine_manager() -> None:
    global _space_manager
    if _space_manager is not None:
        await _space_manager.dispose_all()
        _space_manager = None
