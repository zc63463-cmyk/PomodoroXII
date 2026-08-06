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


@pytest.mark.parametrize("invalid", [None, -1, False, 1.0, "1", 2**53, 2**53 + 1])
def test_v2_response_integer_slots_are_required_strict_and_js_safe(invalid: object) -> None:
    from app.schemas.sync import (
        SyncV2EventRecord,
        SyncV2PushApplied,
        SyncV2StatusResponse,
    )

    timestamp = "2026-07-14T10:00:00.000Z"
    cases = (
        (
            SyncV2EventRecord,
            "version",
            {
                "operation_id": "op-a",
                "batch_id": "batch-a",
                "entity_type": "note",
                "entity_id": "note-a",
                "action": "create",
                "payload": {},
                "version": 0,
                "created_at": timestamp,
            },
        ),
        (
            SyncV2PushApplied,
            "version",
            {
                "operation_id": "op-a",
                "entity_type": "note",
                "entity_id": "note-a",
                "version": 0,
                "resolution": None,
            },
        ),
    )
    for model, field, valid in cases:
        with pytest.raises(ValidationError):
            model.model_validate({**valid, field: invalid})
        missing = dict(valid)
        missing.pop(field)
        with pytest.raises(ValidationError):
            model.model_validate(missing)

    status = {
        "catalog_hash": "a" * 64,
        "client_id": None,
        "registered": False,
        "requires_recovery": None,
        "recovery_action": None,
        "visible_event_count": 0,
        "active_client_count": 0,
        "recovery_client_count": 0,
    }
    for field in ("visible_event_count", "active_client_count", "recovery_client_count"):
        with pytest.raises(ValidationError):
            SyncV2StatusResponse.model_validate({**status, field: invalid})
        missing = dict(status)
        missing.pop(field)
        with pytest.raises(ValidationError):
            SyncV2StatusResponse.model_validate(missing)


@pytest.mark.parametrize(
    "created_at",
    [
        "2026-07-14T10:00:00+00:00",
        "2026-07-14t10:00:00.000Z",
        "2026-02-30T10:00:00.000Z",
        "2026-07-14T10:00:00.000z",
    ],
)
def test_v2_event_record_rejects_noncanonical_created_at(created_at: str) -> None:
    from app.schemas.sync import SyncV2EventRecord

    with pytest.raises(ValidationError):
        SyncV2EventRecord.model_validate(
            {
                "operation_id": "op-a",
                "batch_id": "batch-a",
                "entity_type": "note",
                "entity_id": "note-a",
                "action": "create",
                "payload": {},
                "version": 0,
                "created_at": created_at,
            }
        )


def test_pull_and_recovery_enforce_record_and_exact_page_budgets() -> None:
    import rfc8785

    from app.schemas.sync import SyncV2PullResponse, SyncV2RecoveryResponse
    from app.sync.contracts import (
        MAX_DECODED_CANONICAL_PAGE_BYTES,
        MAX_RECOVERY_BASE64_CHARS,
    )

    event = {
        "operation_id": "op-a",
        "batch_id": "batch-a",
        "entity_type": "note",
        "entity_id": "note-a",
        "action": "create",
        "payload": {"blob": ""},
        "version": 0,
        "created_at": "2026-07-14T10:00:00.000Z",
    }
    pull = {
        "events": [event],
        "next_cursor": "cursor-token-1234",
        "has_more": False,
        "catalog_hash": "a" * 64,
    }
    base_size = len(rfc8785.dumps(pull))
    filler_size = MAX_DECODED_CANONICAL_PAGE_BYTES - base_size
    exact_pull = {
        **pull,
        "events": [{**event, "payload": {"blob": "x" * filler_size}}],
    }
    assert len(rfc8785.dumps(exact_pull)) == MAX_DECODED_CANONICAL_PAGE_BYTES
    SyncV2PullResponse.model_validate(exact_pull)
    with pytest.raises(ValidationError):
        SyncV2PullResponse.model_validate(
            {
                **pull,
                "events": [{**event, "payload": {"blob": "x" * (filler_size + 1)}}],
            }
        )
    with pytest.raises(ValidationError):
        SyncV2PullResponse.model_validate({**pull, "events": [event] * 501})

    exact_raw = b"x" * (MAX_DECODED_CANONICAL_PAGE_BYTES - 1) + b"\n"
    exact_encoded = base64.b64encode(exact_raw).decode("ascii")
    assert len(exact_encoded) == MAX_RECOVERY_BASE64_CHARS
    recovery = {
        "payload_jsonl_base64": exact_encoded,
        "entity_count": 1,
        "chunk_sha256": hashlib.sha256(exact_raw).hexdigest(),
        "next_page_token": None,
        "has_more": False,
        "catalog_hash": "b" * 64,
        "waterline_cursor": "cursor-token-1234",
    }
    SyncV2RecoveryResponse.model_validate(recovery)

    oversized_raw = b"x" * MAX_DECODED_CANONICAL_PAGE_BYTES + b"\n"
    with pytest.raises(ValidationError):
        SyncV2RecoveryResponse.model_validate(
            {
                **recovery,
                "payload_jsonl_base64": base64.b64encode(oversized_raw).decode("ascii"),
                "chunk_sha256": hashlib.sha256(oversized_raw).hexdigest(),
            }
        )


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (b'{"client_id":"a","client_id":"b","batch_id":"x","events":[]}', "duplicate_object_key"),
        (b'\xef\xbb\xbf{"client_id":"a","batch_id":"x","events":[]}', "invalid_json"),
        (b'{"client_id":"a","batch_id":"x","events":[]} trailing', "invalid_json"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":NaN}}]}', "non_i_json_number"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":Infinity}}]}', "non_i_json_number"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":1,"x":2}}]}', "duplicate_object_key"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":9007199254740992}}]}', "unsafe_integer"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":"\\ud800"}}]}', "invalid_unicode"),
        (b'{"client_id":"a","batch_id":"x","events":[{"payload":{"x":"\xff"}}]}', "invalid_json"),
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


