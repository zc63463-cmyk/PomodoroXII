"""Tests for app.middleware — RequestIdMiddleware."""

from __future__ import annotations

import re
import uuid

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from app.logging import request_id_var
from app.middleware import RequestIdMiddleware


def _build_test_app() -> FastAPI:
    """Minimal FastAPI app with only RequestIdMiddleware."""
    app = FastAPI()

    app.add_middleware(RequestIdMiddleware)

    @app.get("/echo")
    async def _echo():
        return {"ok": True}

    return app


class TestRequestIdMiddleware:
    @pytest.fixture
    def app(self):
        return _build_test_app()

    async def test_generates_uuid_when_no_header(self, app):
        """Without an incoming x-request-id, the middleware should generate one."""
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/echo")
        assert resp.status_code == 200
        rid = resp.headers.get("x-request-id")
        assert rid is not None
        # Should be a valid UUID4 string
        parsed = uuid.UUID(rid)
        assert parsed.version == 4

    async def test_reuses_incoming_header(self, app):
        """An incoming x-request-id should be echoed back unchanged."""
        custom_id = "my-custom-request-id-123"
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/echo", headers={"x-request-id": custom_id})
        assert resp.status_code == 200
        assert resp.headers["x-request-id"] == custom_id

    async def test_binds_request_id_to_context_var(self, app):
        """During request processing, request_id_var should be set to the request id."""
        captured: list[str] = []

        @app.get("/capture")
        async def _capture():
            captured.append(request_id_var.get())
            return {"ok": True}

        custom_id = "trace-id-abc"
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/capture", headers={"x-request-id": custom_id})
        assert resp.status_code == 200
        assert len(captured) == 1
        assert captured[0] == custom_id
