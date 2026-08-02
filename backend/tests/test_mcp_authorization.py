from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import jwt
import pytest
from fastmcp.exceptions import ToolError

from app.auth.security import create_space_token
from app.errors import AppError, AuthenticationError


@pytest.fixture(autouse=True)
async def _meta_database():
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.space_manager import dispose_space_engine_manager

    await init_meta_db()
    try:
        yield
    finally:
        import app.mcp.server as server

        server.install_space_runtime(None)
        await dispose_space_engine_manager()
        await close_meta_db()


async def _register_space(space_id: str, tmp_path: Path) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space

    root = tmp_path / "spaces" / space_id
    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    async for session in get_meta_session():
        session.add(
            Space(
                id=space_id,
                name=space_id,
                db_path=str(root / "space.db"),
                notes_dir=str(notes),
            )
        )
        await session.commit()
        break


async def _register_space_at(space_id: str, root: Path) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space

    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    async for session in get_meta_session():
        session.add(
            Space(
                id=space_id,
                name=space_id,
                db_path=str(root / "space.db"),
                notes_dir=str(notes),
            )
        )
        await session.commit()
        break


class _FakeLease:
    fence = 1

    async def release(self) -> None:
        return None


class _FakeLeases:
    async def acquire_global(self, *_args):
        return _FakeLease()

    def register_pending_lease_cleanup(self, _lease) -> None:
        return None


class _ForbiddenRuntime:
    def __init__(self) -> None:
        self.leases = _FakeLeases()
        self.open_count = 0

    async def open_resolved(self, *_args, **_kwargs):
        self.open_count += 1
        raise AssertionError("request reached storage activation")


def _install_forbidden_runtime(server):
    runtime = _ForbiddenRuntime()
    server.install_space_runtime(
        SimpleNamespace(**runtime.__dict__, open_resolved=runtime.open_resolved)
    )
    return runtime


@pytest.mark.asyncio
async def test_http_verifier_rejects_missing_epoch(tmp_path: Path) -> None:
    from app.mcp.auth import PomodoroTokenVerifier
    from app.settings import settings

    await _register_space("spc_epochless", tmp_path)
    epochless = jwt.encode(
        {
            "sub": "admin",
            "type": "space",
            "space_id": "spc_epochless",
            "exp": 4_102_444_800,
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    assert await PomodoroTokenVerifier().verify_token(epochless) is None


@pytest.mark.asyncio
async def test_http_verifier_returns_access_token_and_observes_revocation(
    tmp_path: Path,
) -> None:
    from app.auth.authority import CredentialAuthority, bootstrap_credential_epoch
    from app.db.meta_session import get_meta_session
    from app.mcp.auth import PomodoroTokenVerifier

    await _register_space("spc_test", tmp_path)
    epoch = await bootstrap_credential_epoch()
    token = create_space_token("spc_test", "admin", epoch=epoch)
    verifier = PomodoroTokenVerifier()

    access = await verifier.verify_token(token)
    assert access is not None
    assert access.subject == "admin"
    assert access.scopes == ["space:spc_test"]
    assert access.claims["epoch"] == 1

    async for session in get_meta_session():
        await CredentialAuthority(session).revoke("admin")
        break
    assert await verifier.verify_token(token) is None


def test_stdio_requires_explicit_trust(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.mcp.server import main

    monkeypatch.setattr(sys, "argv", ["mcp", "--transport", "stdio"])
    with pytest.raises(SystemExit):
        main()


def test_http_rejects_trusted_stdio_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.mcp.server import main

    monkeypatch.setattr(
        sys,
        "argv",
        ["mcp", "--transport", "http", "--trusted-stdio"],
    )
    with pytest.raises(SystemExit):
        main()


def test_http_principal_comes_from_fastmcp_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastmcp.server.auth import AccessToken

    import app.mcp.auth as auth

    access = AccessToken(
        token="opaque",
        client_id="admin",
        subject="admin",
        scopes=["space:spc_claims"],
        expires_at=4_102_444_800,
        claims={
            "sub": "admin",
            "type": "space",
            "space_id": "spc_claims",
            "epoch": 7,
        },
    )
    monkeypatch.setattr(auth, "get_access_token", lambda: access)
    principal = auth.current_mcp_principal()
    assert principal.subject == "admin"
    assert principal.space_id == "spc_claims"
    assert principal.epoch == 7


def test_direct_calls_are_untrusted_until_test_enters_explicit_stdio_context() -> None:
    from app.mcp.auth import current_mcp_principal, trusted_stdio_context

    with pytest.raises(AuthenticationError):
        current_mcp_principal()
    with trusted_stdio_context():
        principal = current_mcp_principal()
        assert principal.subject == "trusted-stdio"
        assert principal.token_type == "trusted_stdio"


@pytest.mark.asyncio
async def test_http_without_bearer_is_rejected_before_tool_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from httpx import ASGITransport, AsyncClient

    import app.mcp.server as server

    calls = 0

    async def forbidden_list_spaces() -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        return []

    monkeypatch.setattr(server, "list_spaces", forbidden_list_spaces)
    app = server.mcp.http_app(stateless_http=True)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "list_all_spaces", "arguments": {}},
            },
            headers={"Accept": "application/json, text/event-stream"},
        )
    assert response.status_code == 401
    assert calls == 0


