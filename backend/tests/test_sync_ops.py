from __future__ import annotations

import json
import uuid
from datetime import timedelta

import pytest

from tests.test_sync_routes import _setup_login_and_space_token

EXPECTED_FIELDS = {
    "ledger": {"retained_events", "min_id", "max_id", "retention_floor", "current_cursor"},
    "clients": {
        "total", "active", "expired", "recovering", "revoked",
        "min_active_ack", "max_active_ack", "max_lag",
    },
    "snapshots": {
        "total", "ready", "building", "expired", "ready_items", "ready_chunks",
        "ready_compressed_bytes", "min_cursor", "max_cursor",
    },
    "data": {"entity_rows", "tombstones"},
    "audit": {"events_24h", "last_event_at"},
    "invariants": {"ledger_bounds_valid", "active_ack_bounds_valid"},
}
FORBIDDEN_FRAGMENTS = {
    "client_id", "user_id", "space_id", "token", "checksum", "details", "payload",
    "entity_id", "display_name",
}


def _iso(value) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _assert_fixed_private_shape(body: dict) -> None:
    assert set(body) == {*EXPECTED_FIELDS, "status", "server_time"}
    for section, fields in EXPECTED_FIELDS.items():
        assert set(body[section]) == fields

    def walk(value) -> None:
        if isinstance(value, dict):
            for key, nested in value.items():
                assert key not in FORBIDDEN_FRAGMENTS
                walk(nested)
        elif isinstance(value, list):
            for nested in value:
                walk(nested)

    walk(body)
    encoded = json.dumps(body).lower()
    for fragment in FORBIDDEN_FRAGMENTS:
        assert f'"{fragment}"' not in encoded


@pytest.mark.asyncio
async def test_health_empty_database_is_ok_and_fixed_shape(space_session):
    from app.services.sync_ops import SyncOpsService

    body = await SyncOpsService(space_session).health()

    _assert_fixed_private_shape(body)
    assert body["status"] == "ok"
    assert body["ledger"] == {
        "retained_events": 0, "min_id": None, "max_id": None,
        "retention_floor": 0, "current_cursor": 0,
    }
    assert body["clients"] == {
        "total": 0, "active": 0, "expired": 0, "recovering": 0, "revoked": 0,
        "min_active_ack": None, "max_active_ack": None, "max_lag": 0,
    }
    assert body["snapshots"]["total"] == 0
    assert body["data"] == {"entity_rows": 0, "tombstones": 0}
    assert body["audit"] == {"events_24h": 0, "last_event_at": None}
    assert body["invariants"] == {
        "ledger_bounds_valid": True, "active_ack_bounds_valid": True,
    }


