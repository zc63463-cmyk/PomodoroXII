"""Per-Space engine cache bound to opaque SQLite storage identities."""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

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


@dataclass
class _DrainState:
    owner_task: asyncio.Task[object]
    resumed: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass(slots=True)
class _EngineEntry:
    identity: StorageIdentity
    target: BoundSQLiteTarget
    engine: AsyncEngine
    sessions: async_sessionmaker[AsyncSession]
    ref_count: int = 0


@dataclass
class EngineHandle:
    space_id: str
    engine: AsyncEngine
    _session_factory: async_sessionmaker[AsyncSession] = field(repr=False)
    _release_callback: Callable[[], Awaitable[None]] = field(repr=False)
    _owner_task: object = field(default_factory=asyncio.current_task, repr=False)
    _release_started: bool = False
    _released: bool = False

    @property
    def session_factory(self):
        if self._release_started or self._released:
            raise RuntimeError("engine handle release has started")
        return self._session_factory

    async def release(self) -> None:
        if self._released:
            return
        if asyncio.current_task() is not self._owner_task:
            raise RuntimeError("engine handle release belongs to another asyncio Task")
        self._release_started = True
        await self._release_callback()
        self._released = True


class SpaceEngineManager:
    """LRU cache that never derives or accepts a database pathname."""

    def __init__(self, max_size: int | None = None) -> None:
        self._max_size = max_size if max_size is not None else settings.engine_pool_max_size
        self._engines: OrderedDict[str, _EngineEntry] = OrderedDict()
        self._lock = asyncio.Lock()
        self._draining: dict[StorageIdentity, _DrainState] = {}

    @staticmethod
    def _engine_options(_space_id: str) -> AsyncEngineOptions:
        return AsyncEngineOptions(echo=settings.debug)

    async def get_session(
        self, space_id: str, opens: ContainedSpaceOpens
    ) -> AsyncSession:
        requested_identity = opens.database_target.identity
        while True:
            await self._wait_until_resumed(requested_identity)
            async with self._lock:
                if requested_identity in self._draining:
                    continue
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
                opens._register_revocation_callback(
                    lambda: self._dispose_if_current(space_id, entry)
                )
                evicted = self._pop_evicted_locked()
                break

        for evicted_id, evicted_entry in evicted:
            await self._dispose_entry(evicted_id, evicted_entry)
        logger.info("Created identity-bound engine for Space %s", space_id)
        return entry.sessions()

    async def acquire(self, space_id: str, opens: ContainedSpaceOpens) -> EngineHandle:
        if not isinstance(opens, ContainedSpaceOpens):
            raise TypeError("SpaceEngineManager.acquire requires ContainedSpaceOpens")
        identity = opens.database_target.identity
        while True:
            await self._wait_until_resumed(identity)
            async with self._lock:
                if identity in self._draining:
                    continue
                entry = self._engines.get(space_id)
                if entry is not None:
                    if entry.identity != identity:
                        raise SpaceEnginePathMismatchError()
                    entry.ref_count += 1
                    self._engines.move_to_end(space_id)
                else:
                    target = opens.take_database_target()
                    engine = target.make_async_engine(self._engine_options(space_id))
                    entry = _EngineEntry(
                        identity, target, engine, create_session_factory(engine), 1
                    )
                    self._engines[space_id] = entry
                break
        return EngineHandle(space_id, entry.engine, entry.sessions, lambda: self._release_handle(space_id, entry))

    async def _wait_until_resumed(self, identity: StorageIdentity) -> None:
        while True:
            state = self._draining.get(identity)
            if state is None:
                return
            await state.resumed.wait()

    async def drain_identity(self, identity: StorageIdentity) -> None:
        """Quiesce one bound storage identity until its refs are terminal."""
        owner = asyncio.current_task()
        assert owner is not None
        async with self._lock:
            existing = self._draining.get(identity)
            if existing is not None:
                if existing.owner_task is not owner:
                    raise RuntimeError("drain owner Task changed")
                return
            self._draining[identity] = _DrainState(owner)
        while True:
            async with self._lock:
                active = any(
                    entry.identity == identity and entry.ref_count
                    for entry in self._engines.values()
                )
                if not active:
                    entries = [
                        (space_id, entry)
                        for space_id, entry in self._engines.items()
                        if entry.identity == identity
                    ]
                    for space_id, _entry in entries:
                        self._engines.pop(space_id, None)
                    break
            await asyncio.sleep(0)
        errors: list[BaseException] = []
        for space_id, entry in entries:
            try:
                await self._dispose_entry(space_id, entry)
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise BaseExceptionGroup("identity drain failed", errors)

    async def resume_identity(self, identity: StorageIdentity) -> None:
        owner = asyncio.current_task()
        assert owner is not None
        state = self._draining.get(identity)
        if state is None:
            return
        if state.owner_task is not owner:
            raise RuntimeError("drain owner Task changed")
        self._draining.pop(identity, None)
        state.resumed.set()

    @property
    def draining_identities(self) -> frozenset[StorageIdentity]:
        return frozenset(self._draining)

    async def _release_handle(self, space_id: str, entry: _EngineEntry) -> None:
        async with self._lock:
            if entry.ref_count > 0:
                entry.ref_count -= 1
            if entry.ref_count:
                return
            if self._engines.get(space_id) is entry:
                self._engines.pop(space_id, None)
        await self._dispose_entry(space_id, entry)

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
