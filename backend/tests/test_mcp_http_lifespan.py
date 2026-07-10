"""Tests for MCP server HTTP transport lifecycle.

These tests verify that when running `python -m app.mcp.server --transport http`,
the meta database and space engine manager are properly initialized and disposed
across the server's lifetime, matching the stdio transport behavior.
"""


import pytest


def test_http_mode_initializes_meta_db(monkeypatch):
    """main() with --transport http must call init_meta_db() before mcp.run()."""
    # Track lifecycle calls without actually starting the server.
    calls: list[str] = []

    async def fake_init_meta_db():
        calls.append("init_meta_db")

    async def fake_dispose():
        calls.append("dispose_space_engine_manager")

    async def fake_close():
        calls.append("close_meta_db")

    def fake_run(*args, **kwargs):
        calls.append("mcp.run")

    monkeypatch.setattr("app.mcp.server.init_meta_db", fake_init_meta_db)
    monkeypatch.setattr(
        "app.mcp.server.dispose_space_engine_manager", fake_dispose
    )
    monkeypatch.setattr("app.mcp.server.close_meta_db", fake_close)
    monkeypatch.setattr("app.mcp.server.mcp.run", fake_run)

    # Force CLI args to http mode.
    monkeypatch.setattr("sys.argv", ["mcp", "--transport", "http", "--port", "9999"])

    from app.mcp.server import main

    main()

    # init must happen BEFORE run, and cleanup must happen AFTER.
    assert calls == [
        "init_meta_db",
        "mcp.run",
        "dispose_space_engine_manager",
        "close_meta_db",
    ]


def test_http_mode_cleans_up_on_exception(monkeypatch):
    """If mcp.run raises, cleanup must still run in finally block."""
    calls: list[str] = []

    async def fake_init_meta_db():
        calls.append("init_meta_db")

    async def fake_dispose():
        calls.append("dispose_space_engine_manager")

    async def fake_close():
        calls.append("close_meta_db")

    def fake_run(*args, **kwargs):
        calls.append("mcp.run")
        raise RuntimeError("server crashed")

    monkeypatch.setattr("app.mcp.server.init_meta_db", fake_init_meta_db)
    monkeypatch.setattr(
        "app.mcp.server.dispose_space_engine_manager", fake_dispose
    )
    monkeypatch.setattr("app.mcp.server.close_meta_db", fake_close)
    monkeypatch.setattr("app.mcp.server.mcp.run", fake_run)
    monkeypatch.setattr("sys.argv", ["mcp", "--transport", "http", "--port", "9999"])

    from app.mcp.server import main

    with pytest.raises(RuntimeError, match="server crashed"):
        main()

    # Cleanup must still occur despite the exception.
    assert "init_meta_db" in calls
    assert "dispose_space_engine_manager" in calls
    assert "close_meta_db" in calls
    # Cleanup must come after the failed run.
    assert calls.index("mcp.run") < calls.index("dispose_space_engine_manager")
    assert calls.index("dispose_space_engine_manager") < calls.index("close_meta_db")


def test_stdio_mode_lifecycle_unchanged(monkeypatch):
    """Stdio mode should still call init/dispose exactly as before."""
    calls: list[str] = []

    async def fake_init_meta_db():
        calls.append("init_meta_db")

    async def fake_dispose():
        calls.append("dispose_space_engine_manager")

    async def fake_close():
        calls.append("close_meta_db")

    def fake_run(*args, **kwargs):
        calls.append("mcp.run")

    monkeypatch.setattr("app.mcp.server.init_meta_db", fake_init_meta_db)
    monkeypatch.setattr(
        "app.mcp.server.dispose_space_engine_manager", fake_dispose
    )
    monkeypatch.setattr("app.mcp.server.close_meta_db", fake_close)
    monkeypatch.setattr("app.mcp.server.mcp.run", fake_run)
    monkeypatch.setattr("sys.argv", ["mcp", "--transport", "stdio"])

    from app.mcp.server import main

    main()

    assert calls == [
        "init_meta_db",
        "mcp.run",
        "dispose_space_engine_manager",
        "close_meta_db",
    ]


def test_http_docstring_no_longer_claims_lifespan():
    """The old comment 'HTTP mode uses lifespan' was false documentation.

    After the fix, http mode should manage its own init/cleanup via main(),
    so the misleading comment must be removed.
    """
    import inspect

    from app.mcp import server

    source = inspect.getsource(server.main)
    assert "HTTP mode uses lifespan" not in source, (
        "Stale comment about lifespan should be removed from main()"
    )
