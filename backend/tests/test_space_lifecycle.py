from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path

import pytest


class _FakeLease:
    def __init__(self, scope: str, *, fence: int = 3) -> None:
        self.fence = fence
        self.mode = "exclusive"
        self.scope = scope
        self.release_count = 0

    def assert_active_owner(self, **kwargs) -> None:
        return None

    async def release(self) -> None:
        self.release_count += 1


class _FailOnceResource:
    def __init__(self) -> None:
        self.attempts = 0
        self.successes = 0

    async def close(self) -> None:
        self.attempts += 1
        if self.attempts == 1:
            raise OSError("close failed")
        self.successes += 1


class _EngineResource:
    def __init__(self) -> None:
        self.attempts = 0
        self.successes = 0

    async def release(self) -> None:
        self.attempts += 1
        self.successes += 1


@pytest.mark.asyncio
async def test_scope_acquires_global_before_registered_meta_resolve() -> None:
    from app.runtime.scope import AuthorizedSpaceScope

    calls: list[str] = []

    class Leases:
        async def acquire_global(self, *_args):
            calls.append("global")
            return _FakeLease("global")

    runtime = SimpleNamespace(
        leases=Leases(),
        open_resolved=lambda *_args, **_kwargs: None,
    )
    scope = AuthorizedSpaceScope(SimpleNamespace(), Path.cwd(), runtime)

    async def resolve(*_args):
        calls.append("resolve")
        raise RuntimeError("stop")

    scope.resolve = resolve
    with pytest.raises(RuntimeError, match="stop"):
        await scope.open(SimpleNamespace(), "space-a", "read")
    assert calls[:2] == ["global", "resolve"]


@pytest.mark.asyncio
async def test_mutation_open_defers_space_resources_until_exclusive_guard() -> None:
    from app.runtime.space import SpaceRuntime

    calls: list[str] = []
    global_lease = SimpleNamespace(fence=3)
    scope = SimpleNamespace(space_id="space-a")
    runtime = SpaceRuntime(
        leases=SimpleNamespace(),
        engines=SimpleNamespace(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )

    async def forbidden_activation(*args, **kwargs):
        calls.append("activate")

    runtime._verify_registered_open = lambda scope: None
    handle = await runtime.open_resolved(
        scope, "mutation", global_lease, owns_global_lease=False
    )
    handle.activate_space_resources_under_lease = forbidden_activation
    assert handle.engine is None
    assert handle.file_system is None
    assert calls == []


@pytest.mark.asyncio
async def test_handle_close_retries_failed_stage_without_repeating_success() -> None:
    from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

    runtime = SpaceRuntime(
        leases=SimpleNamespace(register_pending_cleanup=lambda *args, **kwargs: None),
        engines=SimpleNamespace(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )
    file_system = _FailOnceResource()
    engine = _EngineResource()
    global_lease = _FakeLease("global")
    space_lease = _FakeLease("space-a")
    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="space-a"),
        engine,
        file_system,
        global_lease,
        space_lease,
        True,
        True,
        3,
        runtime,
    )

    with pytest.raises(BaseExceptionGroup):
        await handle.aclose()
    await handle.aclose()
    await handle.aclose()

    assert (file_system.attempts, file_system.successes) == (2, 1)
    assert (engine.attempts, engine.successes) == (1, 1)
    assert space_lease.release_count == 1
    assert global_lease.release_count == 1


@pytest.mark.asyncio
async def test_borrowed_handle_closes_resources_without_releasing_leases() -> None:
    from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

    runtime = SpaceRuntime(
        leases=SimpleNamespace(),
        engines=SimpleNamespace(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )
    file_system = _FailOnceResource()
    file_system.attempts = 1
    engine = _EngineResource()
    global_lease = _FakeLease("global")
    space_lease = _FakeLease("space-a")
    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="space-a"),
        engine,
        file_system,
        global_lease,
        space_lease,
        False,
        False,
        3,
        runtime,
    )

    await handle.aclose()
    await handle.aclose()

    assert handle._closed is True
    assert space_lease.release_count == 0
    assert global_lease.release_count == 0
