from __future__ import annotations

import asyncio
import subprocess
import sys
import textwrap
import threading
from contextvars import Context
from pathlib import Path
from types import SimpleNamespace

import portalocker
import pytest

import app.runtime.leases as leases_module
from app.runtime.leases import (
    LeaseMode,
    LeaseOrderError,
    LeaseTimeoutError,
    PendingCleanup,
    RuntimeLeaseCoordinator,
)

LOCK_HELPER = textwrap.dedent(
    """
    import asyncio
    import sys
    from pathlib import Path
    from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator

    async def main():
        root, kind, mode, space_id = sys.argv[1:5]
        coordinator = RuntimeLeaseCoordinator(Path(root))
        if kind == "owner":
            lease = await coordinator.acquire_process_owner("child", 2)
        elif kind == "global":
            lease = await coordinator.acquire_global(LeaseMode(mode), "child", 2)
        else:
            global_lease = await coordinator.acquire_global(
                LeaseMode.SHARED, "child-global", 2
            )
            lease = await coordinator.acquire_spaces(
                [space_id], LeaseMode(mode), "child-space", 2
            )
        print("LOCKED", flush=True)
        await asyncio.to_thread(sys.stdin.readline)
        await lease.release()
        if kind == "space":
            await global_lease.release()

    asyncio.run(main())
    """
)

FAIRNESS_HELPER = textwrap.dedent(
    """
    import asyncio
    import sys
    from pathlib import Path
    import app.runtime.leases as leases

    async def main():
        root, scope, role, marker_dir = sys.argv[1:5]
        marker_dir = Path(marker_dir)
        original = leases._acquire_portal_handle

        async def marked(path, mode, deadline, owned_handles):
            handle = await original(path, mode, deadline, owned_handles)
            if role == "writer" and path.name.endswith("turnstile"):
                marker_dir.joinpath(f"{role}-turnstile").touch()
            return handle

        leases._acquire_portal_handle = marked
        coordinator = leases.RuntimeLeaseCoordinator(Path(root))
        global_lease = await coordinator.acquire_global(
            leases.LeaseMode.EXCLUSIVE if scope == "global" else leases.LeaseMode.SHARED,
            role,
            5,
        )
        if scope == "space":
            lease = await coordinator.acquire_spaces(
                ["space-a"],
                leases.LeaseMode.EXCLUSIVE if role == "writer" else leases.LeaseMode.SHARED,
                role,
                5,
            )
        else:
            lease = global_lease
        marker_dir.joinpath(f"{role}-locked").touch()
        while not marker_dir.joinpath(f"{role}-release").exists():
            await asyncio.sleep(0.01)
        await lease.release()
        if scope == "space":
            await global_lease.release()

    asyncio.run(main())
    """
)

PERSISTENT_CLEANUP_HELPER = textwrap.dedent(
    """
    import asyncio
    import sys
    from pathlib import Path
    import app.runtime.leases as leases

    async def main():
        coordinator = leases.RuntimeLeaseCoordinator(Path(sys.argv[1]))
        await coordinator.acquire_global(leases.LeaseMode.SHARED, "parent", 2)
        original = leases._acquire_cross_process_rw

        async def acquire_then_fail(turnstile, data, mode, deadline, handles):
            result = await original(turnstile, data, mode, deadline, handles)
            live = next(handle for handle in handles if not handle.released)

            async def persistent():
                raise OSError("persistent cleanup")

            live.release = persistent
            raise RuntimeError("publication failed")

        leases._acquire_cross_process_rw = acquire_then_fail
        try:
            await coordinator.acquire_spaces(
                ["space-a"], leases.LeaseMode.SHARED, "fault", 2
            )
        except BaseExceptionGroup:
            pass
        else:
            raise AssertionError("acquisition failure was not injected")
        errors = await coordinator.retry_pending_cleanups_for_current_task()
        assert errors and coordinator._process_exit_required
        print("PROCESS_EXIT_REQUIRED", flush=True)
        await asyncio.to_thread(sys.stdin.readline)

    asyncio.run(main())
    """
)


