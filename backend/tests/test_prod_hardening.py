"""Focused production-hardening contracts."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml
from fastapi import FastAPI, Request
from httpx import ASGITransport
from pydantic import ValidationError

from app.auth.security import create_master_token, create_space_token


async def _request(app, *, body_frames, headers=()):
    messages = iter(
        [
            {"type": "http.request", "body": body, "more_body": more_body}
            for body, more_body in body_frames
        ]
    )

    async def receive():
        return next(messages, {"type": "http.request", "body": b"", "more_body": False})

    sent = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/upload",
        "raw_path": b"/upload",
        "query_string": b"",
        "headers": list(headers),
        "client": ("198.51.100.10", 1234),
        "server": ("test", 80),
    }
    await app(scope, receive, send)
    start = next(message for message in sent if message["type"] == "http.response.start")
    response_body = b"".join(
        message.get("body", b"") for message in sent if message["type"] == "http.response.body"
    )
    return start, response_body


def _body_echo_app():
    app = FastAPI()

    @app.post("/upload")
    async def upload(request: Request):
        body = await request.body()
        return {"size": len(body), "body": body.decode()}

    return app


@pytest.mark.parametrize(
    "raw",
    [b"", b"-1", b"+1", b"abc", b"1.5", b" 1"],
)
async def test_body_limit_rejects_invalid_content_length(raw):
    from app.body_size_limit import BodySizeLimitMiddleware

    start, body = await _request(
        BodySizeLimitMiddleware(_body_echo_app(), max_bytes=4),
        body_frames=[(b"", False)],
        headers=[(b"content-length", raw)],
    )
    assert start["status"] == 400
    assert json.loads(body)["error_type"] == "invalid_content_length"


async def test_body_limit_rejects_duplicate_content_length():
    from app.body_size_limit import BodySizeLimitMiddleware

    start, _ = await _request(
        BodySizeLimitMiddleware(_body_echo_app(), max_bytes=4),
        body_frames=[(b"a", False)],
        headers=[(b"content-length", b"1"), (b"content-length", b"1")],
    )
    assert start["status"] == 400


@pytest.mark.parametrize(
    ("frames", "expected_status"),
    [
        ([(b"abcd", False)], 200),
        ([(b"abc", True), (b"d", False)], 200),
        ([(b"abc", True), (b"de", False)], 413),
    ],
)
async def test_body_limit_checks_actual_stream_without_content_length(frames, expected_status):
    from app.body_size_limit import BodySizeLimitMiddleware

    middleware = BodySizeLimitMiddleware(_body_echo_app(), max_bytes=4)
    start, body = await _request(middleware, body_frames=frames)
    assert start["status"] == expected_status
    if expected_status == 200:
        assert json.loads(body)["size"] == 4
    else:
        assert json.loads(body)["error_type"] == "request_too_large"


async def test_body_limit_rejects_content_length_with_transfer_encoding():
    from app.body_size_limit import BodySizeLimitMiddleware

    start, body = await _request(
        BodySizeLimitMiddleware(_body_echo_app(), max_bytes=4),
        body_frames=[(b"a", False)],
        headers=[(b"content-length", b"1"), (b"transfer-encoding", b"chunked")],
    )
    assert start["status"] == 400
    assert json.loads(body)["error_type"] == "invalid_request_framing"


@pytest.mark.parametrize(
    ("declared", "actual"),
    [(b"2", b"a"), (b"1", b"ab")],
)
async def test_body_limit_rejects_content_length_mismatch(declared, actual):
    from app.body_size_limit import BodySizeLimitMiddleware

    start, body = await _request(
        BodySizeLimitMiddleware(_body_echo_app(), max_bytes=4),
        body_frames=[(actual, False)],
        headers=[(b"content-length", declared)],
    )
    assert start["status"] == 400
    assert json.loads(body)["error_type"] == "content_length_mismatch"


@pytest.mark.parametrize(
    ("message_or_error", "error_type"),
    [
        ({"type": "http.disconnect"}, "request_disconnected"),
        (RuntimeError("transport leaked password=leak"), "invalid_request_body"),
    ],
)
async def test_body_limit_stably_handles_disconnect_and_receive_exception(
    message_or_error, error_type
):
    from app.body_size_limit import BodySizeLimitMiddleware

    async def receive():
        if isinstance(message_or_error, Exception):
            raise message_or_error
        return message_or_error

    sent = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/upload",
        "raw_path": b"/upload",
        "query_string": b"",
        "headers": [],
        "client": ("198.51.100.10", 1234),
        "server": ("test", 80),
    }
    await BodySizeLimitMiddleware(_body_echo_app(), max_bytes=4)(scope, receive, send)
    starts = [item for item in sent if item["type"] == "http.response.start"]
    assert [item["status"] for item in starts] == [400]
    response_body = b"".join(
        item.get("body", b"") for item in sent if item["type"] == "http.response.body"
    )
    assert json.loads(response_body)["error_type"] == error_type
    assert b"password=leak" not in response_body


async def test_body_limit_does_not_send_second_start_after_response_started():
    from app.body_size_limit import BodySizeLimitMiddleware

    async def starts_then_reads(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await receive()

    start, body = await _request(
        BodySizeLimitMiddleware(starts_then_reads, max_bytes=1),
        body_frames=[(b"ab", False)],
    )
    assert start["status"] == 200
    assert body == b""


async def test_declared_oversize_gets_request_id_and_security_headers(client):
    response = await client.post(
        "/api/v1/auth/login",
        content=b"x",
        headers={"content-length": str(10 * 1024 * 1024 + 1)},
    )
    assert response.status_code == 413
    assert response.json()["error_type"] == "request_too_large"
    assert response.headers["x-request-id"]
    assert response.headers["x-content-type-options"] == "nosniff"
    cors = await client.post(
        "/api/v1/auth/login",
        content=b"x",
        headers={
            "content-length": str(10 * 1024 * 1024 + 1),
            "origin": "http://localhost:5173",
        },
    )
    assert cors.status_code == 413
    assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"


async def test_rate_limit_response_gets_request_id_and_security_headers(client):
    for _ in range(10):
        response = await client.post(
            "/api/v1/auth/login",
            json={"password": "wrong"},
            headers={"x-request-id": "rate-limit-test"},
        )
        assert response.status_code == 401
    response = await client.post(
        "/api/v1/auth/login",
        json={"password": "wrong"},
        headers={"x-request-id": "rate-limit-test"},
    )
    assert response.status_code == 429
    assert response.headers["x-request-id"] == "rate-limit-test"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert int(response.headers["retry-after"]) >= 1
    cors = await client.post(
        "/api/v1/auth/login",
        json={"password": "wrong"},
        headers={"origin": "http://localhost:5173"},
    )
    assert cors.status_code == 429
    assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"


def _rate_app(*, trusted_proxies=(), limit=2, max_clients=10):
    from app.rate_limit import RateLimitMiddleware

    async def ok(scope, receive, send):
        await httpx.Response(204).aclose()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    return RateLimitMiddleware(
        ok,
        limits={"/api/v1/auth/login": (limit, 60.0)},
        max_clients=max_clients,
        trusted_proxies=trusted_proxies,
    )


async def _rate_request(
    app, peer: str, forwarded: str | None = None, method: str = "POST"
):
    headers = [] if forwarded is None else [(b"x-forwarded-for", forwarded.encode())]
    scope = {
        "type": "http",
        "method": method,
        "path": "/api/v1/auth/login",
        "headers": headers,
        "client": (peer, 1234),
    }
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    await app(scope, receive, send)
    start = next(message for message in sent if message["type"] == "http.response.start")
    return start


async def test_untrusted_peer_cannot_spoof_forwarded_for():
    limiter = _rate_app(limit=1)
    assert (await _rate_request(limiter, "198.51.100.7", "203.0.113.1"))["status"] == 204
    limited = await _rate_request(limiter, "198.51.100.7", "203.0.113.2")
    assert limited["status"] == 429
    assert dict(limited["headers"])[b"retry-after"] == b"60"


async def test_trusted_proxy_uses_first_untrusted_address_from_right():
    limiter = _rate_app(trusted_proxies=["10.0.0.0/8"], limit=1)
    assert (await _rate_request(limiter, "10.0.0.2", "203.0.113.1, 10.0.0.1"))["status"] == 204
    assert (await _rate_request(limiter, "10.0.0.2", "203.0.113.2, 10.0.0.1"))["status"] == 204
    assert (await _rate_request(limiter, "10.0.0.2", "203.0.113.1, 10.0.0.1"))["status"] == 429


async def test_rate_limit_concurrency_is_atomic_and_state_isolated():
    limiter = _rate_app(limit=5)
    statuses = await asyncio.gather(*[
        _rate_request(limiter, "198.51.100.8") for _ in range(20)
    ])
    assert [item["status"] for item in statuses].count(204) == 5
    assert [item["status"] for item in statuses].count(429) == 15
    assert limiter.tracked_key_count == 1
    fresh = _rate_app(limit=5)
    assert (await _rate_request(fresh, "198.51.100.8"))["status"] == 204


async def test_rate_limit_state_is_bounded_without_evicting_active_keys():
    limiter = _rate_app(limit=2, max_clients=3)
    active = [f"198.51.100.{index + 1}" for index in range(3)]
    for peer in active:
        assert (await _rate_request(limiter, peer))["status"] == 204
    assert (await _rate_request(limiter, "198.51.100.99"))["status"] == 429
    assert limiter.tracked_key_count == 3
    for peer in active:
        assert (await _rate_request(limiter, peer))["status"] == 204
        assert (await _rate_request(limiter, peer))["status"] == 429
    assert limiter.tracked_hit_count == 6


async def test_rate_limit_canonicalizes_ipv6_keys():
    limiter = _rate_app(limit=1)
    assert (await _rate_request(limiter, "2001:0db8:0:0:0:0:0:1"))["status"] == 204
    assert (await _rate_request(limiter, "2001:db8::1"))["status"] == 429
    assert limiter.tracked_key_count == 1


@pytest.mark.parametrize("method", ["GET", "OPTIONS"])
async def test_rate_limit_only_counts_post(method):
    limiter = _rate_app(limit=1)
    for _ in range(3):
        assert (await _rate_request(limiter, "198.51.100.5", method=method))["status"] == 204
    assert limiter.tracked_key_count == 0
    assert (await _rate_request(limiter, "198.51.100.5"))["status"] == 204
    assert (await _rate_request(limiter, "198.51.100.5"))["status"] == 429


def _event(payload: dict[str, Any] | None = None):
    return {
        "entity_type": "task",
        "entity_id": "x",
        "action": "create",
        "payload": payload or {},
    }


@pytest.mark.parametrize("count", [1, 500])
def test_sync_event_count_accepts_bounds(count):
    from app.schemas.sync import SyncPushRequest

    assert len(SyncPushRequest(events=[_event() for _ in range(count)]).events) == count


@pytest.mark.parametrize("count", [0, 501])
def test_sync_event_count_rejects_outside_bounds(count):
    from app.schemas.sync import SyncPushRequest

    with pytest.raises(ValidationError):
        SyncPushRequest(events=[_event() for _ in range(count)])


def test_sync_payload_utf8_compact_json_boundary(monkeypatch):
    import app.settings as settings_module
    from app.schemas.sync import SyncEvent

    monkeypatch.setattr(settings_module.settings, "sync_event_payload_max_bytes", 11)
    assert SyncEvent(**_event({"x": "你"})).payload == {"x": "你"}  # exactly 11 bytes
    with pytest.raises(ValidationError):
        SyncEvent(**_event({"x": "你你"}))  # 14 UTF-8 bytes


@pytest.mark.parametrize("payload", [{"x": float("nan")}, {"x": float("inf")}, {"x": object()}])
def test_sync_payload_rejects_non_json_values(payload):
    from app.schemas.sync import SyncEvent

    with pytest.raises(ValidationError) as exc_info:
        SyncEvent(**_event(payload))
    assert "valid JSON" in str(exc_info.value)


async def test_sync_validation_uses_safe_422_envelope():
    from app.errors import register_exception_handlers
    from app.schemas.sync import SyncPushRequest

    app = FastAPI()
    register_exception_handlers(app)

    @app.post("/sync")
    async def sync(body: SyncPushRequest):
        return body

    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as local_client:
        response = await local_client.post(
            "/sync",
            content='{"events":[{"entity_type":"task","entity_id":"x","action":"create","payload":{"x":NaN}}]}',
            headers={"content-type": "application/json"},
        )
    assert response.status_code == 422
    body = response.json()
    assert body["error_type"] == "request_validation_error"
    assert body["detail"] == "Request validation failed"
    assert "input" not in body["errors"][0]


async def test_ready_success(client):
    response = await client.get("/api/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


async def test_ready_failure_is_stable_and_does_not_leak(
    client, monkeypatch, caplog
):
    import app.db.meta_session as meta_session

    class BrokenSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def execute(self, statement):
            raise RuntimeError("secret-db-host password=leak")

    monkeypatch.setattr(meta_session, "get_meta_session_factory", lambda: BrokenSession)
    response = await client.get("/api/ready")
    assert response.status_code == 503
    assert response.json() == {
        "detail": "Service is not ready",
        "error_type": "service_not_ready",
    }
    assert "secret-db-host" not in response.text
    assert "password=leak" not in caplog.text
    assert "Traceback" not in caplog.text


async def test_metrics_auth_and_prometheus_contract(client):
    missing = await client.get("/api/metrics")
    assert missing.status_code == 401

    space_token = create_space_token("space", "user")
    forbidden = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {space_token}"}
    )
    assert forbidden.status_code == 403

    master_token = create_master_token("operator")
    success = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {master_token}"}
    )
    assert success.status_code == 200
    assert success.headers["content-type"].startswith("text/plain; version=0.0.4")
    assert "pomodoroxii_api_up 1" in success.text


async def test_openapi_sync_bounds_and_metrics_security(client):
    schema = (await client.get("/openapi.json")).json()
    events = schema["components"]["schemas"]["SyncPushRequest"]["properties"]["events"]
    assert events["minItems"] == 1
    assert events["maxItems"] == 500
    metrics = schema["paths"]["/api/metrics"]["get"]
    assert metrics["security"] == [{"HTTPBearer": []}]
    assert set(metrics["responses"]) >= {"200", "401", "403"}
    assert "text/plain" in metrics["responses"]["200"]["content"]
    for status in ("401", "403"):
        response_schema = metrics["responses"][status]["content"]["application/json"]["schema"]
        assert response_schema["$ref"] == "#/components/schemas/ErrorResponse"
    assert not schema["paths"]["/api/ready"]["get"].get("security")


@pytest.mark.parametrize(
    "field",
    [
        "master_token_expire_days",
        "space_token_expire_hours",
        "engine_pool_max_size",
        "request_body_max_bytes",
        "sync_event_payload_max_bytes",
    ],
)
def test_settings_require_positive_values(field):
    from app.settings import Settings

    with pytest.raises(ValidationError):
        Settings(**{field: 0})


def test_readiness_deployment_contracts():
    root = Path(__file__).resolve().parents[2]
    compose = yaml.safe_load(
        (root / "backend" / "docker-compose.yml").read_text(encoding="utf-8")
    )
    ci = yaml.safe_load(
        (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    )

    healthcheck = compose["services"]["backend"]["healthcheck"]["test"]
    assert any("/api/ready" in part for part in healthcheck)
    assert all("/api/health" not in part for part in healthcheck)

    triggers = ci.get("on", ci.get(True))
    assert set(triggers["push"]["branches"]) == {"main", "master", "develop"}
    assert set(triggers["pull_request"]["branches"]) == {"main", "master"}
    steps = ci["jobs"]["build"]["steps"]
    login = next(step for step in steps if step["name"] == "Log in to GitHub Container Registry")
    publish = next(step for step in steps if step["name"] == "Push main/master image to GHCR")
    expected_publish_condition = (
        "github.event_name == 'push' && "
        "(github.ref_name == 'main' || github.ref_name == 'master')"
    )
    assert login["if"] == expected_publish_condition
    assert publish["if"] == expected_publish_condition
    build = next(step for step in steps if step["name"] == "Build image for smoke test")
    assert build["with"]["push"] is False
    assert build["with"]["load"] is True
    smoke = next(step for step in steps if step["name"] == "Smoke-test the image")["run"]
    assert "POMODOROXII_ENVIRONMENT=production" in smoke
    assert "POMODOROXII_SECRET_KEY=" in smoke
    assert "-v pomodoroxii-smoke-data:/app/data" in smoke
    assert "POMODOROXII_DATABASE_URL=sqlite+aiosqlite:////app/data/meta.db" in smoke
    assert "POMODOROXII_SPACES_DATA_DIR=/app/data/spaces" in smoke
    assert "/api/ready" in smoke
    assert "docker volume rm -f pomodoroxii-smoke-data" in smoke
    publish_run = publish["run"]
    assert 'docker push "$IMAGE:${{ github.sha }}"' in publish_run
    assert 'docker push "$IMAGE:latest"' in publish_run
