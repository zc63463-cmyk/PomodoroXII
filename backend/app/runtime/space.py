from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, AsyncIterator, Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.file_system.interfaces import FileSystem
from app.runtime.leases import Lease, LeaseMode, LeaseOrderError
from app.runtime.scope import AuthorizedSpaceScopeResult

if TYPE_CHECKING:
    from app.space_manager import EngineHandle, SpaceEngineManager


@dataclass(frozen=True, slots=True)
class SpaceHealth:
    space_id: str
    available: bool
    migration_head: str
    index_schema_version: int
    catalog_hash: str
    degraded_reason: str | None = None


@dataclass
class SpaceRuntimeHandle:
    scope: AuthorizedSpaceScopeResult
    engine: EngineHandle | None
    file_system: FileSystem | None
    global_lease: Lease
    space_lease: Lease | None
    owns_global_lease: bool
    owns_space_lease: bool
    fence: int
    _runtime: "SpaceRuntime" = field(repr=False)
    _closed: bool = False

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        if self.engine is None:
            raise LeaseOrderError("Space resources are not active under a lease")
        return self.engine.session_factory

    async def activate_space_resources_under_lease(self, lease: Lease) -> None:
        from app.file_system.api import open_existing_file_system

        lease.assert_active_owner(scope=self.scope.space_id)
        if self.engine is not None or self.file_system is not None:
            raise LeaseOrderError("Space resources are already active")
        engine = None
        file_system = None
        try:
            async with self.scope.containment.open_verified() as opens:
                engine = await self._runtime.engines.acquire(self.scope.space_id, opens)
                file_system = await open_existing_file_system(opens)
        except BaseException:
            if file_system is not None:
                await file_system.close()
            if engine is not None:
                await engine.release()
            raise
        self.engine = engine
        self.file_system = file_system

    async def close_space_resources(self) -> None:
        errors: list[BaseException] = []
        if self.file_system is not None:
            try:
                await self.file_system.close()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.file_system = None
        if self.engine is not None:
            try:
                await self.engine.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.engine = None
        if errors:
            raise BaseExceptionGroup("Space runtime resource close failed", errors)

    async def aclose(self) -> None:
        if self._closed:
            return
        errors: list[BaseException] = []
        try:
            await self.close_space_resources()
        except BaseExceptionGroup as group:
            errors.extend(group.exceptions)
        if self.engine is None and self.file_system is None and self.owns_space_lease and self.space_lease is not None:
            try:
                await self.space_lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.space_lease = None
        if (
            self.engine is None
            and self.file_system is None
            and (not self.owns_space_lease or self.space_lease is None)
            and self.owns_global_lease
        ):
            try:
                await self.global_lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.owns_global_lease = False
        space_done = not self.owns_space_lease or self.space_lease is None
        global_done = not self.owns_global_lease
        self._closed = (
            self.engine is None
            and self.file_system is None
            and space_done
            and global_done
        )
        if errors:
            self._runtime.register_pending_cleanup(self)
            raise BaseExceptionGroup("SpaceRuntimeHandle close failed", errors)

    async def __aenter__(self) -> "SpaceRuntimeHandle":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        try:
            await self.aclose()
        except BaseExceptionGroup as cleanup:
            if exc is not None:
                raise BaseExceptionGroup(
                    "SpaceRuntimeHandle body and cleanup failed", [exc, *cleanup.exceptions]
                ) from None
            raise
        return False


class SpaceRuntime:
    def __init__(self, *, leases, engines: SpaceEngineManager, migrations, index_schema) -> None:
        self.leases = leases
        self.engines = engines
        self.migrations = migrations
        self.index_schema = index_schema

    async def _verify_registered_open(self, scope: AuthorizedSpaceScopeResult) -> None:
        async with scope.containment.open_verified() as opens:
            migration = await self.migrations.verify_open("space", opens.database_target)
            if not migration.at_head:
                raise RuntimeError("registered space migration is not at head")
            index_status = self.index_schema.verify_open(opens.index_target)
            if not index_status.valid:
                raise RuntimeError("registered index schema is not valid")

    async def open_resolved(
        self,
        scope: AuthorizedSpaceScopeResult,
        mode: Literal["read", "mutation"],
        global_lease: Lease,
        *,
        owns_global_lease: bool,
        borrowed_space_lease: Lease | None = None,
    ) -> SpaceRuntimeHandle:
        verified = self._verify_registered_open(scope)
        if inspect.isawaitable(verified):
            await verified
        space_lease = borrowed_space_lease
        owns_space_lease = False
        if mode == "read" and space_lease is None:
            space_lease = await self.leases.acquire_spaces(
                [scope.space_id], LeaseMode.SHARED, "read", 5
            )
            owns_space_lease = True
        handle = SpaceRuntimeHandle(
            scope, None, None, global_lease, space_lease,
            owns_global_lease, owns_space_lease,
            space_lease.fence if space_lease is not None else global_lease.fence,
            self,
        )
        if mode == "read" or borrowed_space_lease is not None:
            assert space_lease is not None
            await handle.activate_space_resources_under_lease(space_lease)
        return handle

    def register_pending_cleanup(self, handle: SpaceRuntimeHandle) -> None:
        dependencies = (handle.space_lease,) if handle.space_lease is not None else ()
        self.leases.register_pending_cleanup(
            handle,
            retry=handle.aclose,
            holds=(handle,),
            physical_terminal=lambda: handle._closed,
            dependencies=dependencies,
        )

    @asynccontextmanager
    async def borrow_prepared_space(
        self, scope: AuthorizedSpaceScopeResult, global_lease: Lease, space_lease: Lease
    ) -> AsyncIterator[SpaceRuntimeHandle]:
        handle = await self.open_resolved(
            scope, "mutation", global_lease,
            owns_global_lease=False, borrowed_space_lease=space_lease,
        )
        space_lease.retain_cleanup_dependency(handle)
        try:
            yield handle
        finally:
            await handle.aclose()
            space_lease.complete_cleanup_dependency(handle)
