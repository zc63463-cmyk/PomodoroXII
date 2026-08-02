from __future__ import annotations

import asyncio
import contextvars
import inspect
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, fields, is_dataclass
from enum import StrEnum
from typing import Literal

from app.auth.authority import Principal
from app.db.migrations import MigrationCoordinator
from app.file_system.index_schema import IndexStoreSchema
from app.registry import CATALOG
from app.registry.catalog import CompiledEntityCatalog
from app.runtime.leases import (
    Lease,
    LeaseMode,
    RuntimeCleanupPendingError,
    RuntimeLeaseCoordinator,
    _ReleaseStage,
)
from app.runtime.scope import AuthorizedSpaceScope
from app.runtime.space import SpaceRuntime
from app.space_manager import SpaceEngineManager


class OwnerExecutorState(StrEnum):
    NEW = "NEW"
    STARTING = "STARTING"
    READY = "READY"
    DRAINING = "DRAINING"
    CLOSED = "CLOSED"
    FAILED = "FAILED"


@dataclass(slots=True)
class _OwnerCommand:
    name: str
    operation: Callable[[], object]
    result: asyncio.Future[object]
    cancellation_requested: asyncio.Event = field(default_factory=asyncio.Event)
    accepted: bool = False


class _RuntimeAdmissionGate:
    """One atomic admission boundary shared by commands and request handles."""

    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._state = OwnerExecutorState.NEW
        self._commands = 0
        self._handles = 0
        self._waiters: deque[object] = deque()

    @property
    def state(self) -> OwnerExecutorState:
        return self._state

    @property
    def active_commands(self) -> int:
        return self._commands

    @property
    def active_handles(self) -> int:
        return self._handles

    async def begin_starting(self) -> None:
        async with self._condition:
            if self._state is not OwnerExecutorState.NEW:
                raise RuntimeError(
                    f"runtime cannot start from {self._state.value}"
                )
            self._state = OwnerExecutorState.STARTING

    async def publish_ready(self) -> None:
        async with self._condition:
            if self._state is not OwnerExecutorState.STARTING:
                raise RuntimeError(
                    f"runtime cannot become ready from {self._state.value}"
                )
            self._state = OwnerExecutorState.READY
            self._condition.notify_all()

    async def begin_draining(self) -> None:
        async with self._condition:
            if self._state is OwnerExecutorState.READY:
                self._state = OwnerExecutorState.DRAINING
            elif self._state in {
                OwnerExecutorState.DRAINING,
                OwnerExecutorState.CLOSED,
                OwnerExecutorState.FAILED,
            }:
                return
            else:
                raise RuntimeError(
                    f"runtime cannot drain from {self._state.value}"
                )
            self._condition.notify_all()

    async def mark_closed(self) -> None:
        async with self._condition:
            self._state = OwnerExecutorState.CLOSED
            self._condition.notify_all()

    async def mark_failed(self) -> None:
        async with self._condition:
            self._state = OwnerExecutorState.FAILED
            self._condition.notify_all()

    async def admit_command(
        self,
        command: _OwnerCommand,
        queue: asyncio.Queue[_OwnerCommand | None],
    ) -> None:
        waiter = object()
        async with self._condition:
            if self._state is not OwnerExecutorState.READY:
                raise RuntimeError(
                    f"owner executor rejects {command.name!r} while "
                    f"{self._state.value}"
                )
            self._waiters.append(waiter)
            try:
                await self._condition.wait_for(
                    lambda: self._state is not OwnerExecutorState.READY
                    or (self._waiters[0] is waiter and not queue.full())
                )
                if self._state is not OwnerExecutorState.READY:
                    raise RuntimeError(
                        f"owner executor rejects {command.name!r} while "
                        f"{self._state.value}"
                    )
                queue.put_nowait(command)
                command.accepted = True
                self._commands += 1
            finally:
                try:
                    self._waiters.remove(waiter)
                except ValueError:
                    pass
                self._condition.notify_all()

    async def command_dequeued(self) -> None:
        async with self._condition:
            self._condition.notify_all()

    async def command_completed(self) -> None:
        async with self._condition:
            if self._commands < 1:
                raise RuntimeError("owner command admission settled twice")
            self._commands -= 1
            self._condition.notify_all()

    async def admit_handle(self) -> "_HandleAdmission":
        async with self._condition:
            if self._state is not OwnerExecutorState.READY:
                raise RuntimeError(
                    f"runtime rejects handle open while {self._state.value}"
                )
            self._handles += 1
            return _HandleAdmission(self)

    async def complete_handle(self) -> None:
        async with self._condition:
            if self._handles < 1:
                raise RuntimeError("runtime handle admission settled twice")
            self._handles -= 1
            self._condition.notify_all()

    async def wait_until_drained(self) -> None:
        async with self._condition:
            await self._condition.wait_for(
                lambda: self._commands == 0 and self._handles == 0
            )

    def assert_ready(self) -> None:
        if (
            self._state is not OwnerExecutorState.READY
            or self._commands
            or self._handles
        ):
            raise RuntimeError("runtime admission gate is not idle and READY")


