"""REST v2 sync adapter contracts."""

from __future__ import annotations

import base64
import hashlib

import pytest
from pydantic import ValidationError

from app.main import app


def test_sync_operation_catalog_is_exact_and_immutable() -> None:
    from app.sync.operations import SYNC_OPERATIONS

    assert tuple((item.name, item.rest_method, item.rest_path, item.runtime_mode) for item in SYNC_OPERATIONS) == (
        ("query_operations", "POST", "/api/v1/sync/v2/operations/query", "write"),
        ("push", "POST", "/api/v1/sync/v2/push", "write"),
        ("pull", "GET", "/api/v1/sync/v2/pull", "write"),
        ("recover", "GET", "/api/v1/sync/v2/recover", "write"),
        ("ack", "POST", "/api/v1/sync/v2/ack", "write"),
        ("status", "GET", "/api/v1/sync/v2/status", "read"),
    )
    with pytest.raises(AttributeError):
        SYNC_OPERATIONS[0].name = "changed"  # type: ignore[misc]


def test_openapi_exposes_exact_v2_routes_and_no_legacy_routes() -> None:
    paths = app.openapi()["paths"]
    expected = {
        "/api/v1/sync/v2/operations/query": "post",
        "/api/v1/sync/v2/push": "post",
        "/api/v1/sync/v2/pull": "get",
        "/api/v1/sync/v2/recover": "get",
        "/api/v1/sync/v2/ack": "post",
        "/api/v1/sync/v2/status": "get",
    }
    assert {path: next(iter(set(paths[path]) & {"get", "post"})) for path in expected} == expected
    assert not {
        "/api/v1/sync/push",
        "/api/v1/sync/pull",
        "/api/v1/sync/full",
        "/api/v1/sync/status",
    } & paths.keys()


def _event(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "entity_type": "note",
        "entity_id": "note-a",
        "action": "create",
        "payload": {},
        "expected_version": None,
        "client_updated_at": "2026-07-14T10:00:00.000Z",
        "operation_id": "op-a",
    }
    value.update(changes)
    return value


@pytest.mark.parametrize(
    "change",
    [
        {"client_updated_at": "2026-07-14T10:00:00+00:00"},
        {"client_updated_at": "2026-02-30T10:00:00Z"},
        {"expected_version": False},
        {"expected_version": 2**53},
        {"action": "update", "expected_version": None},
        {"action": "create", "expected_version": 0},
    ],
)
def test_v2_event_rejects_noncanonical_values(change: dict[str, object]) -> None:
    from app.schemas.sync import SyncV2Event

    with pytest.raises(ValidationError):
        SyncV2Event.model_validate(_event(**change))


def test_v2_push_rejects_more_than_500_events() -> None:
    from app.schemas.sync import SyncV2PushRequest

    with pytest.raises(ValidationError):
        SyncV2PushRequest(client_id="client-a", batch_id="batch-a", events=[_event()] * 501)


def test_recovery_base64_accepts_exact_canonical_bytes_and_rejects_noncanonical() -> None:
    from app.schemas.sync import SyncV2RecoveryResponse

    raw = b'{"id":"a"}\n'
    common = {
        "entity_count": 1,
        "chunk_sha256": hashlib.sha256(raw).hexdigest(),
        "next_page_token": None,
        "has_more": False,
        "catalog_hash": "b" * 64,
        "waterline_cursor": "cursor-token-1234",
    }
    model = SyncV2RecoveryResponse(
        payload_jsonl_base64=base64.b64encode(raw).decode("ascii"), **common
    )
    assert model.entity_count == 1
    with pytest.raises(ValidationError):
        SyncV2RecoveryResponse(payload_jsonl_base64="YWJj\n", **common)


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (b'{"client_id":"a","client_id":"b","batch_id":"x","events":[]}', "duplicate_object_key"),
        (b'\xef\xbb\xbf{"client_id":"a","batch_id":"x","events":[]}', "invalid_json"),
        (b'{"client_id":"a","batch_id":"x","events":[]} trailing', "invalid_json"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":NaN}}]}', "non_i_json_number"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":1,"x":2}}]}', "duplicate_object_key"),
    ],
)
async def test_invalid_raw_push_is_rejected_before_authentication(
    client, raw: bytes, code: str
) -> None:
    response = await client.post(
        "/api/v1/sync/v2/push",
        content=raw,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.headers["X-PomodoroXII-Error-Code"] == code


async def test_numeric_cursor_is_rejected_before_authentication(client) -> None:
    response = await client.get(
        "/api/v1/sync/v2/pull",
        params={"client_id": "client-a", "cursor": "1"},
    )
    assert response.status_code == 422


async def test_canonical_sync_input_error_has_exact_five_keys(client) -> None:
    response = await client.post(
        "/api/v1/sync/v2/ack",
        content=b'{"client_id":"a","client_id":"b","cursor":"cursor-token-1234"}',
        headers={
            "Content-Type": "application/json",
            "Accept": "application/vnd.pomodoroxii.error+json;version=2",
        },
    )
    assert response.status_code == 422
    assert set(response.json()) == {"code", "message", "retryable", "request_id", "details"}


@pytest.mark.provisioned_space_storage
async def test_v2_push_and_operation_query_delegate_to_protocol(client) -> None:
    setup = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert setup.status_code == 201
    login = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    master = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post("/api/v1/spaces", json={"name": "Sync V2"}, headers=master)
    token = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token", headers=master
    )
    headers = {"Authorization": f"Bearer {token.json()['space_token']}"}

    recovery = await client.get(
        "/api/v1/sync/v2/recover",
        params={"client_id": "client-v2"},
        headers=headers,
    )
    assert recovery.status_code == 200, recovery.text
    recovery_body = recovery.json()
    while recovery_body["has_more"]:
        recovery = await client.get(
            "/api/v1/sync/v2/recover",
            params={
                "client_id": "client-v2",
                "page_token": recovery_body["next_page_token"],
            },
            headers=headers,
        )
        assert recovery.status_code == 200, recovery.text
        recovery_body = recovery.json()
    acknowledged = await client.post(
        "/api/v1/sync/v2/ack",
        json={
            "client_id": "client-v2",
            "cursor": recovery_body["waterline_cursor"],
        },
        headers=headers,
    )
    assert acknowledged.status_code == 200, acknowledged.text

    pushed = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": "client-v2",
            "batch_id": "batch-v2",
            "events": [
                _event(
                    entity_type="not-sync-enabled",
                    entity_id="unsupported-a",
                    operation_id="op-v2",
                )
            ],
        },
        headers=headers,
    )
    assert pushed.status_code == 200, pushed.text
    assert pushed.json()["batch_id"] == "batch-v2"
    assert [item["operation_id"] for item in pushed.json()["errors"]] == ["op-v2"]

    queried = await client.post(
        "/api/v1/sync/v2/operations/query",
        json={"client_id": "client-v2", "operation_ids": ["op-v2"]},
        headers=headers,
    )
    assert queried.status_code == 200, queried.text
    assert queried.json()["items"][0]["state"] == "terminal"
    assert queried.json()["items"][0]["result"] == pushed.json()
