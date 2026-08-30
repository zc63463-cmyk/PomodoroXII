"""S5 Task 4: observability contracts.

Covers operations-token auth on ``/api/metrics``, low-cardinality Prometheus
labels (method/route/status_class and operation/outcome only), route-template
observation, the persistent data-root readiness probe with redaction,
single-Space health isolation, and redacted parseable structured JSONL logs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _disable_backup(_isolate_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Client-lifespan tests must not require a backup target.

    The shared conftest ``client`` fixture enters the application lifespan,
    which fails when ``backup_enabled`` is true without an external target.
    These observability tests do not exercise the recovery scheduler, so the
    feature is disabled here without touching production defaults.
    """
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", False)


async def _issue_operations_token() -> str:
    """Issue one real operations token against the test Meta database."""
    from app.db.meta_session import get_meta_session
    from app.ops.credentials import OperationsCredentialStore

    async for session in get_meta_session():
        store = OperationsCredentialStore(session)
        issued = await store.issue()
        return issued.token
    raise AssertionError("meta session never yielded")


# --------------------------------------------------------------------------- #
# /api/metrics operations-token auth
# --------------------------------------------------------------------------- #


async def test_metrics_missing_token_returns_401(client) -> None:
    response = await client.get("/api/metrics")
    assert response.status_code == 401


async def test_metrics_master_token_returns_403(client) -> None:
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert login.status_code == 200
    master_token = login.json()["access_token"]

    response = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {master_token}"}
    )
    assert response.status_code == 403


async def test_metrics_space_token_returns_403(client) -> None:
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_token = login.json()["access_token"]
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "metrics-space"},
        headers={"authorization": f"Bearer {master_token}"},
    )
    assert created.status_code == 201
    issued = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token",
        headers={"authorization": f"Bearer {master_token}"},
    )
    space_token = issued.json()["space_token"]

    response = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {space_token}"}
    )
    assert response.status_code == 403


async def test_metrics_operations_token_returns_200_prometheus_contract(client) -> None:
    token = await _issue_operations_token()
    response = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain; version=0.0.4")
    assert "pomodoroxii_api_up 1" in response.text


@pytest.mark.parametrize(
    ("operation", "outcome"),
    [("space-123", "success"), ("snapshot", "user-controlled-result")],
)
def test_recovery_metric_rejects_unbounded_label_values(
    operation: str, outcome: str
) -> None:
    from app.ops.routes import record_recovery_operation

    with pytest.raises(ValueError, match="unsupported recovery metric label"):
        record_recovery_operation(operation, outcome)


async def test_metrics_revoked_operations_token_returns_403(client) -> None:
    from app.db.meta_session import get_meta_session
    from app.ops.credentials import OperationsCredentialStore

    token = await _issue_operations_token()
    async for session in get_meta_session():
        await OperationsCredentialStore(session).revoke()
    response = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {token}"}
    )
    assert response.status_code == 403