@dataclass(slots=True)
class _HandleAdmission:
    gate: _RuntimeAdmissionGate
    completed: bool = False

    async def complete(self) -> None:
        if self.completed:
            return
        self.completed = True
        await self.gate.complete_handle()


@dataclass(slots=True)
class _OwnerTaskExecutor:
    leases: object
    purpose: str
    queue_size: int = 32
    gate: _RuntimeAdmissionGate = field(
        default_factory=_RuntimeAdmissionGate, repr=False
    )
    startup: Callable[[], object] | None = field(default=None, repr=False)
    cleanup: Callable[[], object] | None = field(default=None, repr=False)
    owner_task: asyncio.Task[None] | None = field(default=None, init=False)
    _queue: asyncio.Queue[_OwnerCommand | None] = field(init=False, repr=False)
    _started: asyncio.Future[None] | None = field(default=None, init=False, repr=False)
    _closed: asyncio.Future[None] | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.queue_size < 1:
            raise ValueError("owner command queue_size must be positive")
        self._queue = asyncio.Queue(maxsize=self.queue_size)

    @property
    def state(self) -> OwnerExecutorState:
        return self.gate.state

    _retained_owner: object | None = field(default=None, init=False, repr=False)

    async def start(self) -> object | None:
        await self.gate.begin_starting()
        loop = asyncio.get_running_loop()
        self._started = loop.create_future()
        self._closed = loop.create_future()
        self.owner_task = asyncio.create_task(
            self._run(),
            name=f"pomodoroxii-owner:{self.purpose}",
            context=contextvars.Context(),
        )
        return await asyncio.shield(self._started)

    async def submit(self, name: str, operation: Callable[[], object]):
        result = asyncio.get_running_loop().create_future()
        command = _OwnerCommand(name, operation, result)
        try:
            await self.gate.admit_command(command, self._queue)
            return await asyncio.shield(result)
        except asyncio.CancelledError as cancelled:
            if not command.accepted:
                raise
            command.cancellation_requested.set()
            while not result.done():
                try:
                    await asyncio.shield(result)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if result.done() and not result.cancelled():
                result.exception()
            raise cancelled

    async def shutdown(self) -> None:
        if self.state is OwnerExecutorState.CLOSED:
            return
        if self.state is OwnerExecutorState.FAILED:
            assert self._closed is not None
            await asyncio.shield(self._closed)
            return
        if self.state is OwnerExecutorState.NEW:
            await self.gate.mark_closed()
            return
        if self.state is not OwnerExecutorState.DRAINING:
            await self.gate.begin_draining()
            await self.gate.wait_until_drained()
            await self._queue.put(None)
        assert self._closed is not None
        await asyncio.shield(self._closed)

    async def _run(self) -> None:
        owner = None
        failure: BaseException | None = None
        startup_value: object | None = None
        try:
            owner = await self.leases.acquire_process_owner(self.purpose, 5)
            if self.startup is not None:
                startup_value = self.startup()
                if inspect.isawaitable(startup_value):
                    startup_value = await startup_value
            await self.gate.publish_ready()
            assert self._started is not None
            if not self._started.done():
                self._started.set_result(startup_value)
            while True:
                command = await self._queue.get()
                try:
                    if command is None:
                        break
                    await self.gate.command_dequeued()
                    try:
                        value = (
                            command.operation(command.cancellation_requested)
                            if getattr(
                                command.operation,
                                "_pxii_accepts_cancellation",
                                False,
                            )
                            else command.operation()
                        )
                        if inspect.isawaitable(value):
                            value = await value
                        _assert_authority_free_result(value)
                    except BaseException as error:
                        if not command.result.done():
                            command.result.set_exception(error)
                    else:
                        if not command.result.done():
                            command.result.set_result(value)
                finally:
                    if command is not None:
                        await self.gate.command_completed()
                    self._queue.task_done()
        except BaseException as error:
            failure = error
            await self.gate.mark_failed()
            if self._started is not None and not self._started.done():
                self._started.set_exception(error)
        finally:
            cleanup_errors: list[BaseException] = []
            if owner is not None and self.cleanup is not None:
                try:
                    value = self.cleanup()
                    if inspect.isawaitable(value):
                        await value
                except BaseException as error:
                    cleanup_errors.extend(_flatten_error(error))
                    await self.gate.mark_failed()
            if owner is not None and not cleanup_errors:
                try:
                    await owner.release()
                except BaseException as error:
                    cleanup_errors.extend(_flatten_error(error))
                    await self.gate.mark_failed()
            if cleanup_errors:
                self._retained_owner = owner
                failure = (
                    BaseExceptionGroup(
                        "owner executor and cleanup failed",
                        [failure, *cleanup_errors],
                    )
                    if failure is not None
                    else BaseExceptionGroup(
                        "owner executor cleanup failed", cleanup_errors
                    )
                )
            if failure is None:
                await self.gate.mark_closed()
            if self._closed is not None and not self._closed.done():
                if failure is None:
                    self._closed.set_result(None)
                else:
                    self._closed.set_exception(failure)