def start_lock_holder(
    root: Path, kind: str, mode: str = "exclusive", space_id: str = "unused"
) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        [sys.executable, "-c", LOCK_HELPER, str(root), kind, mode, space_id],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "LOCKED"
    return process


def stop_lock_holder(process: subprocess.Popen[str]) -> None:
    if process.stdin is not None:
        process.stdin.write("release\n")
        process.stdin.flush()
    process.wait(timeout=5)
    assert process.returncode == 0


async def wait_for_marker(path: Path, timeout: float = 5) -> None:
    async with asyncio.timeout(timeout):
        while not path.exists():
            await asyncio.sleep(0.01)


@pytest.fixture
def lease_faults(monkeypatch):
    state = SimpleNamespace(stream=None, error=None, successful_unlock_count=0)
    real_lock = portalocker.lock
    real_unlock = portalocker.unlock

    def cancel_after_native_lock_before_helper_return():
        owner = asyncio.current_task()
        assert owner is not None
        loop = asyncio.get_running_loop()

        def lock_and_cancel(stream, flags) -> None:
            real_lock(stream, flags)
            state.stream = stream
            loop.call_soon_threadsafe(owner.cancel)

        monkeypatch.setattr(portalocker, "lock", lock_and_cancel)
        return state

    def fail_unlock_once(error: BaseException):
        state.error = error
        calls = 0

        def unlock(stream) -> None:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise error
            real_unlock(stream)
            state.successful_unlock_count += 1

        monkeypatch.setattr(portalocker, "unlock", unlock)
        return state

    state.cancel_after_native_lock_before_helper_return = (
        cancel_after_native_lock_before_helper_return
    )
    state.fail_unlock_once = fail_unlock_once
    return state


@pytest.mark.asyncio
async def test_global_exclusive_times_out_while_other_process_holds_shared(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    child = start_lock_holder(tmp_path, "global", "shared")
    try:
        with pytest.raises(LeaseTimeoutError) as captured:
            await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "snapshot", 0.05)
        assert captured.value.code == "lease_timeout"
    finally:
        stop_lock_holder(child)
    async with await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "snapshot", 1):
        return


@pytest.mark.asyncio
async def test_space_exclusive_blocks_same_space_cross_process_but_not_other_space(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    child = start_lock_holder(tmp_path, "space", "shared", "space-a")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "request", 1)
    try:
        with pytest.raises(LeaseTimeoutError):
            await coordinator.acquire_spaces(
                ["space-a"], LeaseMode.EXCLUSIVE, "mutation", 0.05
            )
        other = await coordinator.acquire_spaces(
            ["space-b"], LeaseMode.EXCLUSIVE, "mutation", 1
        )
        await other.release()
    finally:
        await global_lease.release()
        stop_lock_holder(child)


@pytest.mark.asyncio
async def test_local_writer_queue_blocks_late_reader(tmp_path: Path) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    first = await coordinator.acquire_global(LeaseMode.SHARED, "reader-1", 1)
    writer_acquired = asyncio.Event()
    release_writer = asyncio.Event()
    late_reader_acquired = asyncio.Event()

    async def hold_writer() -> None:
        lease = await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "writer", 1)
        writer_acquired.set()
        await release_writer.wait()
        await lease.release()

    async def hold_late_reader() -> None:
        lease = await coordinator.acquire_global(LeaseMode.SHARED, "reader-2", 1)
        late_reader_acquired.set()
        await lease.release()

    writer = asyncio.create_task(hold_writer(), context=Context())
    await asyncio.sleep(0)
    late_reader = asyncio.create_task(hold_late_reader(), context=Context())
    await asyncio.sleep(0)
    assert not writer.done()
    assert not late_reader.done()
    await first.release()
    await writer_acquired.wait()
    assert not late_reader_acquired.is_set()
    release_writer.set()
    await writer
    await late_reader
    assert late_reader_acquired.is_set()


