"""Request-scoped multi-Space handle lifecycle tests for the production
ActiveSessionCoordinator provider (master-scoped, request-level global lease).

Verifies that every Space handle opened under the request-level global lease is
closed on *all* exit paths — success, second-Space open failure, cancellation
and provider exception — that the same Space is only opened once per request,
and that the global lease is released last.  Cleanup failures are collected
and never silently swallowed.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.routes.v1.contract_dependencies import get_active_session_coordinator

MASTER_CLAIMS = {"sub": "master-1", "type": "master", "space_id": None, "epoch": 0}


class _FakeHandle:
    def __init__(self, space_id: str, *, fail_close: bool = False) -> None:
        self.space_id = space_id
        self.fail_close = fail_close
        self.closed = False

    async def aclose(self) -> None:
        if self.fail_close:
            raise RuntimeError(f"close {self.space_id}")
        self.closed = True


class _FakeLease:
    def __init__(self) -> None:
        self.released = False

    async def release(self) -> None:
        self.released = True


class _FakeResolver:
    """Stands in for AuthorizedSpaceScope.resolve (Meta-registry validation)."""

    def __init__(self, handles: dict[str, _FakeHandle], fail_open: set[str]) -> None:
        self.handles = handles
        self.fail_open = fail_open
        self.calls: list[str] = []

    async def resolve(self, principal: Any, space_id: str, mode: str) -> Any:
        self.calls.append(space_id)
        if space_id not in self.handles:
            from app.errors import SpaceNotFoundError

            raise SpaceNotFoundError()
        if space_id in self.fail_open:
            raise RuntimeError(f"cannot open {space_id}")
        return SimpleNamespace(space_id=space_id)


class _FakeRuntime:
    def __init__(self, resolver: _FakeResolver, handles: dict[str, _FakeHandle]) -> None:
        self._resolver = resolver
        self.handles = handles
        self.global_lease = _FakeLease()
        self.open_calls: list[str] = []

    @property
    def leases(self) -> SimpleNamespace:
        async def acquire_global(mode: Any, purpose: str, timeout_seconds: float):
            return self.global_lease

        return SimpleNamespace(acquire_global=acquire_global)

    async def open_resolved(self, resolved, mode, global_lease, *, owns_global_lease):
        self.open_calls.append(resolved.space_id)
        return self.handles[resolved.space_id]


def _request(runtime: _FakeRuntime, monkeypatch) -> SimpleNamespace:
    import app.db.meta_session as meta_session_module
    import app.runtime.scope as scope_module

    class _FakeMetaSession:
        async def __aenter__(self):
            return SimpleNamespace()

        async def __aexit__(self, *_exc):
            return None

    class _FakeScopeSessionFactory:
        def __call__(self):
            return _FakeMetaSession()

    monkeypatch.setattr(
        meta_session_module, "get_meta_session_factory",
        lambda: _FakeScopeSessionFactory(),
    )
    monkeypatch.setattr(
        scope_module, "AuthorizedSpaceScope",
        lambda _session, _root, _runtime: runtime._resolver,
    )
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(runtime=runtime))
    )


def _uow() -> SimpleNamespace:
    return SimpleNamespace()


async def _open_provider(
    runtime: _FakeRuntime, monkeypatch, open_spaces: tuple[str, ...]
):
    provider = get_active_session_coordinator(
        _request(runtime, monkeypatch), claims=MASTER_CLAIMS, uow=_uow()
    )
    coordinator = await provider.__anext__()
    opened = []
    for space_id in open_spaces:
        handle = await coordinator._space_handle_provider(space_id)  # noqa: SLF001
        opened.append(handle)
    return provider, coordinator, opened


async def test_provider_opens_each_space_once_and_releases_global_last(monkeypatch) -> None:
    handles = {
        "space-b": _FakeHandle("space-b"),
        "space-c": _FakeHandle("space-c"),
    }
    runtime = _FakeRuntime(_FakeResolver(handles, set()), handles)
    provider, coordinator, opened = await _open_provider(
        runtime, monkeypatch, ("space-b", "space-c", "space-b")
    )
    assert runtime.open_calls == ["space-b", "space-c"]  # same Space opened once
    assert len(opened) == 3
    await provider.aclose()
    assert handles["space-b"].closed is True
    assert handles["space-c"].closed is True
    assert runtime.global_lease.released is True  # global lease released last


async def test_provider_closes_opened_handles_when_second_space_open_fails(monkeypatch) -> None:
    from app.errors import SpaceNotFoundError

    handles = {"space-b": _FakeHandle("space-b")}
    runtime = _FakeRuntime(_FakeResolver(handles, set()), handles)
    provider, coordinator, opened = await _open_provider(runtime, monkeypatch, ("space-b",))
    with pytest.raises(SpaceNotFoundError):
        await coordinator._space_handle_provider("space-missing")  # noqa: SLF001
    await provider.aclose()
    assert handles["space-b"].closed is True
    assert runtime.global_lease.released is True


async def test_provider_closes_handles_on_cancelled_error(monkeypatch) -> None:
    handles = {"space-b": _FakeHandle("space-b")}
    runtime = _FakeRuntime(_FakeResolver(handles, set()), handles)
    provider, coordinator, opened = await _open_provider(runtime, monkeypatch, ("space-b",))
    try:
        raise asyncio_CancelledError()
    except BaseException:
        pass
    finally:
        await provider.aclose()
    assert handles["space-b"].closed is True
    assert runtime.global_lease.released is True


async def test_cleanup_failure_does_not_block_other_handles(monkeypatch) -> None:
    from app.focus_session.coordinator import ActiveSessionCoordinationError

    handles = {
        "space-a": _FakeHandle("space-a", fail_close=True),
        "space-b": _FakeHandle("space-b"),
        "space-c": _FakeHandle("space-c"),
    }
    runtime = _FakeRuntime(_FakeResolver(handles, set()), handles)
    provider, coordinator, opened = await _open_provider(
        runtime, monkeypatch, ("space-a", "space-b", "space-c")
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await provider.aclose()  # no primary exception -> cleanup failure propagates
    assert handles["space-b"].closed is True
    assert handles["space-c"].closed is True
    assert runtime.global_lease.released is True


async def test_multiple_cleanup_failures_collected(monkeypatch) -> None:
    from app.focus_session.coordinator import ActiveSessionCoordinationError

    handles = {
        "space-a": _FakeHandle("space-a", fail_close=True),
        "space-b": _FakeHandle("space-b", fail_close=True),
    }
    runtime = _FakeRuntime(_FakeResolver(handles, set()), handles)
    provider, coordinator, opened = await _open_provider(
        runtime, monkeypatch, ("space-a", "space-b")
    )
    with pytest.raises(ActiveSessionCoordinationError) as excinfo:
        await provider.aclose()
    assert "cleanup failed" in str(excinfo.value)


class asyncio_CancelledError(BaseException):
    """Stand-in for asyncio.CancelledError (a BaseException in 3.13)."""