@pytest.mark.asyncio
async def test_health_aggregates_pruned_ledger_clients_snapshots_and_audit(space_session):
    from app.models.sync_audit_log import SyncAuditLog
    from app.models.sync_client import SyncClient
    from app.models.sync_outbox import SyncOutbox
    from app.models.sync_state import SyncSnapshot, SyncState
    from app.models.tombstone import Tombstone
    from app.services.sync_ops import SyncOpsService
    from app.services.time import utc_now

    now = utc_now()
    past = _iso(now - timedelta(hours=1))
    old = _iso(now - timedelta(hours=25))
    future = _iso(now + timedelta(hours=1))
    expired = _iso(now - timedelta(seconds=1))
    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.retention_floor = 2
    state.current_cursor = 8
    space_session.add_all([
        SyncOutbox(id=3, entity_type="task", entity_id="private-a", action="create", payload="{}"),
        SyncOutbox(id=8, entity_type="task", entity_id="private-b", action="update", payload="{}"),
        SyncClient(client_id=str(uuid.uuid4()), user_id="user", ack_cursor=3, last_seen_at=past,
                   lease_expires_at=future, created_at=past, snapshot_required=False),
        SyncClient(client_id=str(uuid.uuid4()), user_id="user", ack_cursor=7, last_seen_at=past,
                   lease_expires_at=future, created_at=past, snapshot_required=False),
        SyncClient(client_id=str(uuid.uuid4()), user_id="user", ack_cursor=2, last_seen_at=past,
                   lease_expires_at=expired, created_at=past, snapshot_required=False),
        SyncClient(client_id=str(uuid.uuid4()), user_id="user", ack_cursor=2, last_seen_at=past,
                   lease_expires_at=future, created_at=past, snapshot_required=True),
        SyncClient(client_id=str(uuid.uuid4()), user_id="user", ack_cursor=2, last_seen_at=past,
                   lease_expires_at=future, created_at=past, snapshot_required=False, revoked_at=past),
        SyncSnapshot(token=str(uuid.uuid4()), cursor=6, status="ready", item_count=4,
                     chunk_count=2, compressed_bytes=40, expires_at=future),
        SyncSnapshot(token=str(uuid.uuid4()), cursor=7, status="ready", item_count=5,
                     chunk_count=3, compressed_bytes=50, expires_at=expired),
        SyncSnapshot(token=str(uuid.uuid4()), cursor=8, status="building", expires_at=future),
        Tombstone(entity_type="task", entity_id="secret", deleted_at=past),
        SyncAuditLog(event_type="push", entity_type="task", entity_id="secret", details="private", created_at=past),
        SyncAuditLog(event_type="pull", entity_type="task", entity_id="secret", details="private", created_at=old),
    ])
    await space_session.flush()

    body = await SyncOpsService(space_session).health()

    _assert_fixed_private_shape(body)
    assert body["ledger"] == {
        "retained_events": 2, "min_id": 3, "max_id": 8,
        "retention_floor": 2, "current_cursor": 8,
    }
    assert body["clients"] == {
        "total": 5, "active": 2, "expired": 1, "recovering": 1, "revoked": 1,
        "min_active_ack": 3, "max_active_ack": 7, "max_lag": 5,
    }
    assert body["snapshots"] == {
        "total": 3, "ready": 1, "building": 1, "expired": 1,
        "ready_items": 4, "ready_chunks": 2, "ready_compressed_bytes": 40,
        "min_cursor": 6, "max_cursor": 6,
    }
    assert body["data"]["tombstones"] == 1
    assert body["audit"] == {"events_24h": 1, "last_event_at": past}
    assert body["invariants"] == {
        "ledger_bounds_valid": True, "active_ack_bounds_valid": True,
    }
    assert body["status"] == "ok"


@pytest.mark.asyncio
@pytest.mark.parametrize("broken", ["ledger", "active_ack"])
async def test_health_degrades_for_each_broken_invariant(space_session, broken):
    from app.models.sync_client import SyncClient
    from app.models.sync_state import SyncState
    from app.services.sync_ops import SyncOpsService
    from app.services.time import utc_now

    now = utc_now()
    state = await space_session.get(SyncState, 1)
    assert state is not None
    if broken == "ledger":
        state.retention_floor = 5
        state.current_cursor = 4
    else:
        state.retention_floor = 2
        state.current_cursor = 4
        space_session.add(SyncClient(
            client_id=str(uuid.uuid4()), user_id="user", ack_cursor=5,
            last_seen_at=_iso(now), lease_expires_at=_iso(now + timedelta(hours=1)),
            created_at=_iso(now), snapshot_required=False,
        ))
    await space_session.flush()

    body = await SyncOpsService(space_session).health()

    assert body["status"] == "degraded"
    assert body["invariants"][f"{broken}_bounds_valid"] is False


@pytest.mark.asyncio
async def test_sync_ops_health_route_auth_privacy_failure_and_openapi(client, monkeypatch):
    from app.routes.v1 import sync as sync_routes
    from app.services.sync_ops import SyncOpsService

    logged: list[tuple[object, ...]] = []
    monkeypatch.setattr(sync_routes.logger, "error", lambda *args: logged.append(args))

    unauthenticated = await client.get("/api/v1/sync/ops/health")
    assert unauthenticated.status_code == 401

    master_token, space_token = await _setup_login_and_space_token(client)
    master = await client.get(
        "/api/v1/sync/ops/health",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    assert master.status_code == 403

    headers = {"Authorization": f"Bearer {space_token}"}
    healthy = await client.get("/api/v1/sync/ops/health", headers=headers)
    assert healthy.status_code == 200
    _assert_fixed_private_shape(healthy.json())

    secret = "raw-database-password"

    async def fail(_self):
        raise RuntimeError(secret)

    monkeypatch.setattr(SyncOpsService, "health", fail)
    failed = await client.get("/api/v1/sync/ops/health", headers=headers)
    assert failed.status_code == 503
    assert failed.json() == {
        "detail": "Sync health unavailable",
        "error_type": "sync_health_unavailable",
    }
    assert secret not in failed.text
    assert logged == [("Sync ops health failed: %s", "RuntimeError")]
    assert secret not in repr(logged)

    spec = (await client.get("/openapi.json")).json()
    responses = spec["paths"]["/api/v1/sync/ops/health"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "403", "503"}