async def test_metrics_collect_real_fleet_state_without_identity_labels(client) -> None:
    import sqlite3

    from sqlalchemy import select

    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space

    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_token = login.json()["access_token"]
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "observability-fleet-space"},
        headers={"authorization": f"Bearer {master_token}"},
    )
    assert created.status_code == 201
    space_id = created.json()["id"]

    async for session in get_meta_session():
        row = await session.scalar(select(Space).where(Space.id == space_id))
        assert row is not None
        space_db = Path(row.db_path)
        break
    else:
        raise AssertionError("meta session never yielded")

    timestamp = "2026-08-15T00:00:00.000Z"
    with sqlite3.connect(space_db) as connection:
        connection.execute(
            "INSERT INTO mutation_batches "
            "(batch_id,command_hash,state,accepted_count,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            ("pending-batch", "a" * 64, "INTENT", 0, timestamp, timestamp),
        )
        connection.execute(
            "UPDATE sync_state SET retention_floor=0,current_cursor=3 WHERE id=1"
        )
        connection.execute(
            "INSERT INTO sync_clients "
            "(client_id,ack_sequence,catalog_hash,registered_at,last_seen_at,expires_at,"
            "requires_recovery,recovery_generation) VALUES (?,?,?,?,?,?,?,?)",
            ("client-a", 1, "b" * 64, timestamp, timestamp, timestamp, 0, 0),
        )
        for sequence in range(1, 4):
            connection.execute(
                "INSERT INTO sync_outbox "
                "(id,entity_type,entity_id,action,payload,created_at,visible) "
                "VALUES (?,?,?,?,?,?,1)",
                (sequence, "note", f"note-{sequence}", "update", "{}", timestamp),
            )

    token = await _issue_operations_token()
    response = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    assert "pomodoroxii_pending_mutations 1.0" in response.text
    assert "pomodoroxii_sync_lag_events 2.0" in response.text
    assert "pomodoroxii_degraded_spaces 0.0" in response.text
    oldest_age = next(
        float(line.rsplit(" ", 1)[1])
        for line in response.text.splitlines()
        if line.startswith("pomodoroxii_pending_mutation_oldest_age_seconds ")
    )
    assert oldest_age > 300
    assert space_id not in _find_metric_block(
        response.text, "pomodoroxii_pending_mutations"
    )


# --------------------------------------------------------------------------- #
# Low-cardinality labels and route templates
# --------------------------------------------------------------------------- #


async def _metrics_text(client, token: str) -> str:
    response = await client.get(
        "/api/metrics", headers={"authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    return response.text


async def test_http_metrics_labels_are_low_cardinality(client) -> None:
    """Request metrics carry only method/route/status_class, never ids/paths."""
    token = await _issue_operations_token()
    # Drive a few requests with distinct shapes: a space-scoped id, a 404, and a health hit.
    await client.get("/api/ready")
    await client.get("/api/v1/spaces/not-a-real-space-id-12345")
    await client.get("/api/definitely-not-a-route")
    text = await _metrics_text(client, token)

    metric = "pomodoroxii_http_requests_total"
    block = _find_metric_block(text, metric)
    # Route labels are matched templates (placeholders like {space_id} are
    # fixed low-cardinality strings) or "unmatched" for 404s.  Concrete id
    # values, request ids, raw paths and long base64url tokens must never
    # appear as label values.
    assert "not-a-real-space-id-12345" not in block
    assert "definitely-not-a-route" not in block
    assert token not in block
    # Route labels are matched templates (relative sub-router templates are
    # fine) or "unmatched"; the raw URIs this test drove must never appear.
    import re as _re

    labels = _re.findall(r'route="([^"]*)"', block)
    assert labels, "expected at least one http request label"
    for label in labels:
        assert label != "not-a-real-space-id-12345", label
        assert label != "definitely-not-a-route", label
        assert "/api/v1/spaces/not-a-real-space-id-12345" not in label

    samples = [
        line
        for line in block.splitlines()
        if line.startswith("pomodoroxii_http_requests_total{")
    ]
    assert samples
    for sample in samples:
        names = set(_re.findall(r"[{,]([a-z_]+)=", sample))
        assert names == {"method", "route", "status_class"}


async def test_http_metrics_use_route_template_not_raw_uri(client) -> None:
    token = await _issue_operations_token()
    await client.get("/api/v1/spaces/space-a1b2c3")
    await client.get("/api/ready")
    text = await _metrics_text(client, token)

    metric = "pomodoroxii_http_requests_total"
    block = _find_metric_block(text, metric)
    # prometheus-client escapes braces in label values, so the template
    # appears as \{space_id\}; the raw id must never appear.
    assert "space_id" in block
    assert "space-a1b2c3" not in block
    assert "/api/ready" in block


async def test_http_metrics_unmatched_route_label_used_for_404(client) -> None:
    token = await _issue_operations_token()
    await client.get("/api/no-such-endpoint")
    text = await _metrics_text(client, token)

    metric = "pomodoroxii_http_requests_total"
    block = _find_metric_block(text, metric)
    assert 'route="unmatched"' in block


async def test_http_metrics_count_unhandled_exception_as_5xx() -> None:
    from starlette.requests import Request

    from app.middleware import RequestMetricsMiddleware
    from app.ops.routes import HTTP_REQUESTS

    labels = HTTP_REQUESTS.labels("GET", "unmatched", "5xx")
    before = labels._value.get()
    middleware = RequestMetricsMiddleware(lambda _scope, _receive, _send: None)
    request = Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/boom",
            "raw_path": b"/boom",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 1),
            "server": ("test", 80),
        }
    )

    async def fail(_request):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await middleware.dispatch(request, fail)

    assert labels._value.get() == before + 1


