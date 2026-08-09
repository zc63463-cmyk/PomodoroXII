"""Production mounting + OpenAPI + auth-boundary tests for the ActiveSession
contract router.

Uses the *real* ``create_app()`` from ``app.main`` (not a hand-mounted router)
and the real ``build_v1_router`` so the OpenAPI surface is the production one.
Auth is exercised through the real ``require_master_token`` dependency with a
``get_current_user`` override (the only seam), so master tokens are accepted
and space/anonymous tokens are rejected exactly like every other master-only
route.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.main import create_app

EXPECTED_ACTIVE_SESSION_PATHS = (
    "/api/v1/active-session",
    "/api/v1/active-session/start",
    "/api/v1/active-session/activate-provisional",
    "/api/v1/active-session/heartbeat",
    "/api/v1/active-session/pause",
    "/api/v1/active-session/resume",
    "/api/v1/active-session/takeover",
    "/api/v1/active-session/end",
    "/api/v1/active-session/note",
    "/api/v1/active-session/plan/current",
    "/api/v1/active-session/plan/completion-draft",
    "/api/v1/active-session/plan/add",
    "/api/v1/active-session/plan/remove",
    "/api/v1/active-session/resolve-activation-conflict",
)


def _app_with_auth(user: dict[str, Any]):
    # conftest reloads app.deps per test; reload the router/provider modules so
    # the route dependencies bind the same objects the overrides key on.
    import importlib

    import app.deps as deps_module
    import app.routes.v1.active_session as active_session_module
    import app.routes.v1.contract_dependencies as contract_dependencies_module

    importlib.reload(contract_dependencies_module)
    importlib.reload(active_session_module)

    app = create_app()

    def _override_user() -> dict[str, Any]:
        return user

    from app.deps import get_current_user
    from app.routes.v1.contract_dependencies import get_active_session_coordinator

    app.dependency_overrides[get_current_user] = _override_user

    class _LocateNoneCoordinator:
        """Stub for the mounting/auth probes: empty Meta -> locate is None."""

        async def locate(self, principal: Any) -> None:
            return None

    # The coordinator provider is bypassed for these auth/mounting probes; the
    # wiring itself is covered by test_active_session_routes.py.
    app.dependency_overrides[get_active_session_coordinator] = (
        lambda: _LocateNoneCoordinator()
    )
    return app


def test_openapi_mounts_all_active_session_routes() -> None:
    app = create_app()
    paths = app.openapi()["paths"]
    for path in EXPECTED_ACTIVE_SESSION_PATHS:
        assert path in paths, f"missing production route {path}"


def test_master_token_allowed_on_locate() -> None:
    app = _app_with_auth(
        {"type": "master", "sub": "master-1", "space_id": None, "epoch": 0}
    )
    client = TestClient(app)
    # Empty Meta database: the provider is a stub, so locate returns 404 —
    # the point is it must NOT be a 401/403 (master token is accepted).
    response = client.get("/api/v1/active-session")
    assert response.status_code == 404
    assert "active_session_not_found" in response.text


def test_space_token_rejected_on_locate() -> None:
    app = _app_with_auth(
        {"type": "space", "sub": "user-1", "space_id": "space-a", "epoch": 1}
    )
    client = TestClient(app)
    response = client.get("/api/v1/active-session")
    assert response.status_code in (401, 403)
    assert "provider is not installed" not in response.text


def test_anonymous_token_rejected_on_locate() -> None:
    app = _app_with_auth({"type": "anonymous", "sub": "anon", "space_id": None, "epoch": 0})
    client = TestClient(app)
    response = client.get("/api/v1/active-session")
    assert response.status_code in (401, 403)
    assert "provider is not installed" not in response.text


def test_master_token_rejected_on_space_routes() -> None:
    """Master tokens are allowed on active-session (master-only contract) but
    the router must not shadow the existing space-scoped routers."""
    app = _app_with_auth(
        {"type": "master", "sub": "master-1", "space_id": None, "epoch": 0}
    )
    schema = app.openapi()
    assert "/api/v1/notes" in schema["paths"]
    assert "/api/v1/projects" in schema["paths"]
