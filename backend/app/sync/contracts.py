"""Transport-neutral contracts and validation for Sync v2.

This module is deliberately independent of FastAPI and MCP.  Both adapters
must enter through the same frozen contracts before opening a Space runtime.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

import rfc8785

from app.errors import deep_freeze_json, to_wire_json
from app.mutation.types import (
    MutationRejection,
    MutationResult,
    PreparedBatchItem,
    canonical_json_bytes,
    validate_operation_id,
)
from app.sync.clients import AckResult

MAX_JS_SAFE_INTEGER = 2**53 - 1
MAX_SYNC_RECORDS = 500
MAX_DECODED_CANONICAL_PAGE_BYTES = 8 * 1024 * 1024
MAX_EVENT_PAYLOAD_BYTES = 256 * 1024
MAX_CANONICAL_BATCH_BYTES = 10 * 1024 * 1024
SYNC_UTC_RFC3339_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z"
)
_ASCII_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_PRINTABLE_ASCII_ID = re.compile(r"^[\x21-\x7e]{1,128}$")
_CLIENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_PUSH_CONFLICT_CODES = frozenset(
    {"version_conflict", "tombstone_conflict", "cycle_detected"}
)


class SyncInputError(ValueError):
    """Stable semantic input failure raised before runtime access."""

    def __init__(self, code: str, details: Mapping[str, object] | None = None):
        self.code = code
        self.details = deep_freeze_json(details or {})
        super().__init__(code)


class SyncLedgerIntegrityError(ValueError):
    """A persisted ledger row cannot be admitted to a v2 response."""


def require_safe_nonnegative_int(value: object, *, field: str) -> int:
    if type(value) is not int or value < 0 or value > MAX_JS_SAFE_INTEGER:
        raise ValueError(f"{field} must be a safe nonnegative integer")
    return value


def require_safe_expected_version(value: object) -> int | None:
    if value is None:
        return None
    return require_safe_nonnegative_int(value, field="expected_version")


def require_canonical_utc_rfc3339(value: object) -> str:
    if not isinstance(value, str) or SYNC_UTC_RFC3339_PATTERN.fullmatch(value) is None:
        raise ValueError("timestamp must be strict UTC RFC 3339")
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError("timestamp is not a valid UTC calendar value") from exc
    return value


def _validate_string(value: str, *, field: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or value != value.strip() or pattern.fullmatch(value) is None:
        raise ValueError(f"{field} is invalid")
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{field} contains an invalid Unicode scalar") from exc
    return value


def validate_client_id(value: str) -> str:
    return _validate_string(value, field="client_id", pattern=_CLIENT_ID)


def validate_batch_id(value: str) -> str:
    _validate_string(value, field="batch_id", pattern=_PRINTABLE_ASCII_ID)
    validate_operation_id(value)
    return value


def validate_sync_operation_id(value: str) -> str:
    # The S3 validator owns the 1..128 printable ASCII contract.  S4 adds the
    # no-leading/trailing-whitespace rule before delegating to it.
    _validate_string(value, field="operation_id", pattern=re.compile(r"^[\x21-\x7e]{1,128}$"))
    validate_operation_id(value)
    return value


def validate_page_token(value: str) -> str:
    if not isinstance(value, str) or value != value.strip():
        raise ValueError("page token is invalid")
    try:
        raw = value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("page token is invalid") from exc
    if not 16 <= len(raw) <= 2048:
        raise ValueError("page token length is invalid")
    return value


def validate_cursor_token(value: str) -> str:
    if not isinstance(value, str) or value != value.strip():
        raise ValueError("cursor token is invalid")
    try:
        raw = value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("cursor token is invalid") from exc
    if not 16 <= len(raw) <= 2048:
        raise ValueError("cursor token length is invalid")
    return value


def validate_pull_limit(value: int) -> int:
    if type(value) is not int or not 1 <= value <= MAX_SYNC_RECORDS:
        raise ValueError("limit must be an integer between 1 and 500")
    return value


def validate_i_json_graph(value: object, *, _path: str = "$") -> None:
    """Validate I-JSON values, including safe integer and scalar-string rules."""
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise SyncInputError("non_string_object_key", {"path": _path})
            try:
                key.encode("utf-8", "strict")
            except UnicodeEncodeError as exc:
                raise SyncInputError("invalid_unicode", {"path": _path}) from exc
            validate_i_json_graph(child, _path=f"{_path}.{key}")
        return
    if isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            validate_i_json_graph(child, _path=f"{_path}[{index}]")
        return
    if isinstance(value, str):
        try:
            value.encode("utf-8", "strict")
        except UnicodeEncodeError as exc:
            raise SyncInputError("invalid_unicode", {"path": _path}) from exc
        return
    if type(value) is int:
        if abs(value) > MAX_JS_SAFE_INTEGER:
            raise SyncInputError("unsafe_integer", {"path": _path})
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SyncInputError("non_i_json_number", {"path": _path})
        return
    if value is None or type(value) is bool:
        return
    raise SyncInputError("non_i_json_value", {"path": _path})


def require_frozen_i_json_object(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError("payload must be an object")
    validate_i_json_graph(value)
    frozen = deep_freeze_json(value)
    if not isinstance(frozen, Mapping):
        raise ValueError("payload must be an object")
    return frozen


def canonical_sync_event_bytes(event: "SyncEventInput") -> bytes:
    return rfc8785.dumps(
        {
            "action": event.action,
            "client_updated_at": event.client_updated_at,
            "entity_id": event.entity_id,
            "entity_type": event.entity_type,
            "expected_version": event.expected_version,
            "operation_id": event.operation_id,
            "payload": to_wire_json(event.payload),
        }
    )


def canonical_sync_batch_bytes(events: Sequence["SyncEventInput"]) -> bytes:
    return rfc8785.dumps([to_wire_json(event) for event in events])


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    output: dict[str, object] = {}
    for key, value in pairs:
        if key in output:
            raise SyncInputError("duplicate_object_key", {"key": key})
        output[key] = value
    return output


def _reject_nonfinite(_value: str) -> object:
    raise SyncInputError("non_i_json_number")


def _decode_ledger_payload(raw: object) -> Mapping[str, object]:
    """Decode one persisted payload without accepting ambiguous JSON."""
    if not isinstance(raw, str):
        raise SyncLedgerIntegrityError("sync ledger payload is not text")
    try:
        payload = json.loads(
            raw,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_nonfinite,
        )
        validate_i_json_graph(payload)
        frozen = require_frozen_i_json_object(payload)
    except SyncLedgerIntegrityError:
        raise
    except (SyncInputError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SyncLedgerIntegrityError("sync ledger payload is invalid") from exc
    return frozen


def decode_sync_i_json(raw: bytes, *, max_bytes: int) -> object:
    if not isinstance(raw, bytes) or len(raw) > max_bytes:
        raise SyncInputError("request_too_large")
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise SyncInputError("invalid_json") from exc
    if text.startswith("\ufeff"):
        raise SyncInputError("invalid_json")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_nonfinite,
        )
    except SyncInputError:
        raise
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SyncInputError("invalid_json") from exc
    validate_i_json_graph(value)
    return value


@dataclass(frozen=True, slots=True)
class OperationQueryItem:
    operation_id: str
    state: Literal["unknown", "pending", "terminal", "recovery_required"]
    batch_id: str | None = None
    result: "PushResult | None" = None

    def __post_init__(self) -> None:
        validate_sync_operation_id(self.operation_id)
        if self.state not in {"unknown", "pending", "terminal", "recovery_required"}:
            raise ValueError("invalid operation query state")
        if self.state == "unknown" and (self.batch_id is not None or self.result is not None):
            raise ValueError("unknown operation cannot expose a binding")
        if self.state in {"pending", "recovery_required"}:
            validate_batch_id(self.batch_id or "")
            if self.result is not None:
                raise ValueError("nonterminal operation cannot expose a result")
        if self.state == "terminal":
            validate_batch_id(self.batch_id or "")
            if not isinstance(self.result, PushResult) or self.result.batch_id != self.batch_id:
                raise ValueError("terminal operation requires its original batch result")


@dataclass(frozen=True, slots=True)
class OperationQueryResult:
    items: tuple[OperationQueryItem, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "items", tuple(self.items))
        if not 1 <= len(self.items) <= MAX_SYNC_RECORDS:
            raise ValueError("operation query count out of range")
        if len({item.operation_id for item in self.items}) != len(self.items):
            raise ValueError("duplicate operation query ID")


@dataclass(frozen=True, slots=True)
class SyncEventInput:
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, Any]
    expected_version: int | None
    client_updated_at: str
    operation_id: str

    def __post_init__(self) -> None:
        _validate_string(self.entity_type, field="entity_type", pattern=_ASCII_ID)
        _validate_string(self.entity_id, field="entity_id", pattern=_ASCII_ID)
        validate_sync_operation_id(self.operation_id)
        if not isinstance(self.action, str) or self.action not in {"create", "update", "delete"}:
            raise ValueError("unsupported sync action")
        object.__setattr__(self, "payload", require_frozen_i_json_object(self.payload))
        require_safe_expected_version(self.expected_version)
        if self.action == "create" and self.expected_version is not None:
            raise ValueError("create expected_version must be null")
        if self.action != "create" and self.expected_version is None:
            raise ValueError("update/delete expected_version is required")
        require_canonical_utc_rfc3339(self.client_updated_at)

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "SyncEventInput":
        if not isinstance(value, Mapping):
            raise SyncInputError("invalid_event")
        allowed = {
            "entity_type",
            "entity_id",
            "action",
            "payload",
            "expected_version",
            "client_updated_at",
            "operation_id",
        }
        if any(not isinstance(key, str) for key in value):
            raise SyncInputError("invalid_event", {"reason": "non_string_object_key"})
        unexpected = sorted(set(value) - allowed)
        if unexpected:
            raise SyncInputError("invalid_event", {"unexpected": unexpected})
        try:
            return cls(
                entity_type=value["entity_type"],
                entity_id=value["entity_id"],
                action=value["action"],
                payload=value.get("payload", {}),
                expected_version=value.get("expected_version"),
                client_updated_at=value["client_updated_at"],
                operation_id=value["operation_id"],
            )
        except KeyError as exc:
            raise SyncInputError("invalid_event", {"missing": str(exc)}) from exc
        except SyncInputError:
            raise
        except (TypeError, ValueError) as exc:
            raise SyncInputError("invalid_event", {"reason": str(exc)}) from exc


@dataclass(frozen=True, slots=True)
class SyncEventRecord:
    operation_id: str
    batch_id: str
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, Any]
    version: int
    created_at: str

    def __post_init__(self) -> None:
        validate_sync_operation_id(self.operation_id)
        validate_batch_id(self.batch_id)
        _validate_string(self.entity_type, field="entity_type", pattern=_ASCII_ID)
        _validate_string(self.entity_id, field="entity_id", pattern=_ASCII_ID)
        if self.action not in {"create", "update", "delete"}:
            raise ValueError("unsupported sync action")
        require_safe_nonnegative_int(self.version, field="version")
        require_canonical_utc_rfc3339(self.created_at)
        object.__setattr__(self, "payload", require_frozen_i_json_object(self.payload))

    @classmethod
    def from_row(cls, row: object) -> "SyncEventRecord":
        if row.operation_id is None or row.batch_id is None or row.version is None:
            raise SyncLedgerIntegrityError("legacy sync row requires full recovery")
        payload = _decode_ledger_payload(row.payload)
        return cls(
            operation_id=row.operation_id,
            batch_id=row.batch_id,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            action=row.action,
            payload=payload,
            version=row.version,
            created_at=row.created_at,
        )


@dataclass(frozen=True, slots=True)
class PushApplied:
    operation_id: str
    entity_type: str
    entity_id: str
    version: int
    resolution: Literal["remote"] | None = None

    def __post_init__(self) -> None:
        validate_sync_operation_id(self.operation_id)
        require_safe_nonnegative_int(self.version, field="version")
        if self.resolution not in {None, "remote"}:
            raise ValueError("invalid push resolution")


@dataclass(frozen=True, slots=True)
class PushConflict:
    operation_id: str
    entity_type: str
    entity_id: str
    code: Literal["version_conflict", "tombstone_conflict", "cycle_detected"]
    resolution: Literal["local", "tombstone", "circular_ref", "manual"]
    details: Mapping[str, Any]

    def __post_init__(self) -> None:
        validate_sync_operation_id(self.operation_id)
        if self.code not in _PUSH_CONFLICT_CODES:
            raise ValueError("invalid push conflict code")
        if self.resolution not in {"local", "tombstone", "circular_ref", "manual"}:
            raise ValueError("invalid conflict resolution")
        object.__setattr__(self, "details", require_frozen_i_json_object(self.details))


@dataclass(frozen=True, slots=True)
class PushError:
    operation_id: str
    entity_type: str
    entity_id: str
    code: str
    retryable: bool
    details: Mapping[str, Any]

    def __post_init__(self) -> None:
        validate_sync_operation_id(self.operation_id)
        if type(self.retryable) is not bool:
            raise TypeError("retryable must be bool")
        object.__setattr__(self, "details", require_frozen_i_json_object(self.details))


@dataclass(frozen=True, slots=True)
class PushResult:
    batch_id: str
    applied: tuple[PushApplied, ...]
    conflicts: tuple[PushConflict, ...]
    errors: tuple[PushError, ...]

    def __post_init__(self) -> None:
        validate_batch_id(self.batch_id)
        object.__setattr__(self, "applied", tuple(self.applied))
        object.__setattr__(self, "conflicts", tuple(self.conflicts))
        object.__setattr__(self, "errors", tuple(self.errors))
        ids = [item.operation_id for item in (*self.applied, *self.conflicts, *self.errors)]
        if len(ids) != len(set(ids)):
            raise ValueError("one push event may have exactly one result")

    @classmethod
    def from_uow(
        cls,
        batch_id: str,
        events: Sequence[SyncEventInput],
        applied: Sequence[MutationResult],
        rejected: Sequence[MutationRejection],
    ) -> "PushResult":
        validate_batch_id(batch_id)
        event_ids = tuple(event.operation_id for event in events)
        receipt_items = (*tuple(applied), *tuple(rejected))
        receipt_ids = tuple(item.operation_id for item in receipt_items)
        if len(event_ids) != len(set(event_ids)):
            raise ValueError("sync batch contains duplicate input operation IDs")
        if len(receipt_ids) != len(set(receipt_ids)) or set(receipt_ids) != set(event_ids):
            raise ValueError("UoW receipt does not cover input event exactly once")
        if any(item.batch_id != batch_id for item in applied):
            raise ValueError("applied mutation result has the wrong batch identity")
        applied_by_id = {item.operation_id: item for item in applied}
        rejected_by_id = {item.operation_id: item for item in rejected}
        output_applied: list[PushApplied] = []
        output_conflicts: list[PushConflict] = []
        output_errors: list[PushError] = []
        for event in events:
            result = applied_by_id.get(event.operation_id)
            rejection = rejected_by_id.get(event.operation_id)
            if (result is None) == (rejection is None):
                raise ValueError("UoW receipt does not cover input event exactly once")
            if result is not None:
                if result.version is None:
                    raise ValueError("applied mutation result is missing a version")
                output_applied.append(
                    PushApplied(
                        event.operation_id,
                        result.entity_type,
                        result.entity_id,
                        result.version,
                        result.resolution,
                    )
                )
                continue
            conflict_resolution = conflict_resolution_for_rejection(
                rejection.code, rejection.details
            )
            if conflict_resolution is not None:
                output_conflicts.append(
                    PushConflict(
                        event.operation_id,
                        rejection.entity_type,
                        rejection.entity_id,
                        rejection.code,
                        conflict_resolution,  # type: ignore[arg-type]
                        rejection.details,
                    )
                )
            else:
                output_errors.append(
                    PushError(
                        event.operation_id,
                        rejection.entity_type,
                        rejection.entity_id,
                        rejection.code,
                        rejection.retryable,
                        rejection.details,
                    )
                )
        return cls(batch_id, tuple(output_applied), tuple(output_conflicts), tuple(output_errors))


def conflict_resolution_for_rejection(
    code: str, details: Mapping[str, object]
) -> Literal["local", "tombstone", "circular_ref", "manual"] | None:
    """Project one durable rejection into the stable Sync conflict class."""
    if code == "version_conflict" and details.get("resolution") == "local":
        return "local"
    return {
        "version_conflict": "manual",
        "tombstone_conflict": "tombstone",
        "cycle_detected": "circular_ref",
    }.get(code)  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class PullPage:
    events: tuple[SyncEventRecord, ...]
    next_cursor: str
    has_more: bool
    catalog_hash: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "events", tuple(self.events))
        validate_cursor_token(self.next_cursor)
        if type(self.has_more) is not bool or not _SHA256.fullmatch(self.catalog_hash):
            raise ValueError("invalid pull page metadata")
        if len(self.events) > MAX_SYNC_RECORDS:
            raise ValueError("pull page exceeds record limit")
        if len(rfc8785.dumps(to_wire_json(self))) > MAX_DECODED_CANONICAL_PAGE_BYTES:
            raise ValueError("pull page exceeds canonical byte budget")


@dataclass(frozen=True, slots=True)
class PullPageEnvelope:
    cursor: Any
    catalog_hash: str
    space_id: str
    client_id: str
    generation: int

    def cursor_for(self, sequence: int) -> str:
        from app.sync.cursor import CursorPosition

        return self.cursor.encode(
            CursorPosition(sequence, self.catalog_hash, self.space_id, self.client_id, self.generation)
        )


@dataclass(frozen=True, slots=True)
class MappedSyncBatch:
    items: tuple[PreparedBatchItem, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "items", tuple(self.items))
        if tuple(item.request_index for item in self.items) != tuple(range(len(self.items))):
            raise ValueError("mapped items must preserve input order")


@dataclass(frozen=True, slots=True)
class SyncStatusResult:
    catalog_hash: str
    client_id: str | None
    registered: bool
    requires_recovery: bool | None
    recovery_action: Literal["full_recovery"] | None
    visible_event_count: int
    active_client_count: int
    recovery_client_count: int

    def __post_init__(self) -> None:
        if not _SHA256.fullmatch(self.catalog_hash):
            raise ValueError("invalid catalog hash")
        if self.client_id is not None:
            validate_client_id(self.client_id)
        for field in ("visible_event_count", "active_client_count", "recovery_client_count"):
            require_safe_nonnegative_int(getattr(self, field), field=field)


def parse_sync_event_batch(value: object, *, max_event_bytes: int = MAX_EVENT_PAYLOAD_BYTES,
                           max_batch_bytes: int = MAX_CANONICAL_BATCH_BYTES) -> tuple[SyncEventInput, ...]:
    if not isinstance(value, Mapping) or set(value) != {"events"} or not isinstance(value["events"], list):
        raise SyncInputError("invalid_sync_batch")
    raw_events = value["events"]
    if not 1 <= len(raw_events) <= MAX_SYNC_RECORDS:
        raise SyncInputError("invalid_sync_batch", {"reason": "record_count"})
    try:
        events = tuple(SyncEventInput.from_mapping(item) for item in raw_events)
    except SyncInputError:
        raise
    except (TypeError, ValueError) as exc:
        raise SyncInputError("invalid_event", {"reason": str(exc)}) from exc
    if len({event.operation_id for event in events}) != len(events):
        raise SyncInputError("idempotency_conflict")
    if any(len(canonical_sync_event_bytes(event)) > max_event_bytes for event in events):
        raise SyncInputError("event_payload_too_large")
    if len(canonical_sync_batch_bytes(events)) > max_batch_bytes:
        raise SyncInputError("sync_batch_too_large")
    return events


def validate_sync_push_inputs(
    client_id: str,
    batch_id: str,
    events: Sequence[SyncEventInput],
    *,
    max_event_bytes: int = MAX_EVENT_PAYLOAD_BYTES,
    max_batch_bytes: int = MAX_CANONICAL_BATCH_BYTES,
) -> tuple[str, str, tuple[SyncEventInput, ...]]:
    client_id = validate_client_id(client_id)
    batch_id = validate_batch_id(batch_id)
    parsed = tuple(events)
    if not 1 <= len(parsed) <= MAX_SYNC_RECORDS:
        raise ValueError("events must contain 1..500 records")
    if not all(isinstance(event, SyncEventInput) for event in parsed):
        raise TypeError("events must contain only SyncEventInput records")
    if len({event.operation_id for event in parsed}) != len(parsed):
        raise SyncInputError("idempotency_conflict")
    event_sizes = tuple(len(canonical_sync_event_bytes(event)) for event in parsed)
    if any(size > max_event_bytes for size in event_sizes):
        raise SyncInputError("event_payload_too_large")
    if len(canonical_sync_batch_bytes(parsed)) > max_batch_bytes:
        raise SyncInputError("sync_batch_too_large")
    return client_id, batch_id, parsed


def validate_operation_query_inputs(client_id: str, operation_ids: Sequence[str]) -> tuple[str, tuple[str, ...]]:
    client_id = validate_client_id(client_id)
    values = tuple(validate_sync_operation_id(value) for value in operation_ids)
    if not 1 <= len(values) <= MAX_SYNC_RECORDS:
        raise ValueError("operation_ids must contain 1..500 IDs")
    if len(set(values)) != len(values):
        raise SyncInputError("idempotency_conflict")
    return client_id, values


def canonical_contract_bytes(value: object) -> bytes:
    """Expose the one canonical serializer for protocol tests and adapters."""
    return canonical_json_bytes(value)


__all__ = [
    "AckResult",
    "MAX_DECODED_CANONICAL_PAGE_BYTES",
    "MAX_CANONICAL_BATCH_BYTES",
    "MAX_EVENT_PAYLOAD_BYTES",
    "MAX_JS_SAFE_INTEGER",
    "MAX_SYNC_RECORDS",
    "MappedSyncBatch",
    "OperationQueryItem",
    "OperationQueryResult",
    "PullPage",
    "PullPageEnvelope",
    "PushApplied",
    "PushConflict",
    "PushError",
    "PushResult",
    "SyncEventInput",
    "SyncEventRecord",
    "SyncInputError",
    "SyncLedgerIntegrityError",
    "SyncStatusResult",
    "canonical_contract_bytes",
    "canonical_sync_batch_bytes",
    "canonical_sync_event_bytes",
    "conflict_resolution_for_rejection",
    "decode_sync_i_json",
    "parse_sync_event_batch",
    "require_canonical_utc_rfc3339",
    "require_frozen_i_json_object",
    "require_safe_expected_version",
    "require_safe_nonnegative_int",
    "validate_batch_id",
    "validate_client_id",
    "validate_cursor_token",
    "validate_i_json_graph",
    "validate_operation_query_inputs",
    "validate_page_token",
    "validate_pull_limit",
    "validate_sync_operation_id",
    "validate_sync_push_inputs",
]