async def test_raw_push_rejects_duplicate_and_missing_event_operation_id(client) -> None:
    duplicate = await client.post(
        "/api/v1/sync/v2/push",
        content=(
            b'{"client_id":"client-a","batch_id":"batch-a","events":['
            b'{"entity_type":"note","entity_id":"note-a","action":"create",'
            b'"payload":{},"expected_version":null,'
            b'"client_updated_at":"2026-07-14T10:00:00.000Z",'
            b'"operation_id":"op-a","operation_id":"op-b"}]}'
        ),
        headers={"Content-Type": "application/json"},
    )
    assert duplicate.status_code == 422
    assert duplicate.headers["X-PomodoroXII-Error-Code"] == "duplicate_object_key"

    missing = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": "client-a",
            "batch_id": "batch-a",
            "events": [{key: value for key, value in _event().items() if key != "operation_id"}],
        },
    )
    assert missing.status_code == 422


@pytest.mark.parametrize("missing_key", ["payload", "expected_version"])
async def test_raw_push_rejects_missing_required_event_members(
    client, missing_key: str
) -> None:
    event = _event()
    event.pop(missing_key)
    response = await client.post(
        "/api/v1/sync/v2/push",
        json={"client_id": "client-a", "batch_id": "batch-a", "events": [event]},
    )

    assert response.status_code == 422
    assert response.headers["X-PomodoroXII-Error-Code"] == "invalid_event"


async def test_operation_query_rejects_duplicate_ids_before_authentication(client) -> None:
    response = await client.post(
        "/api/v1/sync/v2/operations/query",
        json={"client_id": "client-a", "operation_ids": ["op-a", "op-a"]},
    )
    assert response.status_code == 409
    assert response.headers["X-PomodoroXII-Error-Code"] == "idempotency_conflict"


async def test_operation_query_preserves_order_states_and_original_terminal_receipt(client) -> None:
    from unittest.mock import AsyncMock

    from app.routes.v1.sync import _query_protocol
    from app.sync.contracts import (
        OperationQueryItem,
        OperationQueryResult,
        PushApplied,
        PushResult,
    )

    operation_ids = ("op-unknown", "op-pending", "op-recovery", "op-terminal")
    terminal_result = PushResult(
        "compound-root",
        (PushApplied("op-terminal", "note", "note-a", 7),),
        (),
        (),
    )
    protocol = AsyncMock()
    protocol.query_operations.return_value = OperationQueryResult(
        (
            OperationQueryItem("op-unknown", "unknown"),
            OperationQueryItem("op-pending", "pending", "compound-root"),
            OperationQueryItem("op-recovery", "recovery_required", "compound-root"),
            OperationQueryItem("op-terminal", "terminal", "compound-root", terminal_result),
        )
    )

    async def override_protocol():
        yield protocol

    asgi_app = client._transport.app
    asgi_app.dependency_overrides[_query_protocol] = override_protocol
    try:
        response = await client.post(
            "/api/v1/sync/v2/operations/query",
            json={"client_id": "client-a", "operation_ids": list(operation_ids)},
        )
    finally:
        asgi_app.dependency_overrides.pop(_query_protocol, None)

    assert response.status_code == 200, response.text
    assert [item["operation_id"] for item in response.json()["items"]] == list(operation_ids)
    assert [item["state"] for item in response.json()["items"]] == [
        "unknown",
        "pending",
        "recovery_required",
        "terminal",
    ]
    assert response.json()["items"][-1]["result"] == {
        "batch_id": "compound-root",
        "applied": [
            {
                "operation_id": "op-terminal",
                "entity_type": "note",
                "entity_id": "note-a",
                "version": 7,
                "resolution": None,
            }
        ],
        "conflicts": [],
        "errors": [],
    }
    protocol.query_operations.assert_awaited_once_with("client-a", operation_ids)