def _find_metric_block(text: str, name: str) -> str:
    """Return the HELP..series block for *name*; fail if the metric is absent."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"# HELP {name}"))
    end = start + 1
    while end < len(lines) and not lines[end].startswith("# HELP"):
        end += 1
    block = "\n".join(lines[start:end])
    assert name in block
    return block


# --------------------------------------------------------------------------- #
# Readiness: persistent data-root write probe and redaction
# --------------------------------------------------------------------------- #


async def test_ready_checks_data_root_write_probe(client, monkeypatch) -> None:
    """Readiness fails closed when the data root cannot be written+fsynced."""
    import app.main as main_module

    def broken_probe() -> None:
        raise OSError("readiness-probe-broken-disk")

    monkeypatch.setattr(main_module, "_probe_data_root", broken_probe)
    response = await client.get("/api/ready")
    assert response.status_code == 503
    body = response.json()
    assert body == {
        "detail": "Service is not ready",
        "error_type": "service_not_ready",
    }


async def test_ready_checks_meta_main_database_write_probe(client, monkeypatch) -> None:
    import app.main as main_module

    calls = 0

    async def reject_main_write(connection) -> None:
        nonlocal calls
        calls += 1
        raise OSError("meta database is read only")

    monkeypatch.setattr(main_module, "_probe_meta_writable", reject_main_write)
    response = await client.get("/api/ready")

    assert calls == 1
    assert response.status_code == 503
    assert response.json()["error_type"] == "service_not_ready"


async def test_meta_write_probe_rejects_real_read_only_database(tmp_path: Path) -> None:
    import sqlite3

    from sqlalchemy.exc import OperationalError
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.main import _probe_meta_writable

    meta_db = tmp_path / "readonly-meta.db"
    with sqlite3.connect(meta_db) as connection:
        connection.execute(
            "CREATE TABLE alembic_version_meta (version_num TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO alembic_version_meta VALUES ('meta_001')")

    engine = create_async_engine(
        f"sqlite+aiosqlite:///file:{meta_db.as_posix()}?mode=ro&uri=true"
    )
    try:
        async with engine.connect() as connection:
            with pytest.raises(OperationalError, match="readonly database"):
                await _probe_meta_writable(connection)
    finally:
        await engine.dispose()


async def test_ready_failure_redacts_paths_and_internal_detail(
    client, monkeypatch, caplog
) -> None:
    import app.main as main_module

    def leaking_probe() -> None:
        raise OSError("C:/Users/secret-owner/AppData/password=leak")

    monkeypatch.setattr(main_module, "_probe_data_root", leaking_probe)
    response = await client.get("/api/ready")
    assert response.status_code == 503
    assert "secret-owner" not in response.text
    assert "password=leak" not in response.text
    assert "AppData" not in response.text
    assert "Traceback" not in response.text
    assert "secret-owner" not in caplog.text
    assert "password=leak" not in caplog.text
    assert "Traceback" not in caplog.text


# --------------------------------------------------------------------------- #
# Single-Space health: degradation is isolated from global readiness
# --------------------------------------------------------------------------- #


async def _provision_space(client) -> dict:
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_token = login.json()["access_token"]
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "health-space"},
        headers={"authorization": f"Bearer {master_token}"},
    )
    assert created.status_code == 201
    space_id = created.json()["id"]
    issued = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers={"authorization": f"Bearer {master_token}"},
    )
    return {
        "space_id": space_id,
        "master_token": master_token,
        "space_token": issued.json()["space_token"],
    }


@pytest.mark.provisioned_space_storage
async def test_space_health_healthy_returns_200(client) -> None:
    ctx = await _provision_space(client)
    response = await client.get(
        f"/api/v1/spaces/{ctx['space_id']}/health",
        headers={"authorization": f"Bearer {ctx['space_token']}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["space_id"] == ctx["space_id"]
    assert body["available"] is True


@pytest.mark.provisioned_space_storage
async def test_space_health_degraded_returns_503_and_global_ready_stays_up(
    client, monkeypatch
) -> None:
    ctx = await _provision_space(client)
    app = client._transport.app
    runtime = app.state.runtime
    real_health = runtime.health
    real_is_degraded = runtime.is_degraded

    async def degraded_health(scope, *, catalog_hash=""):
        result = await real_health(scope, catalog_hash=catalog_hash)
        return result.__class__(
            result.space_id,
            False,
            result.migration_head,
            result.index_schema_version,
            result.catalog_hash,
            "mutation_recovery_required",
        )

    monkeypatch.setattr(runtime, "is_degraded", lambda space_id: space_id == ctx["space_id"])
    monkeypatch.setattr(runtime, "health", degraded_health)
    try:
        degraded = await client.get(
            f"/api/v1/spaces/{ctx['space_id']}/health",
            headers={"authorization": f"Bearer {ctx['space_token']}"},
        )
        assert degraded.status_code == 503
        assert degraded.json()["error_type"] in {
            "space_recovery_required",
            "service_unavailable",
            "service_not_ready",
        }
    finally:
        monkeypatch.setattr(runtime, "is_degraded", real_is_degraded)
        monkeypatch.setattr(runtime, "health", real_health)

    ready = await client.get("/api/ready")
    assert ready.status_code == 200


@pytest.mark.provisioned_space_storage
async def test_space_health_requires_auth(client) -> None:
    ctx = await _provision_space(client)
    no_token = await client.get(f"/api/v1/spaces/{ctx['space_id']}/health")
    assert no_token.status_code == 401
    master = await client.get(
        f"/api/v1/spaces/{ctx['space_id']}/health",
        headers={"authorization": f"Bearer {ctx['master_token']}"},
    )
    assert master.status_code == 403


# --------------------------------------------------------------------------- #
# Structured JSONL logs: parseable and redacted
# --------------------------------------------------------------------------- #


def test_structured_jsonl_is_parseable_and_redacted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Configured structured log path yields parseable JSONL without secrets."""
    import app.logging as logging_module
    import app.settings as settings_module

    log_file = tmp_path / "structured.jsonl"
    monkeypatch.setattr(settings_module.settings, "structured_log_path", log_file)
    logging_module.setup_logging()

    logger = logging.getLogger("pomodoroxi.test")
    logger.info("startup complete at %s", "E:/Users/secret-owner/AppData/pxii")
    logger.info("token=%s password=%s", "raw-token-value", "raw-password-value")
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtb3duZXIifQ.signature-value"
    logger.info("Authorization: Bearer %s", jwt)
    logger.info('{"authorization":"Bearer %s"}', jwt)
    logger.info("headers={'Authorization': 'Bearer %s'}", jwt)
    request_jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZXF1ZXN0LWlkIn0.request-signature"
    request_token = logging_module.request_id_var.set(
        f"Authorization: Bearer {request_jwt}"
    )
    try:
        logger.info("request-bound message")
    finally:
        logging_module.request_id_var.reset(request_token)

    handler = next(
        h
        for h in logging.getLogger().handlers
        if getattr(h, "_pomodoroxii_structured", False)
    )
    handler.flush()
    if hasattr(handler, "stream") and handler.stream is not None:
        handler.stream.flush()

    lines = log_file.read_text(encoding="utf-8").splitlines()
    assert len(lines) >= 2
    for line in lines:
        record = json.loads(line)
        assert isinstance(record, dict)
        text = line
        assert "secret-owner" not in text
        assert "AppData" not in text
        assert "raw-token-value" not in text
        assert "raw-password-value" not in text
        assert jwt not in text
        assert request_jwt not in text


