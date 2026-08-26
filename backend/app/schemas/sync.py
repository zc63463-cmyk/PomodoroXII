"""Strict public schemas for the Sync v2 protocol."""

from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Annotated, Any, Literal, Self

import rfc8785
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    model_validator,
)

from app.sync.contracts import (
    MAX_DECODED_CANONICAL_PAGE_BYTES,
    MAX_JS_SAFE_INTEGER,
    MAX_RECOVERY_BASE64_CHARS,
    MAX_SYNC_RECORDS,
    SYNC_UTC_RFC3339_PATTERN,
    require_canonical_utc_rfc3339,
    validate_i_json_graph,
)


def require_i_json_object_graph(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("value must be an object")
    validate_i_json_graph(value)
    return value


def validate_canonical_recovery_base64(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("recovery payload must be text")
    try:
        encoded = value.encode("ascii")
        decoded = base64.b64decode(encoded, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError("recovery payload must be canonical base64") from exc
    if len(encoded) > MAX_RECOVERY_BASE64_CHARS:
        raise ValueError("recovery payload exceeds encoded byte budget")
    if len(decoded) > MAX_DECODED_CANONICAL_PAGE_BYTES:
        raise ValueError("recovery payload exceeds decoded byte budget")
    if base64.b64encode(decoded) != encoded:
        raise ValueError("recovery payload has an alternate base64 spelling")
    return value


SafeNonnegativeInt = Annotated[
    StrictInt,
    Field(ge=0, le=MAX_JS_SAFE_INTEGER),
]
CanonicalUtcTimestamp = Annotated[
    str,
    Field(
        min_length=20,
        max_length=30,
        pattern=SYNC_UTC_RFC3339_PATTERN.pattern,
    ),
    AfterValidator(require_canonical_utc_rfc3339),
]
CanonicalRecoveryBase64 = Annotated[
    str,
    Field(max_length=MAX_RECOVERY_BASE64_CHARS),
    AfterValidator(validate_canonical_recovery_base64),
]
IJsonObject = Annotated[
    dict[str, Any],
    AfterValidator(require_i_json_object_graph),
]

_ID_64 = r"^[A-Za-z0-9._:-]{1,64}$"
_ID_128 = r"^[A-Za-z0-9._:-]{1,128}$"
_TOKEN = r"^[A-Za-z0-9._~-]{16,2048}$"
_SHA256 = r"^[0-9a-f]{64}$"


class SyncV2Event(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_type: str = Field(pattern=_ID_64)
    entity_id: str = Field(pattern=_ID_64)
    action: Literal["create", "update", "delete"]
    payload: IJsonObject
    expected_version: SafeNonnegativeInt | None
    client_updated_at: CanonicalUtcTimestamp
    operation_id: str = Field(pattern=_ID_128)

    @model_validator(mode="after")
    def validate_action_version(self) -> Self:
        if self.action == "create" and self.expected_version is not None:
            raise ValueError("create expected_version must be null")
        if self.action != "create" and self.expected_version is None:
            raise ValueError("update/delete expected_version is required")
        return self


class SyncV2PushRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(pattern=_ID_64)
    batch_id: str = Field(pattern=_ID_128)
    events: list[SyncV2Event] = Field(min_length=1, max_length=MAX_SYNC_RECORDS)


class SyncV2EventRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str = Field(pattern=_ID_128)
    batch_id: str = Field(pattern=_ID_128)
    entity_type: str = Field(pattern=_ID_64)
    entity_id: str = Field(pattern=_ID_64)
    action: Literal["create", "update", "delete"]
    payload: IJsonObject
    version: SafeNonnegativeInt
    created_at: CanonicalUtcTimestamp


class SyncV2PushApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str
    entity_type: str
    entity_id: str
    version: SafeNonnegativeInt
    resolution: Literal["remote"] | None


class SyncV2PushConflict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str
    entity_type: str
    entity_id: str
    code: Literal["version_conflict", "tombstone_conflict", "cycle_detected"]
    resolution: Literal["local", "tombstone", "circular_ref", "manual"]
    details: IJsonObject
    # QN-S8b: authoritative remote post-image carried by snapshot-aware
    # version_conflict rejections; absent for legacy/tombstone/cycle conflicts.
    snapshot: IJsonObject | None = None
    version: SafeNonnegativeInt | None = None


class SyncV2PushError(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str
    entity_type: str
    entity_id: str
    code: str
    retryable: bool
    details: IJsonObject


class SyncV2PushResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    batch_id: str
    applied: list[SyncV2PushApplied] = Field(max_length=MAX_SYNC_RECORDS)
    conflicts: list[SyncV2PushConflict] = Field(max_length=MAX_SYNC_RECORDS)
    errors: list[SyncV2PushError] = Field(max_length=MAX_SYNC_RECORDS)

    @model_validator(mode="after")
    def validate_unique_outcomes(self) -> Self:
        operation_ids = [
            *(item.operation_id for item in self.applied),
            *(item.operation_id for item in self.conflicts),
            *(item.operation_id for item in self.errors),
        ]
        if len(operation_ids) != len(set(operation_ids)):
            raise ValueError("one push event may have exactly one result")
        return self


class SyncV2PullResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    events: list[SyncV2EventRecord] = Field(max_length=MAX_SYNC_RECORDS)
    next_cursor: str = Field(min_length=1, max_length=2048)
    has_more: bool
    catalog_hash: str = Field(pattern=_SHA256)

    @model_validator(mode="after")
    def validate_page_budget(self) -> Self:
        if len(rfc8785.dumps(self.model_dump(mode="json"))) > MAX_DECODED_CANONICAL_PAGE_BYTES:
            raise ValueError("pull page exceeds canonical byte budget")
        return self


class SyncV2AckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(pattern=_ID_64)
    cursor: str = Field(pattern=_TOKEN)


class SyncV2AckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    client_id: str
    accepted: Literal[True]
    requires_recovery: bool
    catalog_hash: str = Field(pattern=_SHA256)


class SyncV2StatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    catalog_hash: str = Field(pattern=_SHA256)
    client_id: str | None
    registered: bool
    requires_recovery: bool | None
    recovery_action: Literal["full_recovery"] | None
    visible_event_count: SafeNonnegativeInt
    active_client_count: SafeNonnegativeInt
    recovery_client_count: SafeNonnegativeInt


class SyncV2OperationQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    client_id: str = Field(pattern=_ID_64)
    operation_ids: list[str] = Field(min_length=1, max_length=MAX_SYNC_RECORDS)


class SyncV2OperationQueryItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str
    state: Literal["unknown", "pending", "terminal", "recovery_required"]
    batch_id: str | None
    result: SyncV2PushResponse | None

    @model_validator(mode="after")
    def validate_binding(self) -> Self:
        if self.state == "unknown":
            if self.batch_id is not None or self.result is not None:
                raise ValueError("unknown operation cannot expose a binding")
            return self
        if self.batch_id is None:
            raise ValueError("known operation requires its original batch ID")
        if self.state == "terminal":
            if self.result is None or self.result.batch_id != self.batch_id:
                raise ValueError("terminal operation requires its original batch result")
        elif self.result is not None:
            raise ValueError("nonterminal operation cannot expose a result")
        return self


class SyncV2OperationQueryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    items: list[SyncV2OperationQueryItem] = Field(min_length=1, max_length=MAX_SYNC_RECORDS)


class SyncV2RecoveryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    payload_jsonl_base64: CanonicalRecoveryBase64
    entity_count: SafeNonnegativeInt = Field(le=MAX_SYNC_RECORDS)
    chunk_sha256: str = Field(pattern=_SHA256)
    next_page_token: Annotated[str, Field(min_length=16, max_length=2048)] | None
    has_more: bool
    catalog_hash: str = Field(pattern=_SHA256)
    waterline_cursor: str = Field(min_length=16, max_length=2048)

    @model_validator(mode="after")
    def validate_recovery_metadata(self) -> Self:
        decoded = base64.b64decode(self.payload_jsonl_base64, validate=True)
        if hashlib.sha256(decoded).hexdigest() != self.chunk_sha256:
            raise ValueError("recovery payload hash does not match chunk_sha256")
        if decoded.count(b"\n") != self.entity_count:
            raise ValueError("recovery entity count does not match payload")
        if self.has_more != (self.next_page_token is not None):
            raise ValueError("recovery continuation metadata is inconsistent")
        return self


__all__ = [name for name in globals() if name.startswith("SyncV2")]