async def test_route_enforces_exact_event_and_batch_canonical_byte_budgets(client) -> None:
    from app.errors import to_wire_json
    from app.settings import settings
    from app.sync.contracts import (
        SyncEventInput,
        canonical_sync_batch_bytes,
        canonical_sync_event_bytes,
    )

    def make_event(index: int, filler_size: int) -> SyncEventInput:
        return SyncEventInput.from_mapping(
            _event(
                entity_id=f"note-{index}",
                operation_id=f"op-{index}",
                payload={"blob": "x" * filler_size},
            )
        )

    def event_at_exact_size(index: int, target: int) -> SyncEventInput:
        low, high = 0, target
        while low <= high:
            middle = (low + high) // 2
            candidate = make_event(index, middle)
            size = len(canonical_sync_event_bytes(candidate))
            if size == target:
                return candidate
            if size < target:
                low = middle + 1
            else:
                high = middle - 1
        raise AssertionError(f"no event encodes to {target} bytes")

    exact_event = event_at_exact_size(500, settings.sync_event_payload_max_bytes)
    exact_event_response = await client.post(
        "/api/v1/sync/v2/push",
        json={"client_id": "client-a", "batch_id": "batch-a", "events": [to_wire_json(exact_event)]},
    )
    assert exact_event_response.status_code == 401

    oversized_event = make_event(500, len(exact_event.payload["blob"]) + 1)
    oversized_event_response = await client.post(
        "/api/v1/sync/v2/push",
        json={"client_id": "client-a", "batch_id": "batch-a", "events": [to_wire_json(oversized_event)]},
    )
    assert oversized_event_response.status_code == 422
    assert oversized_event_response.headers["X-PomodoroXII-Error-Code"] == "event_payload_too_large"

    events = [
        event_at_exact_size(index, settings.sync_event_payload_max_bytes)
        for index in range(39)
    ]
    low, high = 0, settings.sync_event_payload_max_bytes
    exact_batch = None
    while low <= high:
        middle = (low + high) // 2
        candidate = make_event(39, middle)
        size = len(canonical_sync_batch_bytes((*events, candidate)))
        if size == settings.sync_canonical_batch_max_bytes:
            exact_batch = (*events, candidate)
            break
        if size < settings.sync_canonical_batch_max_bytes:
            low = middle + 1
        else:
            high = middle - 1
    assert exact_batch is not None

    exact_batch_response = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": "client-a",
            "batch_id": "batch-a",
            "events": [to_wire_json(event) for event in exact_batch],
        },
    )
    assert exact_batch_response.status_code == 401

    last = exact_batch[-1]
    oversized_last = make_event(39, len(last.payload["blob"]) + 1)
    oversized_batch_response = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": "client-a",
            "batch_id": "batch-a",
            "events": [to_wire_json(event) for event in (*exact_batch[:-1], oversized_last)],
        },
    )
    assert oversized_batch_response.status_code == 422
    assert oversized_batch_response.headers["X-PomodoroXII-Error-Code"] == "sync_batch_too_large"


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


async def test_invalid_input_never_resolves_protocol_or_opens_runtime(client) -> None:
    from app.routes.v1.sync import _push_protocol

    resolved = False

    async def forbidden_protocol():
        nonlocal resolved
        resolved = True
        raise AssertionError("invalid input resolved the protocol dependency")
        yield  # pragma: no cover

    asgi_app = client._transport.app
    asgi_app.dependency_overrides[_push_protocol] = forbidden_protocol
    try:
        response = await client.post(
            "/api/v1/sync/v2/push",
            content=b'{"client_id":"client-a","client_id":"duplicate"}',
            headers={"Content-Type": "application/json"},
        )
    finally:
        asgi_app.dependency_overrides.pop(_push_protocol, None)

    assert response.status_code == 422
    assert resolved is False


async def test_rest_and_transport_neutral_validator_share_error_contract(client) -> None:
    from app.settings import settings
    from app.sync.contracts import SyncInputError
    from app.sync.operations import validate_push_call

    raw = (
        b'{"client_id":"client-a","batch_id":"batch-a","events":['
        b'{"entity_type":"note","entity_id":"note-a","action":"create",'
        b'"payload":{"nested":{"x":1,"x":2}},"expected_version":null,'
        b'"client_updated_at":"2026-07-14T10:00:00.000Z","operation_id":"op-a"}]}'
    )
    with pytest.raises(SyncInputError) as transport_error:
        validate_push_call(
            raw,
            max_body_bytes=settings.request_body_max_bytes,
            max_event_bytes=settings.sync_event_payload_max_bytes,
            max_batch_bytes=settings.sync_canonical_batch_max_bytes,
        )

    response = await client.post(
        "/api/v1/sync/v2/push",
        content=raw,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/vnd.pomodoroxii.error+json;version=2",
        },
    )
    assert response.status_code == 422
    assert response.json()["code"] == transport_error.value.code
    assert response.json()["details"] == dict(transport_error.value.details)


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
