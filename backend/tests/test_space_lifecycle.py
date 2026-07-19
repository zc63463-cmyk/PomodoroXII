from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest


class _FakeLease:
    def __init__(self, scope: str, *, fence: int = 3) -> None:
        self.fence = fence
        self.mode = "exclusive"
        self.scope = scope
        self.release_count = 0
        self.dependencies: set[int] = set()

    def assert_active_owner(self, **kwargs) -> None:
        return None

    async def release(self) -> None:
        self.release_count += 1

    def retain_cleanup_dependency(self, owner) -> None:
        self.dependencies.add(id(owner))

    def complete_cleanup_dependency(self, owner) -> None:
        self.dependencies.discard(id(owner))


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


@pytest.mark.asyncio
async def test_open_cancellation_releases_acquired_space_and_global_leases() -> None:
    from app.runtime.space import SpaceRuntime

    global_lease = _FakeLease("global")
    space_lease = _FakeLease("space-a")

    class Leases:
        async def acquire_spaces(self, *_args):
            return space_lease

    runtime = SpaceRuntime(
        leases=Leases(),
        engines=SimpleNamespace(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )

    async def cancelled(_scope):
        raise asyncio.CancelledError()

    runtime._verify_registered_open = cancelled
    with pytest.raises(asyncio.CancelledError):
        await runtime.open_resolved(
            SimpleNamespace(space_id="space-a"),
            "read",
            global_lease,
            owns_global_lease=True,
        )
    assert space_lease.release_count == 1
    assert global_lease.release_count == 1


@pytest.mark.asyncio
async def test_health_uses_verified_open_targets_only() -> None:
    from app.runtime.space import SpaceRuntime

    events: list[str] = []
    opens = SimpleNamespace(database_target=object(), index_target=object())

    class Containment:
        @asynccontextmanager
        async def open_verified(self):
            events.append("enter")
            try:
                yield opens
            finally:
                events.append("exit")

    class Migrations:
        async def verify_open(self, kind, target):
            assert events == ["enter"]
            assert kind == "space" and target is opens.database_target
            return SimpleNamespace(at_head=True, revision="space_head")

    class IndexSchema:
        def verify_open(self, target):
            assert events == ["enter"]
            assert target is opens.index_target
            return SimpleNamespace(valid=True, version=2)

    runtime = SpaceRuntime(
        leases=SimpleNamespace(),
        engines=SimpleNamespace(),
        migrations=Migrations(),
        index_schema=IndexSchema(),
    )
    health = await runtime.health(
        SimpleNamespace(space_id="space-a", containment=Containment()),
        catalog_hash="catalog",
    )
    assert events == ["enter", "exit"]
    assert health.available is True
    assert health.migration_head == "space_head"
    assert health.index_schema_version == 2


@pytest.mark.asyncio
async def test_activation_exit_fault_collects_filesystem_and_releases_engine(
    monkeypatch,
) -> None:
    from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

    primary = RuntimeError("identity drift")
    file_system = _FailOnceResource()
    engine = _EngineResource()

    class Containment:
        @asynccontextmanager
        async def open_verified(self):
            yield SimpleNamespace()
            raise primary

    class Engines:
        async def acquire(self, *_args):
            return engine

    async def open_file_system(_opens):
        return file_system

    monkeypatch.setattr(
        "app.file_system.api.open_existing_file_system", open_file_system
    )
    runtime = SpaceRuntime(
        leases=SimpleNamespace(register_pending_cleanup=lambda *args, **kwargs: None),
        engines=Engines(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )
    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="space-a", containment=Containment()),
        None,
        None,
        _FakeLease("global"),
        None,
        False,
        False,
        1,
        runtime,
    )

    with pytest.raises(BaseExceptionGroup) as captured:
        await handle.activate_space_resources_under_lease(_FakeLease("space-a"))
    assert captured.value.exceptions[0] is primary
    assert isinstance(captured.value.exceptions[1], OSError)
    assert engine.successes == 1
    assert handle.engine is None
    assert handle.file_system is file_system


@pytest.mark.asyncio
async def test_borrowed_body_cancellation_pins_lease_on_cleanup_failure() -> None:
    from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

    pending: list[object] = []

    class Leases:
        def register_pending_cleanup(self, owner, **_kwargs) -> None:
            if owner not in pending:
                pending.append(owner)

    runtime = SpaceRuntime(
        leases=Leases(),
        engines=SimpleNamespace(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )
    global_lease = _FakeLease("global")
    space_lease = _FakeLease("space-a")
    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="space-a"),
        _EngineResource(),
        _FailOnceResource(),
        global_lease,
        space_lease,
        False,
        False,
        1,
        runtime,
    )

    async def opened(*_args, **_kwargs):
        return handle

    runtime.open_resolved = opened
    with pytest.raises(BaseExceptionGroup) as captured:
        async with runtime.borrow_prepared_space(
            handle.scope, global_lease, space_lease
        ):
            raise asyncio.CancelledError()
    assert isinstance(captured.value.exceptions[0], asyncio.CancelledError)
    assert isinstance(captured.value.exceptions[1], OSError)
    assert id(handle) in space_lease.dependencies
    assert pending == [handle]
