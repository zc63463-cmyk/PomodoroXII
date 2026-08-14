from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import BinaryIO, Literal, Mapping

import portalocker
from filelock import FileLock
from filelock import Timeout as FileLockTimeout

from app.runtime.durability import next_fence
from app.runtime.joined_thread import run_joined_awaitable, run_joined_thread


class _FairRwLock:
    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._active_readers = 0
        self._writer_active = False
        self._waiting_writers = 0

    async def acquire(self, mode: LeaseMode) -> Callable[[], Awaitable[None]]:
        if mode is LeaseMode.SHARED:
            async with self._condition:
                await self._condition.wait_for(
                    lambda: not self._writer_active and self._waiting_writers == 0
                )
                self._active_readers += 1
        else:
            async with self._condition:
                self._waiting_writers += 1
                try:
                    await self._condition.wait_for(
                        lambda: not self._writer_active and self._active_readers == 0
                    )
                    self._writer_active = True
                finally:
                    self._waiting_writers -= 1
                    self._condition.notify_all()

        async def release() -> None:
            async with self._condition:
                if mode is LeaseMode.SHARED:
                    if self._active_readers <= 0:
                        raise RuntimeError("shared lease released without an owner")
                    self._active_readers -= 1
                else:
                    if not self._writer_active:
                        raise RuntimeError("exclusive lease released without an owner")
                    self._writer_active = False
                self._condition.notify_all()

        return release


class LeaseMode(StrEnum):
    SHARED = "shared"
    EXCLUSIVE = "exclusive"


class LeaseTimeoutError(RuntimeError):
    code = "lease_timeout"
    retryable = True


class LeaseOrderError(RuntimeError):
    code = "lease_order_invalid"
    retryable = False


class StaleFenceError(RuntimeError):
    code = "stale_fence"
    retryable = False


Release = Callable[[], Awaitable[None]]


def _flatten_exceptions(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in _flatten_exceptions(child)]
    return [error]


@dataclass
class ProcessOwnerReceipt:
    coordinator_id: int
    root: str
    owner_task: object
    active: bool = True

    def deactivate(self) -> None:
        self.active = False

    def assert_current(self) -> None:
        held = _HELD_ORDER.get()
        if (
            not self.active
            or asyncio.current_task() is not self.owner_task
            or held.coordinator_id != self.coordinator_id
            or held.root != self.root
            or held.process_owner is not self
        ):
            raise LeaseOrderError("process-owner receipt is no longer live")


@dataclass
class _HeldOrder:
    coordinator_id: int | None
    root: str | None
    owner_task: object | None
    level: Literal["none", "owner", "global", "spaces"]
    process_owner: ProcessOwnerReceipt | None = None
    space_ids: tuple[str, ...] = ()
    lease: Lease | None = None


_HELD_ORDER: ContextVar[_HeldOrder] = ContextVar(
    "runtime_lease_order", default=_HeldOrder(None, None, None, "none")
)


async def _release_process_owner(
    lock: FileLock, receipt: ProcessOwnerReceipt
) -> None:
    await run_joined_thread(
        lock.release,
        on_success=lambda _ignored: receipt.deactivate(),
    )


def _unlock_and_close(stream: BinaryIO) -> None:
    if stream.closed:
        return
    # Keep the stream and OS lock live when unlock fails so the same owner can
    # retry a proven unlock instead of treating close as equivalent evidence.
    portalocker.unlock(stream)
    stream.close()


@dataclass
class _PortalHandle:
    stream: BinaryIO
    released: bool = False

    async def release(self) -> None:
        if self.released:
            return
        await run_joined_thread(
            lambda: _unlock_and_close(self.stream),
            on_success=lambda _ignored: self._commit_released(),
        )

    def _commit_released(self) -> None:
        self.released = True


