"""Tests for app.main — create_app() and integration."""

from __future__ import annotations

import httpx
from fastapi import FastAPI
from httpx import ASGITransport

from app.errors import NotFoundError
from app.main import create_app


class TestCreateApp:
    def test_returns_fastapi_instance(self):
        """create_app() should return a FastAPI instance."""
        app = create_app()
        assert isinstance(app, FastAPI)

    async def test_health_endpoint_returns_200(self):
        """GET /api/health should return 200 with status ok."""
        app = create_app()
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"

    async def test_error_handler_registered(self):
        """AppError subclasses should produce JSON with error_type."""
        app = create_app()

        @app.get("/raise-not-found")
        async def _raise():
            raise NotFoundError("Not here")

        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/raise-not-found")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error_type"] == "not_found"
        assert body["detail"] == "Not here"

    async def test_request_id_middleware_registered(self):
        """The response should include an x-request-id header."""
        app = create_app()
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
        assert "x-request-id" in resp.headers

    async def test_security_headers_middleware_registered(self):
        """SecurityHeadersMiddleware should attach X-Content-Type-Options to /api/health."""
        app = create_app()
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"

    async def test_cors_headers_present(self):
        """CORS preflight should return appropriate headers."""
        app = create_app()
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.options(
                "/api/health",
                headers={
                    "Origin": "http://localhost:5173",
                    "Access-Control-Request-Method": "GET",
                },
            )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") is not None