@pytest.mark.asyncio
async def test_process_owner_death_releases_os_lock(tmp_path: Path) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    child = start_lock_holder(tmp_path, "owner")
    child.terminate()
    child.wait(timeout=5)

    owner = await coordinator.acquire_process_owner("restart", 1)
    await owner.release()


@pytest.mark.asyncio
async def test_lease_order_and_task_owner_are_fail_closed(tmp_path: Path) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    with pytest.raises(LeaseOrderError):
        await coordinator.acquire_spaces(
            ["space-a"], LeaseMode.SHARED, "unordered", 1
        )

    global_lease = await coordinator.acquire_global(
        LeaseMode.SHARED, "request", 1
    )

    async def inherited_child() -> None:
        with pytest.raises(LeaseOrderError):
            await coordinator.acquire_spaces(
                ["space-a"], LeaseMode.SHARED, "inherited", 1
            )
        with pytest.raises(LeaseOrderError):
            await global_lease.release()

    await asyncio.create_task(inherited_child())
    await global_lease.release()


@pytest.mark.asyncio
async def test_exclusive_fences_are_monotonic_and_shared_does_not_advance(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    first = await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "first", 1)
    first_fence = first.fence
    first.assert_fence("global")
    await first.release()

    shared = await coordinator.acquire_global(LeaseMode.SHARED, "read", 1)
    assert shared.fence == first_fence
    await shared.release()

    second = await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "second", 1)
    assert second.fence == first_fence + 1
    await second.release()


def test_timeout_policy_constants() -> None:
    assert RuntimeLeaseCoordinator.REQUEST_TIMEOUT_SECONDS == 5.0
    assert RuntimeLeaseCoordinator.MAINTENANCE_TIMEOUT_SECONDS == 60.0


@pytest.mark.asyncio
async def test_pending_cleanup_is_same_task_strong_and_terminal_committed() -> None:
    held = object()
    terminal = {"value": False}
    calls = 0

    async def retry() -> None:
        nonlocal calls
        calls += 1
        terminal["value"] = True

    pending = PendingCleanup(
        owner_task=asyncio.current_task(),
        retry=retry,
        holds=(held,),
        physical_terminal=lambda: terminal["value"],
    )

    async def wrong_task() -> None:
        with pytest.raises(LeaseOrderError):
            await pending.run()

    await asyncio.create_task(wrong_task())
    assert pending.holds == (held,)
    assert not pending.completed
    await pending.run()
    assert pending.completed
    assert calls == 1


