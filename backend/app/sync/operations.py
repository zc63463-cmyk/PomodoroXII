"""Frozen transport operation catalog shared by REST and MCP adapters."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from app.errors import AppError, IdempotencyConflictError
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

SyncOperationName = Literal[
    "query_operations", "push", "pull", "recover", "ack", "status"
]


class SyncTransportInputError(AppError):
    """Canonical Adapter for transport-neutral Sync input failures."""

    detail = "Invalid sync input"
    status_code = 422
    legacy_error_type = "validation_error"
    retryable = False

    def __init__(self, error: SyncInputError) -> None:
        super().__init__(code=error.code, details=error.details)


def sync_input_app_error(error: SyncInputError) -> AppError:
    if error.code == "idempotency_conflict":
        return IdempotencyConflictError()
    return SyncTransportInputError(error)


@dataclass(frozen=True, slots=True)
class ValidatedSyncCall:
    operation: SyncOperationName
    client_id: str | None = None
    batch_id: str | None = None
    events: tuple[SyncEventInput, ...] = ()
    operation_ids: tuple[str, ...] = ()
    cursor: str | None = None
    page_token: str | None = None
    limit: int | None = None


def _invalid_input(exc: Exception) -> SyncInputError:
    if isinstance(exc, SyncInputError):
        return exc
    return SyncInputError("invalid_sync_input", {"reason": str(exc)})


def _decode_object(raw: bytes, *, max_body_bytes: int) -> Mapping[str, object]:
    value = decode_sync_i_json(raw, max_bytes=max_body_bytes)
    if not isinstance(value, Mapping):
        raise SyncInputError("invalid_sync_input", {"reason": "json_object_required"})
    return value


def _exact_keys(value: Mapping[str, object], required: set[str]) -> None:
    if set(value) != required:
        raise SyncInputError(
            "invalid_sync_input",
            {
                "missing": sorted(required - set(value)),
                "unexpected": sorted(set(value) - required),
            },
        )


def validate_push_call(
    raw: bytes,
    *,
    max_body_bytes: int,
    max_event_bytes: int,
    max_batch_bytes: int,
) -> ValidatedSyncCall:
    try:
        value = _decode_object(raw, max_body_bytes=max_body_bytes)
        _exact_keys(value, {"client_id", "batch_id", "events"})
        events = parse_sync_event_batch(
            {"events": value["events"]},
            max_event_bytes=max_event_bytes,
            max_batch_bytes=max_batch_bytes,
        )
        client_id, batch_id, events = validate_sync_push_inputs(
            value["client_id"],
            value["batch_id"],
            events,
            max_event_bytes=max_event_bytes,
            max_batch_bytes=max_batch_bytes,
        )
    except (KeyError, SyncInputError, TypeError, ValueError) as exc:
        raise _invalid_input(exc) from exc
    return ValidatedSyncCall("push", client_id, batch_id, events)


def validate_operation_query_call(raw: bytes, *, max_body_bytes: int) -> ValidatedSyncCall:
    try:
        value = _decode_object(raw, max_body_bytes=max_body_bytes)
        _exact_keys(value, {"client_id", "operation_ids"})
        operation_ids = value["operation_ids"]
        if not isinstance(operation_ids, list):
            raise ValueError("operation_ids must be an array")
        client_id, validated_ids = validate_operation_query_inputs(
            value["client_id"], operation_ids
        )
    except (KeyError, SyncInputError, TypeError, ValueError) as exc:
        raise _invalid_input(exc) from exc
    return ValidatedSyncCall("query_operations", client_id, operation_ids=validated_ids)


def validate_ack_call(raw: bytes, *, max_body_bytes: int) -> ValidatedSyncCall:
    try:
        value = _decode_object(raw, max_body_bytes=max_body_bytes)
        _exact_keys(value, {"client_id", "cursor"})
        client_id = validate_client_id(value["client_id"])
        cursor = validate_cursor_token(value["cursor"])
    except (KeyError, SyncInputError, TypeError, ValueError) as exc:
        raise _invalid_input(exc) from exc
    return ValidatedSyncCall("ack", client_id, cursor=cursor)


def _query_values(
    pairs: Sequence[tuple[str, str]], *, allowed: set[str]
) -> dict[str, str]:
    keys = [key for key, _value in pairs]
    if len(keys) != len(set(keys)) or set(keys) - allowed:
        raise SyncInputError("invalid_sync_input", {"reason": "invalid_query_keys"})
    return dict(pairs)


def validate_pull_call(pairs: Sequence[tuple[str, str]]) -> ValidatedSyncCall:
    try:
        values = _query_values(pairs, allowed={"client_id", "cursor", "limit"})
        if set(values) not in (
            {"client_id"},
            {"client_id", "cursor"},
            {"client_id", "limit"},
            {"client_id", "cursor", "limit"},
        ):
            raise ValueError("invalid pull query")
        client_id = validate_client_id(values["client_id"])
        cursor = values.get("cursor")
        if cursor is not None:
            cursor = validate_cursor_token(cursor)
        raw_limit = values.get("limit", "100")
        if not raw_limit.isascii() or not raw_limit.isdigit() or raw_limit.startswith("0"):
            raise ValueError("limit must be canonical decimal")
        limit = int(raw_limit)
        if not 1 <= limit <= 500:
            raise ValueError("limit must be between 1 and 500")
    except (KeyError, SyncInputError, TypeError, ValueError) as exc:
        raise _invalid_input(exc) from exc
    return ValidatedSyncCall("pull", client_id, cursor=cursor, limit=limit)


def validate_recover_call(pairs: Sequence[tuple[str, str]]) -> ValidatedSyncCall:
    try:
        values = _query_values(pairs, allowed={"client_id", "page_token"})
        if set(values) not in ({"client_id"}, {"client_id", "page_token"}):
            raise ValueError("invalid recovery query")
        client_id = validate_client_id(values["client_id"])
        page_token = values.get("page_token")
        if page_token is not None:
            page_token = validate_page_token(page_token)
    except (KeyError, SyncInputError, TypeError, ValueError) as exc:
        raise _invalid_input(exc) from exc
    return ValidatedSyncCall("recover", client_id, page_token=page_token)


def validate_status_call(pairs: Sequence[tuple[str, str]]) -> ValidatedSyncCall:
    try:
        values = _query_values(pairs, allowed={"client_id"})
        if set(values) not in (set(), {"client_id"}):
            raise ValueError("invalid status query")
        client_id = values.get("client_id")
        if client_id is not None:
            client_id = validate_client_id(client_id)
    except (SyncInputError, TypeError, ValueError) as exc:
        raise _invalid_input(exc) from exc
    return ValidatedSyncCall("status", client_id)


@dataclass(frozen=True, slots=True)
class SyncOperationSpec:
    name: SyncOperationName
    rest_method: str
    rest_path: str
    mcp_tool: str
    runtime_mode: Literal["read", "write"]


SYNC_OPERATIONS = (
    SyncOperationSpec("query_operations", "POST", "/api/v1/sync/v2/operations/query", "sync_query_operations", "write"),
    SyncOperationSpec("push", "POST", "/api/v1/sync/v2/push", "sync_push", "write"),
    SyncOperationSpec("pull", "GET", "/api/v1/sync/v2/pull", "sync_pull", "write"),
    SyncOperationSpec("recover", "GET", "/api/v1/sync/v2/recover", "sync_recover", "write"),
    SyncOperationSpec("ack", "POST", "/api/v1/sync/v2/ack", "sync_ack", "write"),
    SyncOperationSpec("status", "GET", "/api/v1/sync/v2/status", "get_sync_status", "read"),
)

SYNC_OPERATION_BY_NAME = {item.name: item for item in SYNC_OPERATIONS}

__all__ = [
    "SYNC_OPERATIONS",
    "SYNC_OPERATION_BY_NAME",
    "SyncOperationName",
    "SyncOperationSpec",
    "SyncTransportInputError",
    "ValidatedSyncCall",
    "sync_input_app_error",
    "validate_ack_call",
    "validate_operation_query_call",
    "validate_pull_call",
    "validate_push_call",
    "validate_recover_call",
    "validate_status_call",
]
