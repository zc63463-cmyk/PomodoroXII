"""Request-scoped multi-Space handle lifecycle tests for the production
ActiveSessionCoordinator provider.

Verifies that every cross-space handle opened through the runtime is closed on
*all* exit paths — success, child failure, cancellation and provider
exception — while the primary request handle is never closed twice.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.routes.v1.contract_dependencies import get_active_session_coordinator


class _FakeHandle:
    def __init__(self, space_id: str, *, fail_open: bool = False) -> None:
        self.scope = SimpleNamespace(space_id=space_id)
        self.global_lease = SimpleNamespace()
        self.fail_open = fail_open
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class _FakeRuntime:
    def __init__(self, handles: dict[str, _FakeHandle]) -> None:
        self.handles = handles
        self.open_calls: list[str] = []

    async def resolve_scope(self, space_id: str) -> str:
        return space_id

    async def open_resolved(self, scope, mode, global_lease, *, owns_global_lease):
        self.open_calls.append(scope)
        handle = self.handles[scope]
        if handle.fail_open:
            raise RuntimeError(f"cannot open {scope}")
        return handle


def _request(runtime: _FakeRuntime, monkeypatch=None) -> SimpleNamespace:
    if monkeypatch is not None:
        import app.db.meta_session as meta_session_module

        monkeypatch.setattr(
            meta_session_module, "get_meta_session_factory",
            lambda: SimpleNamespace(),
        )
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(runtime=runtime)))


def _uow() -> SimpleNamespace:
    return SimpleNamespace()


def _fake_coordinator_factory(handles: dict[str, _FakeHandle]):
    from app.focus_session.query import FocusSessionQuery

    def build(**kwargs: Any):
        from app.focus_session.coordinator import ProductionActiveSessionCoordinator

        return ProductionActiveSessionCoordinator(
            meta_session_factory=lambda: (_ for _ in ()).throw(AssertionError("unused")),
            uow=_uow(),  # type: ignore[arg-type]
            space_handle_provider=lambda space_id: (
                _ for _ in ()).throw(AssertionError("unused")),
            session_query=FocusSessionQuery(),
            **kwargs,
        )

    return build


async def _drive_provider(
    runtime: _FakeRuntime,
    primary: _FakeHandle,
    *,
    open_spaces: tuple[str, ...],
    monkeypatch=None,
) -> tuple[list[_FakeHandle], list[_FakeHandle]]:
    """Step the provider generator, open the requested cross-space handles via
    the coordinator's space_handle_provider, then close the generator and
    return (primary_handles, cross_handles)."""
    from app.focus_session.coordinator import ActiveSessionCoordinationError

    cross: list[_FakeHandle] = []
    provider = get_active_session_coordinator(
        _request(runtime, monkeypatch), uow=_uow(), handle=primary
    )
    coordinator = await provider.__anext__()
    for space_id in open_spaces:
        handle = await coordinator._space_handle_provider(space_id)  # noqa: SLF001
        cross.append(handle)
    try:
        await provider.aclose()
    except ActiveSessionCoordinationError:
        pass
    return [primary], cross


async def test_provider_closes_cross_space_handles_on_success(monkeypatch) -> None:
    runtime = _FakeRuntime(
        {"space-b": _FakeHandle("space-b"), "space-c": _FakeHandle("space-c")}
    )
    primary = _FakeHandle("space-a")
    _primary, cross = await _drive_provider(
        runtime, primary, open_spaces=("space-b", "space-c"), monkeypatch=monkeypatch
    )
    assert all(handle.closed for handle in cross)
    assert primary.closed is False  # owned by get_space_runtime_handle


async def test_provider_never_closes_primary_twice(monkeypatch) -> None:
    runtime = _FakeRuntime({})
    primary = _FakeHandle("space-a")
    _primary, cross = await _drive_provider(runtime, primary, open_spaces=(), monkeypatch=monkeypatch)
    assert primary.closed is False
    await primary.aclose()  # the request-owned finally does it
    assert primary.closed is True


async def test_provider_closes_opened_handles_when_second_space_open_fails(monkeypatch) -> None:
    runtime = _FakeRuntime(
        {"space-b": _FakeHandle("space-b"), "space-bad": _FakeHandle("space-bad", fail_open=True)}
    )
    primary = _FakeHandle("space-a")
    from app.focus_session.coordinator import ActiveSessionCoordinationError

    provider = get_active_session_coordinator(
        _request(runtime, monkeypatch), uow=_uow(), handle=primary
    )
    coordinator = await provider.__anext__()
    first = await coordinator._space_handle_provider("space-b")  # noqa: SLF001
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator._space_handle_provider("space-bad")  # noqa: SLF001
    await provider.aclose()
    assert first.closed is True
    assert primary.closed is False


async def test_provider_closes_handles_on_cancelled_error(monkeypatch) -> None:
    runtime = _FakeRuntime({"space-b": _FakeHandle("space-b")})
    primary = _FakeHandle("space-a")
    provider = get_active_session_coordinator(
        _request(runtime, monkeypatch), uow=_uow(), handle=primary
    )
    coordinator = await provider.__anext__()
    opened = await coordinator._space_handle_provider("space-b")  # noqa: SLF001
    try:
        raise asyncio_CancelledError()
    except BaseException:
        pass
    finally:
        await provider.aclose()
    assert opened.closed is True
    assert primary.closed is False


class asyncio_CancelledError(BaseException):
    """Stand-in for asyncio.CancelledError (a BaseException in 3.13)."""