def test_close_structured_logging_removes_and_closes_file_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.logging as logging_module
    import app.settings as settings_module

    monkeypatch.setattr(
        settings_module.settings,
        "structured_log_path",
        tmp_path / "structured-close.jsonl",
    )
    logging_module.setup_logging()
    root = logging.getLogger()
    handler = next(
        h for h in root.handlers if getattr(h, "_pomodoroxii_structured", False)
    )

    logging_module.close_structured_logging()

    assert handler not in root.handlers
    assert getattr(handler, "stream", None) is None


def test_data_root_probe_fails_closed_when_probe_cannot_be_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.main as main_module
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "data_root", tmp_path)
    original_unlink = Path.unlink

    def reject_probe_unlink(path: Path, *args, **kwargs) -> None:
        if path.name.startswith(".readiness_probe_"):
            raise PermissionError("probe removal denied")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", reject_probe_unlink)
    with pytest.raises(PermissionError, match="probe removal denied"):
        main_module._probe_data_root()


def test_slo_latency_query_keeps_histogram_bucket_boundary() -> None:
    slo = (Path(__file__).resolve().parents[1] / "SLO.md").read_text(
        encoding="utf-8"
    )

    assert "sum by (le, route, method)" in slo
    assert 'route=~"/api/v1/sync/.*"' in slo
    assert 'route=~"/sync.*"' not in slo
    assert "status != 'committed'" not in slo
    assert "pomodoroxii_pending_mutation_oldest_age_seconds" in slo
    assert "< 300 seconds" in slo
    assert "< 26 h" in slo
    assert "older than 24 h" not in slo