async def _acquire_portal_handle(
    path: Path,
    mode: LeaseMode,
    deadline: float,
    owned_handles: list[_PortalHandle],
) -> _PortalHandle:
    path.parent.mkdir(parents=True, exist_ok=True)
    flag = (
        portalocker.LockFlags.SHARED
        if mode is LeaseMode.SHARED
        else portalocker.LockFlags.EXCLUSIVE
    )
    stream = await run_joined_thread(
        lambda: path.open("a+b"),
        dispose_cancelled_result=lambda value: value.close(),
    )
    handle = _PortalHandle(stream)
    # Publish ownership synchronously before the first lock await. Any later
    # failure is therefore visible to the caller's unified release sequence.
    owned_handles.append(handle)
    while True:
        try:
            await run_joined_thread(
                lambda: portalocker.lock(
                    stream, flag | portalocker.LockFlags.NON_BLOCKING
                )
            )
            return handle
        except portalocker.exceptions.LockException as exc:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise LeaseTimeoutError(
                    f"runtime lease busy: {path.name}"
                ) from exc
            await asyncio.sleep(min(0.01, remaining))


@dataclass
class _CrossProcessRwLease:
    handles: tuple[_PortalHandle, ...]

    async def release(self) -> None:
        errors: list[BaseException] = []
        for handle in self.handles:
            try:
                await handle.release()
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise BaseExceptionGroup("cross-process RW release failed", errors)


@dataclass
class _ReleaseStage:
    callback: Release
    physical_terminal: Callable[[], bool] | None = None
    completed: bool = False

    async def run(self) -> None:
        if self.completed:
            return
        try:
            await run_joined_awaitable(
                self.callback(),
                on_success=lambda _ignored: self._commit_completed(),
            )
        except BaseException:
            if self.physical_terminal is not None and self.physical_terminal():
                self._commit_completed()
            raise

    def _commit_completed(self) -> None:
        self.completed = True


@dataclass
class _ReleaseSequence:
    owner_task: object
    stages: list[_ReleaseStage]
    holds: tuple[object, ...]

    @property
    def completed(self) -> bool:
        return all(stage.completed for stage in self.stages)

    async def run(self) -> None:
        if asyncio.current_task() is not self.owner_task:
            raise LeaseOrderError("cleanup sequence belongs to another asyncio Task")
        errors: list[BaseException] = []
        for stage in self.stages:
            if stage.completed:
                continue
            try:
                await stage.run()
            except BaseExceptionGroup as group:
                errors.extend(_flatten_exceptions(group))
                if not stage.completed:
                    break
            except BaseException as error:
                errors.append(error)
                if not stage.completed:
                    break
        if errors:
            raise BaseExceptionGroup("release sequence failed", errors)
        if not self.completed:
            raise RuntimeError("release sequence stopped before physical terminal state")


class RuntimeCleanupPendingError(RuntimeError):
    code = "runtime_cleanup_pending"
    retryable = False


@dataclass
class PendingCleanup:
    owner_task: object
    retry: Release
    holds: tuple[object, ...]
    physical_terminal: Callable[[], bool]
    on_complete: Callable[[], None] | None = None
    completed: bool = False
    attempts: int = 0

    async def run(self) -> None:
        if asyncio.current_task() is not self.owner_task:
            raise LeaseOrderError("pending cleanup belongs to another asyncio Task")
        self.attempts += 1
        try:
            await self.retry()
        except BaseException:
            if self.physical_terminal():
                self._commit_completed()
            raise
        if not self.physical_terminal():
            raise RuntimeError("pending retry returned before physical terminal state")
        self._commit_completed()

    def _commit_completed(self) -> None:
        if self.completed:
            return
        if self.on_complete is not None:
            self.on_complete()
        self.completed = True


@dataclass
class _AcquiredRw:
    local_release: Release
    portal_handles: list[_PortalHandle] = field(default_factory=list)


async def _acquire_cross_process_rw(
    turnstile_path: Path,
    data_path: Path,
    mode: LeaseMode,
    deadline: float,
    owned_handles: list[_PortalHandle],
) -> _CrossProcessRwLease:
    turnstile = await _acquire_portal_handle(
        turnstile_path,
        LeaseMode.EXCLUSIVE if mode is LeaseMode.EXCLUSIVE else LeaseMode.SHARED,
        deadline,
        owned_handles,
    )
    data = await _acquire_portal_handle(
        data_path, mode, deadline, owned_handles
    )
    if mode is LeaseMode.SHARED:
        await turnstile.release()
        return _CrossProcessRwLease((data,))
    # Physical release order is data then turnstile.
    return _CrossProcessRwLease((data, turnstile))


