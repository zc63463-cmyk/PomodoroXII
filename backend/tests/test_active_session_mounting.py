"""Production mounting + OpenAPI structure tests for the ActiveSession
contract router.

Uses the *real* ``create_app()`` (not a hand-mounted router) so the OpenAPI
surface is the production one.  Auth-boundary probes (master/space/anonymous)
live in ``test_active_session_http_integration.py`` where the real provider is
exercised with no dependency overrides.
"""

from __future__ import annotations

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


def test_openapi_mounts_all_active_session_routes() -> None:
    app = create_app()
    paths = app.openapi()["paths"]
    for path in EXPECTED_ACTIVE_SESSION_PATHS:
        assert path in paths, f"missing production route {path}"