def test_slo_contract_is_tracked_and_clean_checkout_ready() -> None:
    """The SLO contract must live OUTSIDE the gitignored ``docs/`` tree so a
    fresh checkout always carries it.  ``git check-ignore`` returning non-zero
    proves the path is not ignored and therefore ships with the repository.
    """
    slo = Path(__file__).resolve().parents[1] / "SLO.md"
    assert slo.is_file(), "tracked SLO contract missing"
    assert "docs" not in slo.parts, "SLO contract must not live under docs/"
    check = subprocess.run(
        ["git", "check-ignore", "--no-index", str(slo)],
        cwd=slo.parents[1],
        capture_output=True,
        text=True,
    )
    assert check.returncode == 1, f"SLO contract is gitignored: {check.stdout}"


def test_slo_referenced_metrics_are_exported_by_ops() -> None:
    """The PromQL/scrape queries in the SLO contract must refer only to metric
    families the application actually exports, so the query boundary cannot
    drift silently from the implementation.
    """
    from prometheus_client import REGISTRY

    import app.ops.routes as ops_routes  # noqa: F401  (registers the metrics)

    slo = (Path(__file__).resolve().parents[1] / "SLO.md").read_text(
        encoding="utf-8"
    )
    referenced = set(re.findall(r"pomodoroxii_[a-z0-9_]+", slo))
    assert referenced, "SLO contract references no pomodoroxii_* metrics"

    exported = {metric.name for metric in REGISTRY.collect()}
    for name in referenced:
        # Histogram families surface as <name>_bucket/_sum/_count samples and
        # Counter families surface as <name>_total in exposition, but both
        # register a single family under the base name; strip those suffixes.
        family = re.sub(r"_(bucket|sum|count|total)$", "", name)
        assert family in exported, (
            f"SLO contract references metric {name!r} (family {family!r}) "
            "that app.ops.routes does not export"
        )

    histogram_family = "pomodoroxii_http_request_duration_seconds"
    assert histogram_family in exported, "latency histogram family missing"
    family = next(m for m in REGISTRY.collect() if m.name == histogram_family)
    assert family.type == "histogram", "latency metric must stay a histogram"