def _flatten_error(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        flattened: list[BaseException] = []
        for nested in error.exceptions:
            flattened.extend(_flatten_error(nested))
        return flattened
    return [error]


def _assert_authority_free_result(value: object) -> None:
    if value is None or type(value) in {str, int, float, bool}:
        return
    if isinstance(value, (tuple, frozenset)):
        for item in value:
            _assert_authority_free_result(item)
        return
    if is_dataclass(value) and not isinstance(value, type):
        parameters = getattr(type(value), "__dataclass_params__", None)
        if parameters is not None and parameters.frozen:
            for item in fields(value):
                _assert_authority_free_result(getattr(value, item.name))
            return
    raise TypeError("owner command results must be immutable and authority-free")


class _AdmissionLeaseCoordinator:
    """Admit request/MCP global-shared leases through the runtime gate."""

    def __init__(
        self, coordinator: RuntimeLeaseCoordinator, gate: _RuntimeAdmissionGate
    ) -> None:
        self._coordinator = coordinator
        self._gate = gate

    def __getattr__(self, name: str):
        return getattr(self._coordinator, name)

    async def acquire_global(
        self,
        mode: LeaseMode,
        purpose: str,
        timeout_seconds: float,
    ) -> Lease:
        admission = None
        if mode is LeaseMode.SHARED and purpose == "request":
            admission = await self._gate.admit_handle()
        try:
            lease = await self._coordinator.acquire_global(
                mode, purpose, timeout_seconds
            )
        except BaseException:
            if admission is not None:
                await admission.complete()
            raise
        if admission is not None:
            lease._release_stages.append(_ReleaseStage(admission.complete))
        return lease


@dataclass(frozen=True, slots=True)
class RuntimeServices:
    runtime: SpaceRuntime
    scope: "_FreshAuthorizedSpaceScope"
    credential_verifier: Callable[
        [str, Literal["master", "space"] | None], Awaitable[Principal]
    ]
    catalog: CompiledEntityCatalog
    executor: _OwnerTaskExecutor
    recovery_provider: object
    mutation_uow: object


@dataclass(frozen=True, slots=True)
class _FreshAuthorizedSpaceScope:
    runtime: SpaceRuntime

    async def open(
        self,
        principal: Principal,
        space_id: str,
        mode: Literal["read", "write"],
    ):
        from app.db.meta_session import get_meta_session_factory
        from app.settings import settings

        factory = get_meta_session_factory()
        async with factory() as session:
            return await AuthorizedSpaceScope(
                session, settings.canonical_spaces_root, self.runtime
            ).open(principal, space_id, mode)


async def _startup_owned(
    executor: _OwnerTaskExecutor,
    runtime: SpaceRuntime,
    migrations: MigrationCoordinator,
) -> RuntimeServices:
    from app.auth.authority import (
        bootstrap_credential_epoch,
        verify_with_fresh_meta_session,
    )
    from app.db.meta_session import init_meta_db
    from app.settings import settings
    from app.task_space.migration_preflight import TaskSpaceCutoverPreflight

    global_lease = await runtime.leases.acquire_global(
        LeaseMode.EXCLUSIVE, "startup-migration", 60
    )
    async with global_lease:
        fleet = await runtime.preflight_registered_fleet(
            migrations,
            settings.meta_db_path,
            global_lease,
            policies=(TaskSpaceCutoverPreflight(),),
        )
        await migrations.upgrade_under_lease(
            "meta", settings.meta_db_path, global_lease
        )
        await init_meta_db()
        await bootstrap_credential_epoch()
        catalog = CATALOG
        if runtime.recovery_provider is None:
            from app.file_system.engine.base import FileSystemProjectionExecutor
            from app.mutation.journal import MutationJournal
            from app.mutation.recovery import MutationRecovery
            from app.mutation.unit_of_work import (
                DbMutationInterpreter,
                MutationCompiler,
                MutationUnitOfWork,
            )

            interpreter = DbMutationInterpreter(catalog)
            projection_executor = FileSystemProjectionExecutor()
            recovery = MutationRecovery(
                catalog=catalog,
                interpreter=interpreter,
                projection_executor=projection_executor,
            )
            from app.commands import FolderDomainPolicy, RelationDomainPolicy
            from app.knowledge.projections import KnowledgeDomainPolicy

            runtime.install_recovery_provider(
                MutationUnitOfWork(
                    catalog=catalog,
                    compiler=MutationCompiler(
                        catalog,
                        policies=(
                            FolderDomainPolicy(),
                            RelationDomainPolicy(),
                            KnowledgeDomainPolicy(),
                        ),
                    ),
                    interpreter=interpreter,
                    projection_executor=projection_executor,
                    recovery_gate=recovery,
                    journal_factory=MutationJournal,
                )
            )
        await runtime.prepare_registered_spaces(catalog, global_lease, fleet)
    return RuntimeServices(
        runtime=runtime,
        scope=_FreshAuthorizedSpaceScope(runtime),
        credential_verifier=verify_with_fresh_meta_session,
        catalog=catalog,
        executor=executor,
        recovery_provider=runtime.recovery_provider,
        mutation_uow=runtime.recovery_provider,
    )


async def _shutdown_owned(
    runtime: SpaceRuntime,
    engines: SpaceEngineManager,
) -> None:
    from app.db.meta_session import close_meta_db

    errors: list[BaseException] = []
    errors.extend(
        await runtime.leases.retry_pending_cleanups_for_current_task()
    )
    try:
        await engines.dispose_all()
    except BaseException as error:
        errors.extend(_flatten_error(error))
    try:
        await close_meta_db()
    except BaseException as error:
        errors.extend(_flatten_error(error))
    errors.extend(
        await runtime.leases.retry_pending_cleanups_for_current_task()
    )
    if runtime.leases.has_pending_cleanups_for_current_task():
        errors.append(
            RuntimeCleanupPendingError(
                "runtime cleanup remains owned by the process owner Task"
            )
        )
    try:
        runtime.leases.assert_ready()
    except BaseException as error:
        errors.extend(_flatten_error(error))
    if errors:
        raise BaseExceptionGroup("runtime shutdown failed", errors)


@asynccontextmanager
async def bootstrap_runtime(purpose: str) -> AsyncIterator[RuntimeServices]:
    from app.settings import settings

    raw_leases = RuntimeLeaseCoordinator(settings.data_root)
    gate = _RuntimeAdmissionGate()
    leases = _AdmissionLeaseCoordinator(raw_leases, gate)
    engines = SpaceEngineManager()
    migrations = MigrationCoordinator(raw_leases, engines)
    runtime = SpaceRuntime(
        leases=leases,
        engines=engines,
        migrations=migrations,
        index_schema=IndexStoreSchema(),
    )
    executor = _OwnerTaskExecutor(
        leases=leases,
        purpose=purpose,
        queue_size=32,
        gate=gate,
    )
    runtime.install_owner_executor(executor)
    executor.startup = lambda: _startup_owned(executor, runtime, migrations)
    executor.cleanup = lambda: _shutdown_owned(runtime, engines)
    services = await executor.start()
    if not isinstance(services, RuntimeServices):
        raise RuntimeError("owner executor did not publish RuntimeServices")
    try:
        yield services
    except BaseException as primary:
        try:
            await executor.shutdown()
        except BaseException as cleanup:
            raise BaseExceptionGroup(
                "runtime bootstrap/body and cleanup failed",
                [primary, *_flatten_error(cleanup)],
            ) from None
        raise
    else:
        await executor.shutdown()
