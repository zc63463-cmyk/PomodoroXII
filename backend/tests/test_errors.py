"""Tests for app.errors — exception hierarchy and FastAPI exception handlers."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from app.errors import (
    AppError,
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
    register_exception_handlers,
)


# --------------------------------------------------------------------------- #
# Exception class hierarchy
# --------------------------------------------------------------------------- #
class TestAppErrorDefaults:
    def test_default_attributes(self):
        """AppError should have sensible defaults."""
        err = AppError()
        assert err.detail == "Application error"
        assert err.status_code == 500
        assert err.error_type == "app_error"

    def test_custom_attributes(self):
        """AppError should accept custom detail, status_code, error_type."""
        err = AppError("custom message", status_code=418, error_type="im_a_teapot")
        assert err.detail == "custom message"
        assert err.status_code == 418
        assert err.error_type == "im_a_teapot"

    def test_is_exception_subclass(self):
        """AppError should be a subclass of Exception."""
        assert issubclass(AppError, Exception)


class TestErrorSubclasses:
    def test_not_found_error(self):
        err = NotFoundError()
        assert err.status_code == 404
        assert err.error_type == "not_found"

    def test_conflict_error(self):
        err = ConflictError()
        assert err.status_code == 409
        assert err.error_type == "conflict"

    def test_validation_error(self):
        err = ValidationError()
        assert err.status_code == 422
        assert err.error_type == "validation_error"

    def test_authentication_error(self):
        err = AuthenticationError()
        assert err.status_code == 401
        assert err.error_type == "authentication_error"

    def test_authorization_error(self):
        err = AuthorizationError()
        assert err.status_code == 403
        assert err.error_type == "authorization_error"

    def test_subclass_custom_detail(self):
        """Subclasses should accept a custom detail while keeping status/type."""
        err = NotFoundError("Note not found")
        assert err.detail == "Note not found"
        assert err.status_code == 404
        assert err.error_type == "not_found"


# --------------------------------------------------------------------------- #
# Exception handlers (integration via httpx ASGITransport)
# --------------------------------------------------------------------------- #
def _build_test_app() -> FastAPI:
    """Minimal FastAPI app with error handlers and raising routes."""
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/not-found")
    async def _not_found():
        raise NotFoundError("Note not found")

    @app.get("/conflict")
    async def _conflict():
        raise ConflictError("Duplicate name")

    @app.get("/auth")
    async def _auth():
        raise AuthenticationError()

    @app.get("/boom")
    async def _boom():
        raise RuntimeError("unexpected crash")

    return app


class TestExceptionHandlers:
    @pytest.fixture
    def app(self):
        return _build_test_app()

    async def test_app_error_returns_json_with_error_type(self, app):
        """AppError should produce a JSON response with detail + error_type."""
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/not-found")
        assert resp.status_code == 404
        body = resp.json()
        assert body["detail"] == "Note not found"
        assert body["error_type"] == "not_found"

    async def test_conflict_returns_409(self, app):
        """ConflictError should produce a 409 response."""
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/conflict")
        assert resp.status_code == 409
        body = resp.json()
        assert body["error_type"] == "conflict"

    async def test_authentication_error_returns_401(self, app):
        """AuthenticationError should produce a 401 response."""
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/auth")
        assert resp.status_code == 401
        body = resp.json()
        assert body["error_type"] == "authentication_error"

    async def test_unexpected_exception_returns_500(self, app):
        """Unknown exceptions should produce a 500 server_error response."""
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/boom")
        assert resp.status_code == 500
        body = resp.json()
        assert body["detail"] == "Internal server error"
        assert body["error_type"] == "server_error"
