from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from contextvars import ContextVar
from pathlib import Path

import pytest

from app.runtime.bootstrap import OwnerExecutorState, _OwnerTaskExecutor


class _OwnerLease:
    def __init__(self) -> None:
        self.owner_task = asyncio.current_task()
        self.releases = 0

    async def release(self) -> None:
        assert asyncio.current_task() is self.owner_task
        self.releases += 1


class _Leases:
    def __init__(self) -> None:
        self.owner: _OwnerLease | None = None

    async def acquire_process_owner(self, purpose: str, timeout_seconds: float):
        self.owner = _OwnerLease()
        return self.owner


def _probe_process_owner(root: Path, timeout: float) -> subprocess.CompletedProcess[str]:
    script = """
import asyncio
import sys
from pathlib import Path
from app.runtime.leases import RuntimeLeaseCoordinator

async def probe() -> int:
    leases = RuntimeLeaseCoordinator(Path(sys.argv[1]))
    try:
        owner = await leases.acquire_process_owner("child-probe", float(sys.argv[2]))
    except Exception as error:
        print(type(error).__name__)
        return 2
    await owner.release()
    return 0

raise SystemExit(asyncio.run(probe()))
"""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    return subprocess.run(
        [sys.executable, "-c", script, str(root), str(timeout)],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.asyncio
async def test_owner_is_held_from_startup_until_shutdown() -> None:
    leases = _Leases()
    executor = _OwnerTaskExecutor(leases, "test", queue_size=2)

    await executor.start()
    assert executor.state is OwnerExecutorState.READY
    owner_task = executor.owner_task
    seen: list[asyncio.Task[object] | None] = []
    assert await executor.submit("probe", lambda: seen.append(asyncio.current_task())) is None
    assert seen == [owner_task]

    await executor.shutdown()
    assert executor.state is OwnerExecutorState.CLOSED
    assert leases.owner is not None
    assert leases.owner.releases == 1


@pytest.mark.asyncio
async def test_second_process_cannot_acquire_owner_until_shutdown(tmp_path: Path) -> None:
    from app.runtime.bootstrap import _OwnerTaskExecutor
    from app.runtime.leases import RuntimeLeaseCoordinator

    leases = RuntimeLeaseCoordinator(tmp_path)
    executor = _OwnerTaskExecutor(leases, "cross-process", queue_size=2)
    await executor.start()
    try:
        blocked = await asyncio.to_thread(_probe_process_owner, tmp_path, 0.25)
        assert blocked.returncode == 2, blocked.stdout + blocked.stderr
        assert "LeaseTimeoutError" in blocked.stdout
    finally:
        await executor.shutdown()

    released = await asyncio.to_thread(_probe_process_owner, tmp_path, 2.0)
    assert released.returncode == 0, released.stdout + released.stderr


@pytest.mark.asyncio
async def test_owner_executor_caller_cancellation_does_not_cancel_command() -> None:
    leases = _Leases()
    executor = _OwnerTaskExecutor(leases, "test")
    await executor.start()
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()

    async def command() -> str:
        started.set()
        await release.wait()
        finished.set()
        return "committed"

    task = asyncio.create_task(executor.submit("commit", command))
    await started.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(finished.wait(), 1)
    await executor.shutdown()


@pytest.mark.asyncio
async def test_owner_executor_rejects_commands_after_draining() -> None:
    leases = _Leases()
    executor = _OwnerTaskExecutor(leases, "test")
    await executor.start()
    shutdown = asyncio.create_task(executor.shutdown())
    await asyncio.sleep(0)
    with pytest.raises(RuntimeError, match="DRAINING"):
        await executor.submit("late", lambda: None)
    await shutdown


@pytest.mark.asyncio
async def test_owner_executor_starts_with_fresh_context() -> None:
    inherited = ContextVar("inherited_owner_context", default="clean")
    token = inherited.set("caller-authority")
    try:
        executor = _OwnerTaskExecutor(_Leases(), "test")
        await executor.start()
        assert await executor.submit("probe", inherited.get) == "clean"
        await executor.shutdown()
    finally:
        inherited.reset(token)


@pytest.mark.asyncio
async def test_command_surface_rejects_authority_values() -> None:
    executor = _OwnerTaskExecutor(_Leases(), "test")
    await executor.start()
    try:
        with pytest.raises(TypeError, match="authority-free"):
            await executor.submit("bad", lambda: Path("storage.db"))
        assert await executor.submit("next", lambda: "ok") == "ok"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_command_exception_does_not_stop_executor() -> None:
    executor = _OwnerTaskExecutor(_Leases(), "test")
    await executor.start()

    def fail() -> None:
        raise ValueError("command failed")

    try:
        with pytest.raises(ValueError, match="command failed"):
            await executor.submit("fail", fail)
        assert executor.state is OwnerExecutorState.READY
        assert await executor.submit("next", lambda: "ok") == "ok"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_executor_rejects_before_ready_and_after_draining() -> None:
    entered = asyncio.Event()
    release_startup = asyncio.Event()
    executor = _OwnerTaskExecutor(_Leases(), "test")

    async def startup() -> None:
        entered.set()
        await release_startup.wait()

    executor.startup = startup
    start = asyncio.create_task(executor.start())
    await entered.wait()
    with pytest.raises(RuntimeError, match="STARTING"):
        await executor.submit("early", lambda: None)
    release_startup.set()
    await start

    shutdown = asyncio.create_task(executor.shutdown())
    await asyncio.sleep(0)
    with pytest.raises(RuntimeError, match="DRAINING"):
        await executor.submit("late", lambda: None)
    await shutdown


@pytest.mark.asyncio
async def test_owner_executor_bounded_fifo_and_queue_full_cancellation() -> None:
    executor = _OwnerTaskExecutor(_Leases(), "test", queue_size=1)
    await executor.start()
    started = asyncio.Event()
    release = asyncio.Event()
    seen: list[str] = []

    async def first() -> str:
        seen.append("first")
        started.set()
        await release.wait()
        return "first"

    first_task = asyncio.create_task(executor.submit("first", first))
    await started.wait()
    second_task = asyncio.create_task(
        executor.submit("second", lambda: seen.append("second") or "second")
    )
    await asyncio.sleep(0)
    cancelled = asyncio.create_task(
        executor.submit("cancelled", lambda: seen.append("cancelled"))
    )
    await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    release.set()

    assert await first_task == "first"
    assert await second_task == "second"
    assert seen == ["first", "second"]
    await executor.shutdown()


@pytest.mark.asyncio
async def test_shutdown_admission_race_drains_accepted_command_exactly_once() -> None:
    executor = _OwnerTaskExecutor(_Leases(), "test")
    await executor.start()
    started = asyncio.Event()
    release = asyncio.Event()
    executions = 0

    async def accepted() -> None:
        nonlocal executions
        executions += 1
        started.set()
        await release.wait()

    command = asyncio.create_task(executor.submit("accepted", accepted))
    await started.wait()
    shutdown = asyncio.create_task(executor.shutdown())
    await asyncio.sleep(0)
    with pytest.raises(RuntimeError, match="DRAINING"):
        await executor.submit("loser", lambda: None)
    release.set()
    await command
    await shutdown
    assert executions == 1


@pytest.mark.asyncio
async def test_command_completion_race_settles_result_once() -> None:
    executor = _OwnerTaskExecutor(_Leases(), "test")
    await executor.start()
    started = asyncio.Event()
    release = asyncio.Event()
    executions = 0

    async def command() -> str:
        nonlocal executions
        executions += 1
        started.set()
        await release.wait()
        return "terminal"

    caller = asyncio.create_task(executor.submit("race", command))
    await started.wait()
    release.set()
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert executions == 1
    assert executor.state is OwnerExecutorState.READY
    await executor.shutdown()


@pytest.mark.asyncio
async def test_owner_acquire_and_release_each_once() -> None:
    leases = _Leases()
    executor = _OwnerTaskExecutor(leases, "test")
    await executor.start()
    await executor.shutdown()
    await executor.shutdown()
    assert leases.owner is not None
    assert leases.owner.releases == 1


@pytest.mark.asyncio
async def test_startup_failure_collects_all_cleanup() -> None:
    leases = _Leases()
    executor = _OwnerTaskExecutor(leases, "test")

    async def fail_startup() -> None:
        raise RuntimeError("startup")

    async def fail_cleanup() -> None:
        raise BaseExceptionGroup(
            "cleanup",
            [OSError("runtime"), RuntimeError("meta")],
        )

    executor.startup = fail_startup
    executor.cleanup = fail_cleanup
    with pytest.raises(RuntimeError, match="startup"):
        await executor.start()
    assert executor.state is OwnerExecutorState.FAILED
    assert leases.owner is not None
    assert leases.owner.releases == 0


@pytest.mark.asyncio
async def test_persistent_cleanup_keeps_owner_and_fails_closed() -> None:
    leases = _Leases()
    executor = _OwnerTaskExecutor(leases, "test")

    async def fail_cleanup() -> None:
        raise OSError("persistent cleanup")

    executor.cleanup = fail_cleanup
    await executor.start()
    with pytest.raises(BaseExceptionGroup, match="cleanup"):
        await executor.shutdown()
    assert executor.state is OwnerExecutorState.FAILED
    assert leases.owner is not None
    assert leases.owner.releases == 0
    with pytest.raises(BaseExceptionGroup, match="cleanup"):
        await executor.shutdown()