@dataclass
class FenceReceipt:
    scope: str
    expected: int
    path: Path = field(repr=False)

    def assert_current(self) -> None:
        actual = int(self.path.read_text(encoding="ascii"))
        if actual != self.expected:
            raise StaleFenceError(f"stale fence for {self.scope}")


@dataclass
class Lease:
    purpose: str
    mode: LeaseMode
    fence: int
    space_ids: tuple[str, ...]
    fences: Mapping[str, int]
    process_owner: ProcessOwnerReceipt | None
    _parent_lease: Lease | None = field(repr=False)
    _fence_paths: Mapping[str, Path] = field(repr=False)
    _release_stages: list[_ReleaseStage] = field(repr=False)
    _entered_order: _HeldOrder = field(repr=False)
    _retain_pending: Callable[[object], None] = field(repr=False)
    _complete_pending: Callable[[object], None] = field(repr=False)
    _cleanup_dependencies: dict[int, object] = field(default_factory=dict, repr=False)
    _order_token: Token[_HeldOrder] | None = field(
        default=None, repr=False
    )
    _owner_task: object | None = field(default_factory=asyncio.current_task, repr=False)
    _release_started: bool = field(default=False, repr=False)
    _order_reset: bool = field(default=False, repr=False)
    _released: bool = field(default=False, repr=False)

    async def __aenter__(self) -> "Lease":
        self.assert_active_owner()
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        cleanup_errors: list[BaseException] = []
        try:
            await self.release()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
        except BaseException as cleanup:
            cleanup_errors.append(cleanup)
        if exc is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "lease body and release failed", [exc, *cleanup_errors]
            ) from None
        if cleanup_errors:
            raise BaseExceptionGroup("lease release failed", cleanup_errors) from None
        return False

    def assert_active_owner(
        self,
        *,
        mode: LeaseMode | None = None,
        scope: str | None = None,
        require_process_owner: bool = False,
    ) -> None:
        if (
            self._released
            or self._release_started
            or asyncio.current_task() is not self._owner_task
        ):
            raise LeaseOrderError("lease is not active in its acquiring asyncio Task")
        if mode is not None and self.mode is not mode:
            raise LeaseOrderError(f"lease mode must be {mode.value}")
        if scope is not None and scope not in self.fences:
            raise LeaseOrderError(f"lease does not own fence scope {scope}")
        if require_process_owner:
            if self.process_owner is None:
                raise LeaseOrderError("destructive lease requires process-owner lineage")
            self.process_owner.assert_current()

    def retain_cleanup_dependency(self, owner: object) -> None:
        self.assert_active_owner()
        self._cleanup_dependencies[id(owner)] = owner

    def complete_cleanup_dependency(self, owner: object) -> None:
        self.assert_active_owner()
        self._cleanup_dependencies.pop(id(owner), None)

    def fence_receipt(self, scope: str) -> FenceReceipt:
        self.assert_active_owner(scope=scope)
        return FenceReceipt(scope, self.fences[scope], self._fence_paths[scope])

    def assert_fence(self, scope: str) -> None:
        self.fence_receipt(scope).assert_current()

    async def release(self) -> None:
        if self._released:
            if asyncio.current_task() is not self._owner_task:
                raise LeaseOrderError("released lease belongs to another asyncio Task")
            return
        if asyncio.current_task() is not self._owner_task:
            raise LeaseOrderError("lease release belongs to another asyncio Task")
        if _HELD_ORDER.get() != self._entered_order:
            self._retain_pending(self)
            raise LeaseOrderError("lease release violates strict reverse acquisition order")
        if self._cleanup_dependencies:
            raise LeaseOrderError("lease still owns unfinished resource cleanup")
        self._release_started = True
        errors: list[BaseException] = []
        for stage in self._release_stages:
            try:
                await stage.run()
            except BaseExceptionGroup as group:
                errors.extend(_flatten_exceptions(group))
                if not stage.completed:
                    break
            except BaseException as exc:
                errors.append(exc)
                if not stage.completed:
                    # Later stages may depend on this resource still being held.
                    break
        if errors:
            self._retain_pending(self)
            raise BaseExceptionGroup("lease release failed", errors)
        if not all(stage.completed for stage in self._release_stages):
            raise RuntimeError("lease release stopped with unfinished stages")
        if self._order_token is not None and not self._order_reset:
            _HELD_ORDER.reset(self._order_token)
            self._order_reset = True
        self._released = True
        self._complete_pending(self)