@pytest.mark.asyncio
async def test_release_fail_once_retries_only_unfinished_stages_and_defers_context_reset(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    lease = await coordinator.acquire_global(LeaseMode.SHARED, "release", 1)
    first_stage, second_stage = [
        stage for stage in lease._release_stages if not stage.completed
    ]
    first_callback = first_stage.callback
    second_callback = second_stage.callback
    calls = {"first": 0, "second": 0}

    async def fail_first_once() -> None:
        calls["first"] += 1
        if calls["first"] == 1:
            raise OSError("release failed")
        await first_callback()

    async def count_second() -> None:
        calls["second"] += 1
        await second_callback()

    first_stage.callback = fail_first_once
    second_stage.callback = count_second
    with pytest.raises(BaseExceptionGroup):
        await lease.release()
    assert not lease._released
    with pytest.raises(LeaseOrderError):
        lease.assert_active_owner()
    await lease.release()
    assert lease._released
    assert calls == {"first": 2, "second": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "primary",
    [OSError("body failed"), asyncio.CancelledError("body cancelled")],
)
async def test_lease_aexit_preserves_body_or_cancellation_before_release_failures(
    tmp_path: Path, primary: BaseException
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    lease = await coordinator.acquire_global(LeaseMode.SHARED, "body", 1)
    stage = lease._release_stages[0]
    original = stage.callback
    calls = 0

    async def fail_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("cleanup failed")
        await original()

    stage.callback = fail_once
    with pytest.raises(BaseExceptionGroup) as raised:
        async with lease:
            raise primary
    assert raised.value.exceptions[0] is primary
    assert str(raised.value.exceptions[1]) == "cleanup failed"
    await lease.release()


class _ReleaseProbe:
    def __init__(self) -> None:
        self.closed = False
        self.close_calls = 0
        self.close_error: BaseException | None = None

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def test_portal_release_preserves_unlock_failure_without_closing(monkeypatch) -> None:
    stream = _ReleaseProbe()
    unlock_error = OSError("unlock failed")

    def fail_unlock(_stream) -> None:
        raise unlock_error

    monkeypatch.setattr(portalocker, "unlock", fail_unlock)
    with pytest.raises(OSError) as captured:
        leases_module._unlock_and_close(stream)

    assert captured.value is unlock_error
    assert stream.close_calls == 0
    assert not stream.closed


@pytest.mark.asyncio
async def test_portal_unlock_failure_is_retryable_and_never_commits_release(
    monkeypatch,
) -> None:
    stream = _ReleaseProbe()
    unlock_error = OSError("unlock failed")
    unlock_calls = 0

    def fail_once(_stream) -> None:
        nonlocal unlock_calls
        unlock_calls += 1
        if unlock_calls == 1:
            raise unlock_error

    monkeypatch.setattr(portalocker, "unlock", fail_once)
    handle = leases_module._PortalHandle(stream)

    with pytest.raises(OSError, match="unlock failed"):
        await handle.release()
    assert not handle.released
    await handle.release()
    assert handle.released
    assert unlock_calls == 2


@pytest.mark.asyncio
async def test_release_continues_after_physically_terminal_cancellation(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    lease = await coordinator.acquire_global(LeaseMode.SHARED, "release", 1)
    first, second = [stage for stage in lease._release_stages if not stage.completed]
    second_callback = second.callback
    second_calls = 0

    async def terminal_then_cancel() -> None:
        first.completed = True
        raise asyncio.CancelledError("after terminal release")

    async def count_second() -> None:
        nonlocal second_calls
        second_calls += 1
        await second_callback()

    first.callback = terminal_then_cancel
    second.callback = count_second
    with pytest.raises(BaseExceptionGroup) as captured:
        await lease.release()

    assert isinstance(captured.value.exceptions[0], asyncio.CancelledError)
    assert second_calls == 1
    assert second.completed
    await lease.release()


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["global", "space"])
async def test_global_and_space_acquire_cleanup_fail_once_retries_exact_remaining_stages(
    tmp_path: Path, monkeypatch, scope: str
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    owner = await coordinator.acquire_process_owner("owner", 1)
    parent = owner
    if scope == "space":
        parent = await coordinator.acquire_global(LeaseMode.SHARED, "global", 1)

    release_calls = 0

    async def fail_once_release() -> None:
        nonlocal release_calls
        release_calls += 1
        if release_calls == 1:
            raise OSError("cleanup failed")

    async def fail_acquire(
        _turnstile_path, _data_path, _mode, _deadline, owned_handles
    ) -> None:
        owned_handles.append(
            leases_module._PortalHandle(_ReleaseProbe())
        )
        owned_handles[-1].release = fail_once_release
        raise RuntimeError("acquire failed")

    monkeypatch.setattr(leases_module, "_acquire_cross_process_rw", fail_acquire)
    acquire = (
        coordinator.acquire_global(LeaseMode.SHARED, "child", 1)
        if scope == "global"
        else coordinator.acquire_spaces(
            ["space-a"], LeaseMode.SHARED, "child", 1
        )
    )
    with pytest.raises(BaseExceptionGroup):
        await acquire

    assert parent._cleanup_dependencies
    with pytest.raises(LeaseOrderError, match="unfinished resource cleanup"):
        await parent.release()
    assert await coordinator.retry_pending_cleanups_for_current_task() == ()
    assert not parent._cleanup_dependencies

    await parent.release()
    if scope == "space":
        await owner.release()


@pytest.mark.asyncio
async def test_stale_diagnostic_does_not_override_process_owner_os_lock(
    tmp_path: Path,
) -> None:
    diagnostic = tmp_path / ".runtime" / "process-owner.json"
    diagnostic.parent.mkdir(parents=True)
    diagnostic.write_text('{"pid": 1, "owner": "stale"}', encoding="utf-8")

    owner = await RuntimeLeaseCoordinator(tmp_path).acquire_process_owner("live", 1)
    await owner.release()
    assert diagnostic.read_text(encoding="utf-8").startswith("{")


@pytest.mark.asyncio
async def test_cross_root_and_coordinator_ordering_is_fail_closed(
    tmp_path: Path,
) -> None:
    first = RuntimeLeaseCoordinator(tmp_path / "a")
    second = RuntimeLeaseCoordinator(tmp_path / "b")
    owner = await first.acquire_process_owner("owner", 1)
    with pytest.raises(LeaseOrderError):
        await second.acquire_global(LeaseMode.SHARED, "wrong-root", 1)
    global_lease = await first.acquire_global(LeaseMode.SHARED, "global", 1)
    with pytest.raises(LeaseOrderError):
        await second.acquire_spaces(["space-a"], LeaseMode.SHARED, "wrong", 1)
    await global_lease.release()
    await owner.release()


@pytest.mark.asyncio
async def test_space_ids_are_canonical_and_space_fences_are_monotonic(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "global", 1)
    first = await coordinator.acquire_spaces(
        ["space-b", "space-a", "space-a"], LeaseMode.EXCLUSIVE, "first", 1
    )
    assert first.space_ids == ("space-a", "space-b")
    first_fences = dict(first.fences)
    await first.release()

    shared = await coordinator.acquire_spaces(
        ["space-a", "space-b"], LeaseMode.SHARED, "read", 1
    )
    assert dict(shared.fences) == first_fences
    await shared.release()

    second = await coordinator.acquire_spaces(
        ["space-b", "space-a"], LeaseMode.EXCLUSIVE, "second", 1
    )
    assert all(second.fences[key] == value + 1 for key, value in first_fences.items())
    await second.release()
    await global_lease.release()


@pytest.mark.asyncio
async def test_released_lease_rejects_use_fence_and_reentry(tmp_path: Path) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    lease = await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "released", 1)
    await lease.release()

    with pytest.raises(LeaseOrderError):
        await lease.__aenter__()
    with pytest.raises(LeaseOrderError):
        lease.fence_receipt("global")
    with pytest.raises(LeaseOrderError):
        lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stage",
    [
        "after_os_acquire",
        "during_fence_write",
        "corrupt_fence_receipt",
        "after_receipt",
        "after_context_token",
        "before_lease_return",
    ],
)
async def test_process_owner_every_post_acquire_failure_compensates_before_publication(
    tmp_path: Path, stage: str
) -> None:
    def failpoint(name: str) -> None:
        if name == stage:
            raise RuntimeError(stage)

    coordinator = RuntimeLeaseCoordinator(tmp_path, failpoint=failpoint)
    with pytest.raises(RuntimeError, match=stage):
        await coordinator.acquire_process_owner("fault", 1)
    assert coordinator.pending_cleanups_for_current_task() == ()
    coordinator.assert_ready()

    fresh = RuntimeLeaseCoordinator(tmp_path)
    owner = await fresh.acquire_process_owner("fresh", 1)
    await owner.release()


@pytest.mark.asyncio
async def test_cancel_during_portal_acquire_joins_and_compensates(
    tmp_path: Path, monkeypatch
) -> None:
    entered = threading.Event()
    resume = threading.Event()
    real_lock = portalocker.lock

    def delayed_lock(stream, flags) -> None:
        entered.set()
        assert resume.wait(5)
        real_lock(stream, flags)

    monkeypatch.setattr(portalocker, "lock", delayed_lock)
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    task = asyncio.create_task(
        coordinator.acquire_global(LeaseMode.EXCLUSIVE, "cancel", 1),
        context=Context(),
    )
    assert await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    resume.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    monkeypatch.setattr(portalocker, "lock", real_lock)
    lease = await RuntimeLeaseCoordinator(tmp_path).acquire_global(
        LeaseMode.EXCLUSIVE, "fresh", 1
    )
    await lease.release()


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["global", "space"])
async def test_cross_process_writer_turnstile_blocks_late_reader(
    tmp_path: Path, scope: str
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "first", 1)
    first = global_lease
    if scope == "space":
        first = await coordinator.acquire_spaces(
            ["space-a"], LeaseMode.SHARED, "first", 1
        )
    markers = tmp_path / "markers"
    markers.mkdir()

    def start(role: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [
                sys.executable,
                "-c",
                FAIRNESS_HELPER,
                str(tmp_path),
                scope,
                role,
                str(markers),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    writer = start("writer")
    reader = None
    try:
        await wait_for_marker(markers / "writer-turnstile")
        reader = start("reader")
        await asyncio.sleep(0.2)
        assert not (markers / "reader-locked").exists()

        await first.release()
        if scope == "space":
            await global_lease.release()
        await wait_for_marker(markers / "writer-locked")
        assert not (markers / "reader-locked").exists()

        (markers / "writer-release").touch()
        await wait_for_marker(markers / "reader-locked")
        (markers / "reader-release").touch()
        writer.wait(timeout=5)
        reader.wait(timeout=5)
        assert writer.returncode == 0, writer.stderr.read() if writer.stderr else ""
        assert reader.returncode == 0, reader.stderr.read() if reader.stderr else ""
    finally:
        for process in (writer, reader):
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


@pytest.mark.asyncio
async def test_portal_cleanup_failure_before_helper_return_is_registered(
    tmp_path: Path, lease_faults
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    fault = lease_faults.cancel_after_native_lock_before_helper_return()
    unlock = lease_faults.fail_unlock_once(OSError("unlock failed"))

    with pytest.raises(BaseExceptionGroup) as captured:
        await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "portal-race", 1)

    assert isinstance(captured.value.exceptions[0], asyncio.CancelledError)
    assert unlock.error in captured.value.exceptions[1:]
    pending = coordinator.pending_cleanups_for_current_task()
    assert len(pending) == 1
    assert pending[0].owner_task is asyncio.current_task()
    assert fault.stream in pending[0].holds or any(
        getattr(held, "stream", None) is fault.stream for held in pending[0].holds
    )
    with pytest.raises(leases_module.RuntimeCleanupPendingError):
        coordinator.assert_ready()

    assert await coordinator.retry_pending_cleanups_for_current_task() == ()
    assert coordinator.pending_cleanups_for_current_task() == ()
    assert unlock.successful_unlock_count == 1


@pytest.mark.asyncio
async def test_complete_pending_cleanup_releases_parent_dependency(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    parent = await coordinator.acquire_global(LeaseMode.SHARED, "parent", 1)
    owner = object()
    terminal = {"value": False}

    async def retry() -> None:
        terminal["value"] = True

    coordinator.register_pending_cleanup(
        owner,
        retry=retry,
        holds=(),
        physical_terminal=lambda: terminal["value"],
        dependencies=(parent,),
    )
    terminal["value"] = True
    coordinator.complete_pending_cleanup(owner)

    assert not parent._cleanup_dependencies
    await parent.release()


@pytest.mark.asyncio
async def test_process_owner_compensation_accepts_physical_terminal_cancellation(
    tmp_path: Path, monkeypatch
) -> None:
    real_joined = leases_module.run_joined_thread

    async def cancel_after_release(call, *, on_success=None, **kwargs):
        if getattr(call, "__name__", "") == "release":
            result = call()
            if on_success is not None:
                on_success(result)
            raise asyncio.CancelledError("after physical release")
        return await real_joined(call, on_success=on_success, **kwargs)

    def fail_before_return(name: str) -> None:
        if name == "before_lease_return":
            raise RuntimeError("publication failed")

    coordinator = RuntimeLeaseCoordinator(tmp_path, failpoint=fail_before_return)
    monkeypatch.setattr(leases_module, "run_joined_thread", cancel_after_release)
    with pytest.raises(BaseExceptionGroup) as captured:
        await coordinator.acquire_process_owner("fault", 1)
    assert isinstance(captured.value.exceptions[0], RuntimeError)
    assert isinstance(captured.value.exceptions[1], asyncio.CancelledError)
    coordinator.assert_ready()

    monkeypatch.setattr(leases_module, "run_joined_thread", real_joined)
    fresh = await RuntimeLeaseCoordinator(tmp_path).acquire_process_owner("fresh", 1)
    await fresh.release()


@pytest.mark.asyncio
async def test_persistent_cleanup_blocks_readiness_and_requires_process_exit_marker(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    held = object()

    async def persistent() -> None:
        raise OSError("persistent cleanup")

    coordinator.register_pending_cleanup(
        held,
        retry=persistent,
        holds=(held,),
        physical_terminal=lambda: False,
    )
    assert len(await coordinator.retry_pending_cleanups_for_current_task()) == 1
    with pytest.raises(leases_module.RuntimeCleanupPendingError):
        coordinator.assert_ready()

    assert coordinator._process_exit_required
    with pytest.raises(leases_module.RuntimeCleanupPendingError):
        coordinator.assert_ready()


@pytest.mark.asyncio
async def test_acquire_cleanup_double_cancel_keeps_primary_and_continues_physically_completed_stage(
    tmp_path: Path,
) -> None:
    owner_task = asyncio.current_task()
    assert owner_task is not None
    physical = {"terminal": False}
    local_calls = 0

    async def terminal_with_double_cancel() -> None:
        physical["terminal"] = True
        loop = asyncio.get_running_loop()
        loop.call_soon(owner_task.cancel)
        await asyncio.sleep(0.02)
        loop.call_soon(owner_task.cancel)
        await asyncio.sleep(0.02)

    async def release_local() -> None:
        nonlocal local_calls
        local_calls += 1

    acquired = leases_module._AcquiredRw(release_local)
    handle = leases_module._PortalHandle(_ReleaseProbe())
    handle.release = terminal_with_double_cancel
    acquired.portal_handles.append(handle)
    sequence = leases_module._ReleaseSequence(
        owner_task,
        [
            leases_module._ReleaseStage(
                handle.release, physical_terminal=lambda: physical["terminal"]
            ),
            leases_module._ReleaseStage(release_local),
        ],
        (handle, acquired),
    )

    with pytest.raises(BaseExceptionGroup) as captured:
        await sequence.run()
    assert all(
        isinstance(error, asyncio.CancelledError)
        for error in captured.value.exceptions
    )
    assert local_calls == 1
    assert sequence.completed


@pytest.mark.asyncio
async def test_acquire_cleanup_persistent_failure_blocks_readiness_and_parent_release_until_process_exit(
    tmp_path: Path,
) -> None:
    child = subprocess.Popen(
        [sys.executable, "-c", PERSISTENT_CLEANUP_HELPER, str(tmp_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert child.stdout is not None
    assert child.stdout.readline().strip() == "PROCESS_EXIT_REQUIRED"
    fresh = RuntimeLeaseCoordinator(tmp_path)
    try:
        with pytest.raises(LeaseTimeoutError):
            await fresh.acquire_global(LeaseMode.EXCLUSIVE, "blocked", 0.05)
        global_lease = await fresh.acquire_global(LeaseMode.SHARED, "probe", 1)
        try:
            with pytest.raises(LeaseTimeoutError):
                await fresh.acquire_spaces(
                    ["space-a"], LeaseMode.EXCLUSIVE, "blocked-space", 0.05
                )
        finally:
            await global_lease.release()
    finally:
        child.terminate()
        child.wait(timeout=5)

    lease = await fresh.acquire_global(LeaseMode.EXCLUSIVE, "after-exit", 1)
    await lease.release()


@pytest.mark.asyncio
async def test_child_release_failure_retains_live_process_owner_until_same_task_retry(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    owner = await coordinator.acquire_process_owner("owner", 1)
    child = await coordinator.acquire_global(LeaseMode.SHARED, "child", 1)
    stage = next(stage for stage in child._release_stages if not stage.completed)
    callback = stage.callback
    calls = 0

    async def fail_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("child release failed")
        await callback()

    stage.callback = fail_once
    with pytest.raises(BaseExceptionGroup):
        await child.release()
    assert owner.process_owner is not None and owner.process_owner.active
    with pytest.raises(LeaseOrderError):
        await owner.release()

    await child.release()
    await owner.release()
    assert calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["stage", "portal", "process-owner"])
async def test_release_terminal_hooks_commit_before_double_cancellation_rethrow(
    tmp_path: Path, monkeypatch, kind: str
) -> None:
    owner_task = asyncio.current_task()
    assert owner_task is not None

    async def cancel_owner_twice() -> None:
        loop = asyncio.get_running_loop()
        loop.call_soon(owner_task.cancel)
        await asyncio.sleep(0.02)
        loop.call_soon(owner_task.cancel)
        await asyncio.sleep(0.02)

    if kind == "stage":
        stage = leases_module._ReleaseStage(cancel_owner_twice)
        with pytest.raises(BaseExceptionGroup) as captured:
            await stage.run()
        assert stage.completed
    else:
        coordinator = RuntimeLeaseCoordinator(tmp_path)
        lease = (
            await coordinator.acquire_process_owner("owner", 1)
            if kind == "process-owner"
            else await coordinator.acquire_global(LeaseMode.SHARED, "portal", 1)
        )
        stage = next(stage for stage in lease._release_stages if not stage.completed)
        original = stage.callback

        async def terminal_then_cancel() -> None:
            await original()
            await cancel_owner_twice()

        stage.callback = terminal_then_cancel
        with pytest.raises(BaseExceptionGroup) as captured:
            await lease.release()
        assert stage.completed
        await lease.release()
    assert isinstance(captured.value.exceptions[0], asyncio.CancelledError)
    assert isinstance(captured.value.exceptions[1], asyncio.CancelledError)


@pytest.mark.asyncio
async def test_pending_cleanup_registry_is_same_task_strong_and_reverse_dependency_ordered(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    calls: list[str] = []
    terminals = {"parent": False, "child": False}

    def register(name: str) -> None:
        async def retry() -> None:
            calls.append(name)
            terminals[name] = True

        coordinator.register_pending_cleanup(
            name,
            retry=retry,
            holds=(name,),
            physical_terminal=lambda name=name: terminals[name],
        )

    register("parent")
    register("child")
    assert await coordinator.retry_pending_cleanups_for_current_task() == ()
    assert calls == ["child", "parent"]


@pytest.mark.asyncio
async def test_cancel_during_process_owner_or_portal_acquire_joins_and_compensates(
    tmp_path: Path, monkeypatch
) -> None:
    entered = threading.Event()
    resume = threading.Event()
    real_acquire = leases_module.FileLock.acquire

    def delayed_acquire(lock, *args, **kwargs):
        entered.set()
        assert resume.wait(5)
        return real_acquire(lock, *args, **kwargs)

    monkeypatch.setattr(leases_module.FileLock, "acquire", delayed_acquire)
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    task = asyncio.create_task(
        coordinator.acquire_process_owner("cancel", 1), context=Context()
    )
    assert await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    resume.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    monkeypatch.setattr(leases_module.FileLock, "acquire", real_acquire)
    fresh = await RuntimeLeaseCoordinator(tmp_path).acquire_process_owner("fresh", 1)
    await fresh.release()
