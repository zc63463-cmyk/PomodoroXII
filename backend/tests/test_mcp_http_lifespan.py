"""Shared bootstrap coverage for MCP HTTP and stdio transports."""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest


class _Ready:
    def __init__(self, calls: list[str], label: str) -> None:
        self.calls = calls
        self.label = label

    def assert_ready(self) -> None:
        self.calls.append(self.label)


def _services(calls: list[str]):
    runtime = _Ready(calls, "runtime-ready")
    return SimpleNamespace(
        runtime=runtime,
        executor=SimpleNamespace(gate=_Ready(calls, "executor-ready")),
        scope=object(),
        credential_verifier=object(),
        catalog=object(),
    )


@pytest.mark.asyncio
async def test_http_mode_uses_one_shared_bootstrap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    import app.runtime.bootstrap as bootstrap_module

    calls: list[str] = []
    services = _services(calls)

    @asynccontextmanager
    async def bootstrap_runtime(purpose: str):
        calls.append(f"bootstrap:{purpose}")
        try:
            yield services
        finally:
            calls.append("shutdown")

    async def run_async(**kwargs):
        calls.append(
            f"run:{kwargs['transport']}:{kwargs['host']}:{kwargs['port']}"
        )
        assert server._installed_runtime_services is services

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)
    monkeypatch.setattr(server.mcp, "run_async", run_async)

    await server.run_mcp(
        SimpleNamespace(transport="http", host="127.0.0.1", port=9999)
    )

    assert calls == [
        "bootstrap:mcp-http",
        "executor-ready",
        "runtime-ready",
        "run:http:127.0.0.1:9999",
        "shutdown",
    ]
    assert server._installed_runtime_services is None


@pytest.mark.asyncio
async def test_http_mode_clears_services_before_exception_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    import app.runtime.bootstrap as bootstrap_module

    calls: list[str] = []
    services = _services(calls)

    @asynccontextmanager
    async def bootstrap_runtime(_purpose: str):
        try:
            yield services
        finally:
            calls.append("shutdown")
            assert server._installed_runtime_services is None

    async def run_async(**_kwargs):
        calls.append("run")
        raise RuntimeError("server crashed")

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)
    monkeypatch.setattr(server.mcp, "run_async", run_async)

    with pytest.raises(RuntimeError, match="server crashed"):
        await server.run_mcp(
            SimpleNamespace(transport="http", host="127.0.0.1", port=9999)
        )

    assert calls == ["executor-ready", "runtime-ready", "run", "shutdown"]


@pytest.mark.asyncio
async def test_bootstrap_failure_never_runs_or_installs_mcp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    import app.runtime.bootstrap as bootstrap_module

    calls: list[str] = []

    @asynccontextmanager
    async def bootstrap_runtime(_purpose: str):
        raise RuntimeError("startup failed")
        yield

    async def run_async(**_kwargs):
        calls.append("run")

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)
    monkeypatch.setattr(server.mcp, "run_async", run_async)

    with pytest.raises(RuntimeError, match="startup failed"):
        await server.run_mcp(
            SimpleNamespace(transport="http", host="127.0.0.1", port=9999)
        )

    assert calls == []
    assert server._installed_runtime_services is None


@pytest.mark.asyncio
async def test_trusted_stdio_uses_same_services_and_one_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    import app.runtime.bootstrap as bootstrap_module

    calls: list[str] = []
    services = _services(calls)

    @asynccontextmanager
    async def bootstrap_runtime(purpose: str):
        calls.append(purpose)
        yield services

    async def run_async(**kwargs):
        principal = server.current_mcp_principal()
        calls.append(f"{kwargs['transport']}:{principal.token_type}")

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)
    monkeypatch.setattr(server.mcp, "run_async", run_async)

    await server.run_mcp(
        SimpleNamespace(transport="stdio", host=None, port=None)
    )

    assert calls == [
        "mcp-stdio",
        "executor-ready",
        "runtime-ready",
        "stdio:trusted_stdio",
    ]


def test_install_mcp_runtime_services_preserves_exact_identities() -> None:
    import app.mcp.server as server

    services = _services([])
    server.install_mcp_runtime_services(services)
    try:
        assert server._installed_runtime_services is services
        assert server._require_runtime_services().executor is services.executor
        assert server._require_space_runtime() is services.runtime
    finally:
        server.install_mcp_runtime_services(None)


def test_main_uses_one_asyncio_run_and_no_lifecycle_shortcuts() -> None:
    import app.mcp.server as server

    source = inspect.getsource(server.main)
    assert "asyncio.run(run_mcp(parse_args()))" in source
    assert "init_meta_db" not in source
    assert "dispose_space_engine_manager" not in source