class RuntimeLeaseCoordinator:
    REQUEST_TIMEOUT_SECONDS = 5.0
    MAINTENANCE_TIMEOUT_SECONDS = 60.0

    def __init__(
        self,
        data_root: Path,
        *,
        coordination_root: Path | None = None,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._root = Path(data_root).expanduser().resolve()
        # Coordination state must be stable while recovery cutover renames the
        # data root. Keep the default alongside the mutable root; callers that
        # need a distinct layout may still pass an explicit coordination root.
        self._runtime_dir = (
            self._root.parent / f".{self._root.name}.runtime"
            if coordination_root is None
            else Path(coordination_root).expanduser().resolve()
        )
        self._lock_dir = self._runtime_dir / "locks"
        self._fence_dir = self._runtime_dir / "fences"
        self._runtime_dir.mkdir(parents=True, exist_ok=True)
        self._global_gate = _FairRwLock()
        self._space_gates: dict[str, _FairRwLock] = {}
        self._space_gates_guard = asyncio.Lock()
        self._failpoint = failpoint or (lambda _name: None)
        self._pending_cleanups: dict[int, PendingCleanup] = {}
        self._process_exit_required = False
        self._process_exit_holds: list[object] = []

    def register_pending_cleanup(
        self,
        owner: object,
        *,
        retry: Release,
        holds: tuple[object, ...],
        physical_terminal: Callable[[], bool],
        dependencies: tuple[Lease, ...] = (),
    ) -> None:
        owner_task = asyncio.current_task()
        assert owner_task is not None
        key = id(owner)
        existing = self._pending_cleanups.get(key)
        if existing is not None:
            if existing.owner_task is not owner_task:
                raise LeaseOrderError("pending cleanup owner Task changed")
            return
        for dependency in dependencies:
            dependency.retain_cleanup_dependency(owner)

        def complete_dependencies() -> None:
            for dependency in reversed(dependencies):
                dependency.complete_cleanup_dependency(owner)

        self._pending_cleanups[key] = PendingCleanup(
            owner_task,
            retry,
            (owner, *holds, *dependencies),
            physical_terminal,
            complete_dependencies,
        )

    def complete_pending_cleanup(self, owner: object) -> None:
        pending = self._pending_cleanups.get(id(owner))
        if pending is None:
            return
        if asyncio.current_task() is not pending.owner_task:
            raise LeaseOrderError("pending cleanup completion changed Task")
        if not pending.physical_terminal():
            raise RuntimeError("cannot remove nonterminal pending cleanup")
        pending._commit_completed()
        self._pending_cleanups.pop(id(owner))

    def register_pending_lease_cleanup(self, lease: Lease) -> None:
        dependencies = (
            (lease._parent_lease,) if lease._parent_lease is not None else ()
        )
        self.register_pending_cleanup(
            lease,
            retry=lease.release,
            holds=(lease.process_owner, lease._parent_lease, *lease._release_stages),
            physical_terminal=lambda: (
                lease._released
                and all(stage.completed for stage in lease._release_stages)
            ),
            dependencies=dependencies,
        )

    def complete_pending_lease_cleanup(self, lease: Lease) -> None:
        self.complete_pending_cleanup(lease)

    async def retry_pending_cleanups_for_current_task(
        self,
    ) -> tuple[BaseException, ...]:
        owner_task = asyncio.current_task()
        errors: list[BaseException] = []
        # Newer child owners release before older parents.
        for key, pending in reversed(tuple(self._pending_cleanups.items())):
            if pending.owner_task is not owner_task:
                continue
            try:
                await pending.run()
            except BaseExceptionGroup as group:
                errors.extend(_flatten_exceptions(group))
            except BaseException as error:
                errors.append(error)
            if pending.completed or pending.physical_terminal():
                pending._commit_completed()
                self._pending_cleanups.pop(key, None)
                continue
            if errors:
                self.mark_process_exit_required(
                    "pending cleanup did not converge",
                    holds=pending.holds,
                )
            break
        return tuple(errors)

    def has_pending_cleanups_for_current_task(self) -> bool:
        owner_task = asyncio.current_task()
        return any(
            pending.owner_task is owner_task
            for pending in self._pending_cleanups.values()
        )

    def pending_cleanups_for_current_task(self) -> tuple[PendingCleanup, ...]:
        owner_task = asyncio.current_task()
        return tuple(
            pending
            for pending in self._pending_cleanups.values()
            if pending.owner_task is owner_task
        )

    def mark_process_exit_required(
        self, reason: str, *, holds: tuple[object, ...]
    ) -> None:
        self._process_exit_required = True
        self._process_exit_holds.extend((reason, *holds))

    def assert_ready(self) -> None:
        if self._process_exit_required or self._pending_cleanups:
            raise RuntimeCleanupPendingError("runtime cleanup is not terminal")

    async def acquire_process_owner(
        self, purpose: str, timeout_seconds: float
    ) -> Lease:
        held = _HELD_ORDER.get()
        if held.level != "none":
            raise LeaseOrderError("process owner must be acquired first")
        lock = FileLock(
            str(self._runtime_dir / "process-owner.lock"), thread_local=False
        )
        acquired = False
        receipt: ProcessOwnerReceipt | None = None
        token: Token[_HeldOrder] | None = None

        def commit_acquired(_ignored: object) -> None:
            nonlocal acquired
            acquired = True

        try:
            await run_joined_thread(
                lambda: lock.acquire(timeout=timeout_seconds),
                on_success=commit_acquired,
            )
            self._failpoint("after_os_acquire")
            fence_path = self._fence_dir / "process.fence"
            fence = await run_joined_thread(lambda: next_fence(fence_path))
            self._failpoint("during_fence_write")
            self._failpoint("corrupt_fence_receipt")
            if (
                type(fence) is not int
                or fence < 1
                or not fence_path.is_file()
                or int(fence_path.read_text(encoding="ascii")) != fence
            ):
                raise StaleFenceError("corrupt process-owner fence receipt")
            receipt = ProcessOwnerReceipt(
                id(self), str(self._root), asyncio.current_task()
            )
            self._failpoint("after_receipt")
            entered = _HeldOrder(
                id(self), str(self._root), asyncio.current_task(), "owner", receipt
            )
            token = _HELD_ORDER.set(entered)
            self._failpoint("after_context_token")
            lease = Lease(
                purpose=purpose,
                mode=LeaseMode.EXCLUSIVE,
                fence=fence,
                space_ids=(),
                fences=MappingProxyType({"process": fence}),
                process_owner=receipt,
                _parent_lease=None,
                _fence_paths=MappingProxyType({"process": fence_path}),
                _release_stages=[
                    _ReleaseStage(lambda: _release_process_owner(lock, receipt))
                ],
                _entered_order=entered,
                _retain_pending=self.register_pending_lease_cleanup,
                _complete_pending=self.complete_pending_lease_cleanup,
                _order_token=token,
            )
            entered.lease = lease
            self._failpoint("before_lease_return")
            return lease
        except FileLockTimeout as exc:
            raise LeaseTimeoutError(f"process owner busy: {purpose}") from exc
        except BaseException as primary:
            cleanup_errors: list[BaseException] = []
            release_terminal = not acquired
            if acquired:
                try:
                    await run_joined_thread(
                        lock.release,
                        on_success=(
                            (lambda _ignored: receipt.deactivate())
                            if receipt is not None
                            else None
                        ),
                    )
                except BaseException as cleanup:
                    cleanup_errors.append(cleanup)
                release_terminal = (
                    not receipt.active if receipt is not None else not lock.is_locked
                )
            if release_terminal and token is not None:
                _HELD_ORDER.reset(token)
            if cleanup_errors and not release_terminal:
                self._process_exit_required = True
                self._process_exit_holds.extend([lock, receipt, token])
                raise BaseExceptionGroup(
                    "process-owner acquire and compensation failed",
                    [primary, *cleanup_errors],
                ) from None
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "process-owner acquire failed after terminal compensation",
                    [primary, *cleanup_errors],
                ) from None
            raise primary

    async def acquire_global(
        self, mode: LeaseMode, purpose: str, timeout_seconds: float
    ) -> Lease:
        held = _HELD_ORDER.get()
        if held.level != "none" and held.owner_task is not asyncio.current_task():
            raise LeaseOrderError("inherited lease order belongs to another asyncio Task")
        if held.level not in {"none", "owner"}:
            raise LeaseOrderError("global lease must be acquired first")
        if held.level == "owner" and (
            held.coordinator_id != id(self) or held.root != str(self._root)
        ):
            raise LeaseOrderError("process owner belongs to another coordinator/root")
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        acquired: list[_AcquiredRw] = []
        try:
            remaining = max(0.0, deadline - asyncio.get_running_loop().time())
            local_release = await asyncio.wait_for(
                self._global_gate.acquire(mode), timeout=remaining
            )
            item = _AcquiredRw(local_release)
            acquired.append(item)
            await _acquire_cross_process_rw(
                self._lock_dir / "global.turnstile",
                self._lock_dir / "global.data",
                mode,
                deadline,
                item.portal_handles,
            )
            fence_path = self._fence_dir / "global.fence"
            fence = (
                await run_joined_thread(lambda: next_fence(fence_path))
                if mode is LeaseMode.EXCLUSIVE
                else self._read_fence(fence_path)
            )
        except BaseException as error:
            primary = (
                LeaseTimeoutError(f"global lease timeout: {purpose}")
                if isinstance(error, (TimeoutError, LeaseTimeoutError))
                else error
            )
            await self._release_acquired(acquired, primary)
            raise AssertionError("_release_acquired never returns")
        sequence = self._acquisition_release_sequence(acquired)
        entered = _HeldOrder(
            id(self),
            str(self._root),
            asyncio.current_task(),
            "global",
            held.process_owner,
        )
        token = _HELD_ORDER.set(entered)
        lease = Lease(
            purpose=purpose,
            mode=mode,
            fence=fence,
            space_ids=(),
            fences=MappingProxyType({"global": fence}),
            process_owner=held.process_owner,
            _parent_lease=held.lease,
            _fence_paths=MappingProxyType({"global": fence_path}),
            _release_stages=sequence.stages,
            _entered_order=entered,
            _retain_pending=self.register_pending_lease_cleanup,
            _complete_pending=self.complete_pending_lease_cleanup,
            _order_token=token,
        )
        entered.lease = lease
        return lease

    async def acquire_spaces(
        self,
        space_ids: list[str] | tuple[str, ...],
        mode: LeaseMode,
        purpose: str,
        timeout_seconds: float,
    ) -> Lease:
        canonical = tuple(sorted(set(space_ids)))
        if not canonical or any(not value.strip() for value in canonical):
            raise ValueError("space_ids must contain non-empty IDs")
        held = _HELD_ORDER.get()
        if (
            held.level != "global"
            or held.coordinator_id != id(self)
            or held.root != str(self._root)
            or held.owner_task is not asyncio.current_task()
        ):
            raise LeaseOrderError("space leases require a held global lease")
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        acquired: list[_AcquiredRw] = []
        fences: dict[str, int] = {}
        fence_paths: dict[str, Path] = {}
        try:
            for space_id in canonical:
                gate = await self._space_gate(space_id)
                remaining = max(0.0, deadline - asyncio.get_running_loop().time())
                local_release = await asyncio.wait_for(
                    gate.acquire(mode), timeout=remaining
                )
                item = _AcquiredRw(local_release)
                acquired.append(item)
                await _acquire_cross_process_rw(
                    self._space_turnstile_path(space_id),
                    self._space_data_path(space_id),
                    mode,
                    deadline,
                    item.portal_handles,
                )
                fence_path = self._space_fence_path(space_id)
                fence_paths[space_id] = fence_path
                fences[space_id] = (
                    await run_joined_thread(lambda: next_fence(fence_path))
                    if mode is LeaseMode.EXCLUSIVE
                    else self._read_fence(fence_path)
                )
        except BaseException as error:
            primary = (
                LeaseTimeoutError(f"space lease timeout: {purpose}")
                if isinstance(error, (TimeoutError, LeaseTimeoutError))
                else error
            )
            await self._release_acquired(acquired, primary)
            raise AssertionError("_release_acquired never returns")
        entered = _HeldOrder(
            id(self),
            str(self._root),
            asyncio.current_task(),
            "spaces",
            held.process_owner,
            canonical,
        )
        token = _HELD_ORDER.set(entered)
        sequence = self._acquisition_release_sequence(acquired)
        lease = Lease(
            purpose=purpose,
            mode=mode,
            fence=max(fences.values(), default=0),
            space_ids=canonical,
            fences=MappingProxyType(fences),
            process_owner=held.process_owner,
            _parent_lease=held.lease,
            _fence_paths=MappingProxyType(fence_paths),
            _release_stages=sequence.stages,
            _entered_order=entered,
            _retain_pending=self.register_pending_lease_cleanup,
            _complete_pending=self.complete_pending_lease_cleanup,
            _order_token=token,
        )
        entered.lease = lease
        return lease

    async def _space_gate(self, space_id: str) -> _FairRwLock:
        async with self._space_gates_guard:
            return self._space_gates.setdefault(space_id, _FairRwLock())

    def _space_turnstile_path(self, space_id: str) -> Path:
        digest = hashlib.sha256(space_id.encode("utf-8")).hexdigest()
        return self._lock_dir / "spaces" / f"{digest}.turnstile"

    def _space_data_path(self, space_id: str) -> Path:
        digest = hashlib.sha256(space_id.encode("utf-8")).hexdigest()
        return self._lock_dir / "spaces" / f"{digest}.data"

    def _space_fence_path(self, space_id: str) -> Path:
        digest = hashlib.sha256(space_id.encode("utf-8")).hexdigest()
        return self._fence_dir / "spaces" / f"{digest}.fence"

    @staticmethod
    def _read_fence(path: Path) -> int:
        return int(path.read_text(encoding="ascii")) if path.exists() else 0

    def _acquisition_release_sequence(
        self, acquired: list[_AcquiredRw]
    ) -> _ReleaseSequence:
        owner_task = asyncio.current_task()
        assert owner_task is not None
        stages: list[_ReleaseStage] = []
        holds: list[object] = []
        for item in reversed(acquired):
            holds.append(item)
            for handle in reversed(item.portal_handles):
                holds.append(handle)
                stages.append(_ReleaseStage(
                    handle.release,
                    physical_terminal=lambda handle=handle: handle.released,
                    completed=handle.released,
                ))
            stages.append(_ReleaseStage(item.local_release))
        held = _HELD_ORDER.get()
        if held.process_owner is not None:
            holds.append(held.process_owner)
        if held.lease is not None:
            holds.append(held.lease)
        return _ReleaseSequence(owner_task, stages, tuple(holds))

    async def _release_acquired(
        self, acquired: list[_AcquiredRw], primary: BaseException
    ) -> None:
        sequence = self._acquisition_release_sequence(acquired)
        cleanup_errors: list[BaseException] = []
        try:
            await sequence.run()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
        except BaseException as cleanup:
            cleanup_errors.append(cleanup)
        if not sequence.completed:
            held = _HELD_ORDER.get()
            dependencies = (held.lease,) if held.lease is not None else ()
            self.register_pending_cleanup(
                sequence,
                retry=sequence.run,
                holds=sequence.holds,
                physical_terminal=lambda: sequence.completed,
                dependencies=dependencies,
            )
        if cleanup_errors:
            raise BaseExceptionGroup(
                "lease acquisition and cleanup failed",
                [primary, *cleanup_errors],
            ) from None
        raise primary
