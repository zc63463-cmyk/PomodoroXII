"""Thin REST adapters for the transport-neutral Sync v2 protocol."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from app.auth.authority import Principal
from app.deps import get_current_user
from app.errors import AppError, ValidationError, to_wire_json
from app.schemas.sync import (
    SyncV2AckRequest,
    SyncV2AckResponse,
    SyncV2OperationQueryRequest,
    SyncV2OperationQueryResponse,
    SyncV2PullResponse,
    SyncV2PushRequest,
    SyncV2PushResponse,
    SyncV2RecoveryResponse,
    SyncV2StatusResponse,
)
from app.settings import settings
from app.sync.contracts import (
    SyncEventInput,
    SyncInputError,
    decode_sync_i_json,
    parse_sync_event_batch,
    validate_client_id,
    validate_cursor_token,
    validate_operation_query_inputs,
    validate_page_token,
    validate_sync_push_inputs,
)
from app.sync.operations import SYNC_OPERATION_BY_NAME, sync_input_app_error
from app.sync.protocol import SyncProtocol

router = APIRouter()


@dataclass(frozen=True, slots=True)
class ValidatedSyncCall:
    operation: str
    client_id: str | None = None
    batch_id: str | None = None
    events: tuple[SyncEventInput, ...] = ()
    operation_ids: tuple[str, ...] = ()
    cursor: str | None = None
    page_token: str | None = None
    limit: int | None = None


def _input_error(exc: Exception) -> AppError:
    if isinstance(exc, SyncInputError):
        return sync_input_app_error(exc)
    return ValidationError("Invalid sync input", details={"reason": str(exc)})


async def _raw_object(request: Request) -> Mapping[str, object]:
    raw = await request.body()
    bounded = getattr(request.state, "raw_body", raw)
    try:
        value = decode_sync_i_json(bounded, max_bytes=settings.request_body_max_bytes)
    except (SyncInputError, TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    if not isinstance(value, Mapping):
        raise ValidationError("Invalid sync input", details={"input_code": "invalid_json_object"})
    return value


def _exact_keys(value: Mapping[str, object], required: set[str]) -> None:
    if set(value) != required:
        raise ValidationError(
            "Invalid sync input",
            details={"missing": sorted(required - set(value)), "unexpected": sorted(set(value) - required)},
        )


async def validate_push_before_runtime(request: Request) -> ValidatedSyncCall:
    value = await _raw_object(request)
    _exact_keys(value, {"client_id", "batch_id", "events"})
    raw_events = value["events"]
    if isinstance(raw_events, list):
        expected = {
            "entity_type", "entity_id", "action", "payload", "expected_version",
            "client_updated_at", "operation_id",
        }
        for event in raw_events:
            if not isinstance(event, Mapping) or set(event) != expected:
                raise ValidationError("Invalid sync input", details={"input_code": "invalid_event"})
    try:
        request_model = SyncV2PushRequest.model_validate(value)
        events = parse_sync_event_batch(
            {"events": raw_events},
            max_event_bytes=settings.sync_event_payload_max_bytes,
            max_batch_bytes=settings.sync_canonical_batch_max_bytes,
        )
        client_id, batch_id, events = validate_sync_push_inputs(
            request_model.client_id,
            request_model.batch_id,
            events,
            max_event_bytes=settings.sync_event_payload_max_bytes,
            max_batch_bytes=settings.sync_canonical_batch_max_bytes,
        )
    except (SyncInputError, TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    return ValidatedSyncCall(
        "push", client_id, batch_id, events
    )


async def validate_operation_query_before_runtime(request: Request) -> ValidatedSyncCall:
    value = await _raw_object(request)
    _exact_keys(value, {"client_id", "operation_ids"})
    try:
        request_model = SyncV2OperationQueryRequest.model_validate(value)
        client_id, operation_ids = validate_operation_query_inputs(
            request_model.client_id, request_model.operation_ids
        )
    except (SyncInputError, TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    return ValidatedSyncCall("query_operations", client_id, operation_ids=operation_ids)


async def validate_ack_before_runtime(request: Request) -> ValidatedSyncCall:
    value = await _raw_object(request)
    _exact_keys(value, {"client_id", "cursor"})
    try:
        request_model = SyncV2AckRequest.model_validate(value)
        client_id = validate_client_id(request_model.client_id)
        cursor = validate_cursor_token(request_model.cursor)
    except (SyncInputError, TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    return ValidatedSyncCall("ack", client_id, cursor=cursor)


def _query_values(request: Request, allowed: set[str]) -> dict[str, str]:
    pairs = request.query_params.multi_items()
    keys = [key for key, _value in pairs]
    if len(keys) != len(set(keys)) or set(keys) - allowed:
        raise ValidationError("Invalid sync query")
    return dict(pairs)


async def validate_pull_before_runtime(request: Request) -> ValidatedSyncCall:
    values = _query_values(request, {"client_id", "cursor", "limit"})
    if set(values) not in ({"client_id"}, {"client_id", "cursor"}, {"client_id", "limit"}, {"client_id", "cursor", "limit"}):
        raise ValidationError("Invalid sync query")
    try:
        client_id = validate_client_id(values["client_id"])
        cursor = values.get("cursor")
        if cursor is not None:
            validate_cursor_token(cursor)
        raw_limit = values.get("limit", "100")
        if not raw_limit.isascii() or not raw_limit.isdigit() or raw_limit.startswith("0"):
            raise ValueError("limit must be canonical decimal")
        limit = int(raw_limit)
        if not 1 <= limit <= 500:
            raise ValueError("limit must be between 1 and 500")
    except (KeyError, TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    return ValidatedSyncCall("pull", client_id, cursor=cursor, limit=limit)


async def validate_recover_before_runtime(request: Request) -> ValidatedSyncCall:
    values = _query_values(request, {"client_id", "page_token"})
    try:
        client_id = validate_client_id(values["client_id"])
        page_token = values.get("page_token")
        if page_token is not None:
            validate_page_token(page_token)
    except (KeyError, TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    return ValidatedSyncCall("recover", client_id, page_token=page_token)


async def validate_status_before_runtime(request: Request) -> ValidatedSyncCall:
    values = _query_values(request, {"client_id"})
    try:
        client_id = values.get("client_id")
        if client_id is not None:
            validate_client_id(client_id)
    except (TypeError, ValueError) as exc:
        raise _input_error(exc) from exc
    return ValidatedSyncCall("status", client_id)


def _protocol_dependency(validator: Any):
    async def dependency(
        request: Request,
        call: ValidatedSyncCall = Depends(validator),
        user: dict[str, Any] = Depends(get_current_user),
    ) -> AsyncIterator[SyncProtocol]:
        if user.get("type") != "space" or not user.get("space_id"):
            from app.errors import AuthorizationError

            raise AuthorizationError("Space token required")
        services = getattr(request.app.state, "runtime_services", None)
        if services is None:
            raise RuntimeError("RuntimeServices are not installed")
        principal = Principal(
            subject=str(user["sub"]), token_type="space", space_id=str(user["space_id"]),
            epoch=int(user.get("epoch", 0)),
            expires_at=user.get("exp") if isinstance(user.get("exp"), int) else None,
        )
        spec = SYNC_OPERATION_BY_NAME[call.operation]
        handle = await services.scope.open(principal, str(user["space_id"]), spec.runtime_mode)
        try:
            yield SyncProtocol(handle, services.mutation_uow, catalog=services.catalog)
        finally:
            await handle.aclose()

    return dependency


_query_protocol = _protocol_dependency(validate_operation_query_before_runtime)
_push_protocol = _protocol_dependency(validate_push_before_runtime)
_pull_protocol = _protocol_dependency(validate_pull_before_runtime)
_recover_protocol = _protocol_dependency(validate_recover_before_runtime)
_ack_protocol = _protocol_dependency(validate_ack_before_runtime)
_status_protocol = _protocol_dependency(validate_status_before_runtime)


def _inline_openapi_schema(model: Any) -> dict[str, Any]:
    schema = model.model_json_schema()
    definitions = schema.pop("$defs", {})

    def expand(value: Any) -> Any:
        if isinstance(value, dict):
            reference = value.get("$ref")
            if isinstance(reference, str) and reference.startswith("#/$defs/"):
                return expand(definitions[reference.removeprefix("#/$defs/")])
            return {key: expand(item) for key, item in value.items()}
        if isinstance(value, list):
            return [expand(item) for item in value]
        return value

    return expand(schema)


def _request_schema(model: Any) -> dict[str, Any]:
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": _inline_openapi_schema(model)}},
        }
    }


@router.post(
    "/v2/operations/query",
    response_model=SyncV2OperationQueryResponse,
    openapi_extra=_request_schema(SyncV2OperationQueryRequest),
)
async def query_operations_v2(
    call: ValidatedSyncCall = Depends(validate_operation_query_before_runtime),
    protocol: SyncProtocol = Depends(_query_protocol),
) -> SyncV2OperationQueryResponse:
    result = await protocol.query_operations(call.client_id or "", call.operation_ids)
    return SyncV2OperationQueryResponse.model_validate(to_wire_json(result))


@router.post(
    "/v2/push",
    response_model=SyncV2PushResponse,
    openapi_extra=_request_schema(SyncV2PushRequest),
)
async def push_v2(
    call: ValidatedSyncCall = Depends(validate_push_before_runtime),
    protocol: SyncProtocol = Depends(_push_protocol),
) -> SyncV2PushResponse:
    result = await protocol.push(call.client_id or "", call.events, call.batch_id or "")
    return SyncV2PushResponse.model_validate(to_wire_json(result))


@router.get("/v2/pull", response_model=SyncV2PullResponse)
async def pull_v2(
    call: ValidatedSyncCall = Depends(validate_pull_before_runtime),
    protocol: SyncProtocol = Depends(_pull_protocol),
    client_id: str = Query(...),
    cursor: str | None = Query(None),
    limit: str = Query("100"),
) -> SyncV2PullResponse:
    del client_id, cursor, limit
    result = await protocol.pull(call.client_id or "", call.cursor, call.limit or 100)
    return SyncV2PullResponse.model_validate(to_wire_json(result))


@router.get("/v2/recover", response_model=SyncV2RecoveryResponse)
async def recover_v2(
    call: ValidatedSyncCall = Depends(validate_recover_before_runtime),
    protocol: SyncProtocol = Depends(_recover_protocol),
    client_id: str = Query(...),
    page_token: str | None = Query(None),
) -> SyncV2RecoveryResponse:
    del client_id, page_token
    result = await protocol.recover(call.client_id or "", call.page_token)
    wire = to_wire_json(result)
    return SyncV2RecoveryResponse.model_validate(
        {
            "payload_jsonl_base64": wire["jsonl_base64"],
            "entity_count": wire["entity_count"],
            "chunk_sha256": wire["sha256"],
            "next_page_token": wire["next_page_token"],
            "has_more": wire["has_more"],
            "catalog_hash": wire["catalog_hash"],
            "waterline_cursor": wire["waterline_cursor"],
        }
    )


@router.post(
    "/v2/ack",
    response_model=SyncV2AckResponse,
    openapi_extra=_request_schema(SyncV2AckRequest),
)
async def ack_v2(
    call: ValidatedSyncCall = Depends(validate_ack_before_runtime),
    protocol: SyncProtocol = Depends(_ack_protocol),
) -> SyncV2AckResponse:
    result = await protocol.ack(call.client_id or "", call.cursor or "")
    return SyncV2AckResponse.model_validate(to_wire_json(result))


@router.get("/v2/status", response_model=SyncV2StatusResponse)
async def status_v2(
    call: ValidatedSyncCall = Depends(validate_status_before_runtime),
    protocol: SyncProtocol = Depends(_status_protocol),
    client_id: str | None = Query(None),
) -> SyncV2StatusResponse:
    del client_id
    result = await protocol.status(call.client_id)
    return SyncV2StatusResponse.model_validate(to_wire_json(result))


__all__ = ["ValidatedSyncCall", "router"]