@pytest.mark.asyncio
async def test_space_principal_cannot_run_master_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    from app.auth.authority import Principal

    monkeypatch.setattr(
        server,
        "current_mcp_principal",
        lambda: Principal(
            subject="admin",
            token_type="space",
            epoch=1,
            expires_at=4_102_444_800,
            space_id="spc_a",
        ),
    )
    monkeypatch.setattr(
        server,
        "list_spaces",
        lambda: pytest.fail("Space principal reached master-only authority"),
    )
    with pytest.raises(ToolError) as raised:
        await server.list_all_spaces()
    payload = json.loads(str(raised.value))
    assert payload["code"] == "forbidden"
    assert payload["retryable"] is False


@pytest.mark.asyncio
async def test_space_token_cannot_authorize_another_space_before_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    from app.auth.authority import Principal

    monkeypatch.setattr(
        server,
        "current_mcp_principal",
        lambda: Principal(
            subject="admin",
            token_type="space",
            epoch=1,
            expires_at=4_102_444_800,
            space_id="spc_a",
        ),
    )
    runtime = _install_forbidden_runtime(server)
    with pytest.raises(ToolError) as raised:
        await server.get_habit_summary("spc_b")
    assert json.loads(str(raised.value)) == {
        "code": "forbidden",
        "message": "Token is not valid for this Space",
        "retryable": False,
        "request_id": "",
        "details": {},
    }
    assert runtime.open_count == 0


@pytest.mark.asyncio
async def test_unregistered_space_returns_canonical_error_before_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.mcp.server as server
    from app.auth.authority import Principal

    monkeypatch.setattr(
        server,
        "current_mcp_principal",
        lambda: Principal(
            subject="trusted-stdio",
            token_type="trusted_stdio",
            epoch=0,
            expires_at=None,
        ),
    )
    runtime = _install_forbidden_runtime(server)
    with pytest.raises(ToolError) as raised:
        await server.get_habit_summary("spc_missing")
    assert json.loads(str(raised.value)) == {
        "code": "space_not_found",
        "message": "Space is not registered",
        "retryable": False,
        "request_id": "",
        "details": {},
    }
    assert runtime.open_count == 0


@pytest.mark.asyncio
async def test_outside_root_space_returns_canonical_error_before_storage(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import app.mcp.server as server
    from app.auth.authority import Principal
    from app.settings import settings

    outside = settings.spaces_data_dir.parent / "outside-space-authority"
    await _register_space_at("spc_outside", outside)
    monkeypatch.setattr(
        server,
        "current_mcp_principal",
        lambda: Principal(
            subject="trusted-stdio",
            token_type="trusted_stdio",
            epoch=0,
            expires_at=None,
        ),
    )
    runtime = _install_forbidden_runtime(server)
    with pytest.raises(ToolError) as raised:
        await server.get_habit_summary("spc_outside")
    payload = json.loads(str(raised.value))
    assert payload["code"] == "path_outside_space"
    assert payload["retryable"] is False
    assert payload["request_id"] == ""
    assert payload["details"] == {}
    assert runtime.open_count == 0


def test_mcp_error_payload_uses_shared_recursive_serializer() -> None:
    from app.mcp.auth import mcp_error_payload

    details = {"resolution": {"kind": "local", "versions": [1, 2]}}
    error = AppError(code="version_conflict", details=details)
    details["resolution"]["versions"].append(3)
    assert mcp_error_payload(error, "req-parity") == {
        "code": "version_conflict",
        "message": "Entity version conflict",
        "retryable": False,
        "request_id": "req-parity",
        "details": {"resolution": {"kind": "local", "versions": [1, 2]}},
    }


@pytest.mark.asyncio
async def test_rest_and_mcp_share_nested_frozen_error_wire_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    import app.mcp.auth as auth
    from app.errors import CANONICAL_ERROR_MEDIA_TYPE, register_exception_handlers
    from app.mcp.auth import canonical_mcp_errors

    details = {"resolution": {"kind": "local", "versions": [1, 2]}}
    error = AppError(code="version_conflict", details=details)
    details["resolution"]["versions"].append(3)

    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/nested")
    async def nested() -> None:
        raise error

    @canonical_mcp_errors
    async def raise_same_error() -> None:
        raise error

    monkeypatch.setattr(
        auth,
        "get_http_headers",
        lambda **_kwargs: {"x-request-id": "req-parity"},
    )
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        rest = await client.get(
            "/nested",
            headers={
                "Accept": CANONICAL_ERROR_MEDIA_TYPE,
                "X-Request-ID": "req-parity",
            },
        )
    with pytest.raises(ToolError) as raised:
        await raise_same_error()

    mcp = json.loads(str(raised.value))
    assert rest.status_code == 409
    assert mcp == rest.json()
    assert mcp == {
        "code": "version_conflict",
        "message": "Entity version conflict",
        "retryable": False,
        "request_id": "req-parity",
        "details": {"resolution": {"kind": "local", "versions": [1, 2]}},
    }


def test_mcp_and_sync_do_not_define_a_second_recursive_wire_serializer() -> None:
    backend = Path(__file__).resolve().parents[1]
    sources = "\n".join(
        path.read_text(encoding="utf-8")
        for package in (backend / "app" / "mcp", backend / "app" / "sync")
        if package.exists()
        for path in package.rglob("*.py")
    )
    assert "def to_wire_json" not in sources
    assert "asdict(" not in sources
    assert "deepcopy(" not in sources
    assert "dict(error.details)" not in sources
    auth_source = inspect.getsource(sys.modules["app.mcp.auth"])
    assert "from app.errors import" in auth_source
    assert "to_wire_json" in auth_source
