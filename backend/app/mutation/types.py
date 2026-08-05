"""Immutable records shared by mutation compilation, journaling, and recovery."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Literal

import rfc8785

from app.errors import deep_freeze_json, to_wire_json


class MutationState(StrEnum):
    INTENT = "INTENT"
    STAGED = "STAGED"
    DB_COMMITTED = "DB_COMMITTED"
    FINALIZING = "FINALIZING"
    FORWARD_APPLIED = "FORWARD_APPLIED"
    FINALIZED = "FINALIZED"
    ABORTED = "ABORTED"
    COMPENSATING = "COMPENSATING"
    COMPENSATED = "COMPENSATED"
    FAILED_MANUAL = "FAILED_MANUAL"


class StepState(StrEnum):
    PENDING = "PENDING"
    APPLIED = "APPLIED"
    COMPENSATED = "COMPENSATED"


MUTATION_STATES = tuple(state.value for state in MutationState)
STEP_STATES = tuple(state.value for state in StepState)
PAYLOAD_SHA256 = re.compile(r"[0-9a-f]{64}")
SYNC_UTC_RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z")
PRINTABLE_ASCII_OPERATION_ID = re.compile(r"[\x21-\x7e]{1,128}")


class InvalidPayloadHashError(ValueError):
    code = "invalid_payload_hash"


def require_frozen_object(value: object) -> Mapping[str, object]:
    frozen = deep_freeze_json(value)
    if not isinstance(frozen, Mapping):
        raise TypeError("value must be a JSON object")
    return frozen


def freeze_optional_object(
    value: Mapping[str, object] | None,
) -> Mapping[str, object] | None:
    return None if value is None else require_frozen_object(value)


def canonical_json_bytes(value: object) -> bytes:
    return rfc8785.dumps(to_wire_json(value))


def canonical_payload_hash(payload: Mapping[str, object]) -> str:
    return hashlib.sha256(canonical_json_bytes(require_frozen_object(payload))).hexdigest()


def require_payload_hash(declared: str, payload: Mapping[str, object]) -> None:
    if not isinstance(declared, str) or PAYLOAD_SHA256.fullmatch(declared) is None:
        raise InvalidPayloadHashError("payload hash must be 64 lowercase hex characters")
    if not hmac.compare_digest(declared, canonical_payload_hash(payload)):
        raise InvalidPayloadHashError("payload hash does not match canonical payload")


def validate_sha256(value: str, *, label: str) -> None:
    if not isinstance(value, str) or PAYLOAD_SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} must be 64 lowercase hex characters")


def validate_operation_id(value: str) -> None:
    """Require the cross-wave 1..128 byte printable ASCII ID contract."""
    if not isinstance(value, str) or PRINTABLE_ASCII_OPERATION_ID.fullmatch(value) is None:
        raise ValueError("operation and batch IDs must use the exact 1-128-byte printable-ASCII validator")


def bounded_child_operation_id(parent_id: str, suffix: str) -> str:
    """Derive one deterministic ASCII child ID without exceeding 128 bytes."""
    validate_operation_id(parent_id)
    if not suffix or not suffix.isascii() or len(suffix.encode("ascii")) > 512 or any(
        character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"
        for character in suffix
    ):
        raise ValueError("invalid child operation suffix")
    parent_bytes = parent_id.encode("ascii")
    suffix_bytes = suffix.encode("ascii")
    candidate = f"childp:{len(parent_bytes)}:{parent_id}:{suffix}"
    if len(candidate.encode("ascii")) <= 128:
        validate_operation_id(candidate)
        return candidate
    digest = hashlib.sha256(
        b"child-v1\0" + len(parent_bytes).to_bytes(2, "big") + parent_bytes + suffix_bytes
    ).hexdigest()
    bounded = f"childh:{digest}"
    validate_operation_id(bounded)
    return bounded


def validate_expected_version(value: int | None) -> None:
    if value is not None and (type(value) is not int or value < 0):
        raise ValueError("expected_version must be null or a nonnegative integer")


def validate_resolution(value: object) -> None:
    if value not in (None, "remote"):
        raise ValueError("resolution must be null or remote")


def require_typed_tuple(value: object, item_type: type, *, label: str) -> tuple:
    items = tuple(value)  # type: ignore[arg-type]
    if not all(isinstance(item, item_type) for item in items):
        raise TypeError(f"{label} must contain only {item_type.__name__} records")
    return items


def validate_projection_ordinals(projections: tuple[object, ...]) -> None:
    if tuple(item.ordinal for item in projections) != tuple(range(len(projections))):
        raise ValueError("projection ordinals must be unique, ordered, and contiguous")


def validate_canonical_timestamp(value: str | None) -> None:
    if value is None:
        return
    if not isinstance(value, str) or SYNC_UTC_RFC3339.fullmatch(value) is None:
        raise ValueError("timestamp must be strict UTC RFC 3339")
    datetime.fromisoformat(value[:-1] + "+00:00")


def canonical_request_bytes(
    name: str,
    entity_type: str,
    entity_id: str,
    payload: Mapping[str, object],
    expected_version: int | None,
    client_updated_at: str | None,
) -> bytes:
    return canonical_json_bytes(
        {
            "client_updated_at": client_updated_at,
            "entity_id": entity_id,
            "entity_type": entity_type,
            "expected_version": expected_version,
            "name": name,
            "payload": payload,
        }
    )


class ProjectionActionTag(StrEnum):
    MARKDOWN_WRITE = "markdown_write"
    PATH_RENAME = "path_rename"
    PATH_REMOVE = "path_remove"
    INDEX_REPLACE = "index_replace"
    FTS_REPLACE = "fts_replace"


class ContainedProjectionActionField(str):
    """One normalized logical projection location, never a stage location."""

    def __new__(cls, value: str):
        if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
            raise ValueError("projection action field must be a contained relative path")
        if ":" in value or value.startswith("/"):
            raise ValueError("projection action field must be a contained relative path")
        parts = value.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("projection action field must be a contained relative path")
        if (
            parts[0] == ".mutations"
            or parts[0] in {"before", "after"}
            or value == "manifest.json"
            or (len(parts) >= 3 and re.fullmatch(r"[0-9a-f]{64}", parts[0]) and parts[1] in {"before", "after"})
        ):
            raise ValueError("projection action field must not name staged content")
        return str.__new__(cls, value)


def _validate_projection_images(
    tag: ProjectionActionTag, source: ContainedProjectionActionField | None,
    before: bytes | None, after: bytes | None,
) -> None:
    if (tag is ProjectionActionTag.PATH_RENAME) != (source is not None):
        raise ValueError("projection source is required only for path rename")
    if tag is ProjectionActionTag.PATH_RENAME and (
        before is None or after is None or before != after
    ):
        raise ValueError("path rename requires equal before and after images")
    if tag is ProjectionActionTag.PATH_REMOVE and (before is None or after is not None):
        raise ValueError("path remove requires before and no after image")
    if tag is ProjectionActionTag.MARKDOWN_WRITE and after is None:
        raise ValueError("markdown write requires an after image")
    if tag in {ProjectionActionTag.INDEX_REPLACE, ProjectionActionTag.FTS_REPLACE} and before is None and after is None:
        raise ValueError("replace projection requires an image")


@dataclass(frozen=True, slots=True)
class ProjectionPlan:
    tag: ProjectionActionTag
    source: ContainedProjectionActionField | None
    target: ContainedProjectionActionField
    ordinal: int
    before: bytes | None
    after: bytes | None

    def __post_init__(self) -> None:
        if type(self.tag) is not ProjectionActionTag:
            raise TypeError("projection tag must be a closed ProjectionActionTag")
        if self.source is not None and type(self.source) is not ContainedProjectionActionField:
            raise TypeError("projection source must be contained")
        if type(self.target) is not ContainedProjectionActionField:
            raise TypeError("projection target must be contained")
        if type(self.ordinal) is not int or self.ordinal < 0:
            raise ValueError("projection ordinal must be nonnegative")
        for value in (self.before, self.after):
            if value is not None and not isinstance(value, bytes):
                raise TypeError("projection images must be bytes or null")
        _validate_projection_images(self.tag, self.source, self.before, self.after)


@dataclass(frozen=True, slots=True)
class PersistedProjectionDescriptor:
    tag: ProjectionActionTag
    source: ContainedProjectionActionField | None
    target: ContainedProjectionActionField
    ordinal: int
    before_sha256: str | None
    before_size: int | None
    after_sha256: str | None
    after_size: int | None

    def __post_init__(self) -> None:
        if type(self.tag) is not ProjectionActionTag:
            raise TypeError("projection tag must be a closed ProjectionActionTag")
        if self.source is not None and type(self.source) is not ContainedProjectionActionField:
            raise TypeError("projection source must be contained")
        if type(self.target) is not ContainedProjectionActionField:
            raise TypeError("projection target must be contained")
        if type(self.ordinal) is not int or self.ordinal < 0:
            raise ValueError("projection ordinal must be a nonnegative integer")
        for label, digest, size in (
            ("before", self.before_sha256, self.before_size),
            ("after", self.after_sha256, self.after_size),
        ):
            if (digest is None) != (size is None):
                raise ValueError(f"{label} hash and size must both be null or present")
            if digest is not None:
                validate_sha256(digest, label=f"{label}_sha256")
                if type(size) is not int or size < 0:
                    raise ValueError(f"{label}_size must be a nonnegative integer")
        _validate_projection_images(self.tag, self.source, self.before_sha256, self.after_sha256)


@dataclass(frozen=True, slots=True)
class MaterializedProjectionAction:
    tag: ProjectionActionTag
    source: ContainedProjectionActionField | None
    target: ContainedProjectionActionField
    ordinal: int
    blob: bytes | None

    def __post_init__(self) -> None:
        if type(self.tag) is not ProjectionActionTag:
            raise TypeError("projection tag must be a closed ProjectionActionTag")
        if self.source is not None and type(self.source) is not ContainedProjectionActionField:
            raise TypeError("projection source must be contained")
        if type(self.target) is not ContainedProjectionActionField:
            raise TypeError("projection target must be contained")
        if type(self.ordinal) is not int or self.ordinal < 0:
            raise ValueError("projection ordinal must be nonnegative")
        if self.blob is not None and not isinstance(self.blob, bytes):
            raise TypeError("materialized projection blob must be bytes or null")
        if (self.tag is ProjectionActionTag.PATH_RENAME) != (self.source is not None):
            raise ValueError("projection source is required only for path rename")


@dataclass(frozen=True, slots=True)
class DbMutationPlan:
    table: str
    primary_key: Mapping[str, object]
    operation: Literal["insert", "update", "delete"]
    expected_version: int | None
    before_row: Mapping[str, object] | None
    after_row: Mapping[str, object] | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "primary_key", require_frozen_object(self.primary_key))
        object.__setattr__(self, "before_row", freeze_optional_object(self.before_row))
        object.__setattr__(self, "after_row", freeze_optional_object(self.after_row))
        validate_expected_version(self.expected_version)
        if self.operation not in ("insert", "update", "delete"):
            raise ValueError("unsupported database mutation operation")


@dataclass(frozen=True, slots=True)
class SyncEventPlan:
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, object]
    version: int
    created_at: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", require_frozen_object(self.payload))
        if type(self.version) is not int or self.version < 0:
            raise ValueError("SyncEventPlan.version must be a nonnegative integer")
        validate_canonical_timestamp(self.created_at)
        if self.action not in ("create", "update", "delete"):
            raise ValueError("unsupported sync event action")
        if self.created_at is None:
            raise ValueError("SyncEventPlan.created_at is required")


@dataclass(frozen=True, slots=True)
class MutationRequest:
    name: str
    entity_type: str
    entity_id: str
    payload: Mapping[str, object]
    expected_version: int | None
    client_updated_at: str | None
    request_hash: str

    def __post_init__(self) -> None:
        frozen = require_frozen_object(self.payload)
        object.__setattr__(self, "payload", frozen)
        validate_expected_version(self.expected_version)
        validate_canonical_timestamp(self.client_updated_at)
        actual = hashlib.sha256(
            canonical_request_bytes(
                self.name,
                self.entity_type,
                self.entity_id,
                frozen,
                self.expected_version,
                self.client_updated_at,
            )
        ).hexdigest()
        if not hmac.compare_digest(self.request_hash, actual):
            raise ValueError("request_hash does not match frozen request")

    @classmethod
    def from_payload(
        cls,
        *,
        name: str,
        entity_type: str,
        entity_id: str,
        payload: Mapping[str, object],
        expected_version: int | None,
        client_updated_at: str | None = None,
    ) -> MutationRequest:
        frozen = require_frozen_object(payload)
        request_hash = hashlib.sha256(
            canonical_request_bytes(
                name,
                entity_type,
                entity_id,
                frozen,
                expected_version,
                client_updated_at,
            )
        ).hexdigest()
        return cls(
            name,
            entity_type,
            entity_id,
            frozen,
            expected_version,
            client_updated_at,
            request_hash,
        )


def _descriptor(image: bytes | None) -> tuple[str | None, int | None]:
    if image is None:
        return None, None
    return hashlib.sha256(image).hexdigest(), len(image)


def _persisted_descriptors(
    projections: tuple[ProjectionPlan, ...],
) -> tuple[PersistedProjectionDescriptor, ...]:
    return tuple(
        PersistedProjectionDescriptor(
            plan.tag,
            plan.source,
            plan.target,
            plan.ordinal,
            *_descriptor(plan.before),
            *_descriptor(plan.after),
        )
        for plan in projections
    )


def _persisted_command_payload(
    request: MutationRequest,
    db_plans: tuple[DbMutationPlan, ...],
    projections: tuple[PersistedProjectionDescriptor, ...],
    sync_events: tuple[SyncEventPlan, ...],
    result_value: Mapping[str, object],
    resolution: Literal["remote"] | None,
) -> Mapping[str, object]:
    return require_frozen_object(
        {
            "db_plans": to_wire_json(db_plans),
            "projections": to_wire_json(projections),
            "request": to_wire_json(request),
            "resolution": resolution,
            "result_value": to_wire_json(result_value),
            "sync_events": to_wire_json(sync_events),
        }
    )


def calculate_persisted_command_hash(
    request: MutationRequest,
    db_plans: tuple[DbMutationPlan, ...],
    projections: tuple[PersistedProjectionDescriptor, ...],
    sync_events: tuple[SyncEventPlan, ...],
    result_value: Mapping[str, object],
    resolution: Literal["remote"] | None,
) -> str:
    return hashlib.sha256(
        canonical_json_bytes(
            _persisted_command_payload(
                request,
                db_plans,
                projections,
                sync_events,
                result_value,
                resolution,
            )
        )
    ).hexdigest()


@dataclass(frozen=True, slots=True)
class MutationCommand:
    request: MutationRequest
    db_plans: tuple[DbMutationPlan, ...]
    projections: tuple[ProjectionPlan, ...]
    sync_events: tuple[SyncEventPlan, ...]
    result_value: Mapping[str, object]
    resolution: Literal["remote"] | None
    command_hash: str

    def __post_init__(self) -> None:
        if not isinstance(self.request, MutationRequest):
            raise TypeError("request must be a MutationRequest")
        object.__setattr__(
            self, "db_plans", require_typed_tuple(self.db_plans, DbMutationPlan, label="db_plans")
        )
        object.__setattr__(
            self,
            "projections",
            require_typed_tuple(self.projections, ProjectionPlan, label="projections"),
        )
        validate_projection_ordinals(self.projections)
        object.__setattr__(
            self,
            "sync_events",
            require_typed_tuple(self.sync_events, SyncEventPlan, label="sync_events"),
        )
        object.__setattr__(self, "result_value", require_frozen_object(self.result_value))
        validate_resolution(self.resolution)
        expected = calculate_persisted_command_hash(
            self.request,
            self.db_plans,
            _persisted_descriptors(self.projections),
            self.sync_events,
            self.result_value,
            self.resolution,
        )
        if not hmac.compare_digest(self.command_hash, expected):
            raise ValueError("command_hash does not match persisted command")

    @classmethod
    def from_effects(
        cls,
        *,
        request: MutationRequest,
        db_plans: tuple[DbMutationPlan, ...],
        projections: tuple[ProjectionPlan, ...],
        sync_events: tuple[SyncEventPlan, ...],
        result_value: Mapping[str, object],
        resolution: Literal["remote"] | None = None,
    ) -> MutationCommand:
        frozen_result = require_frozen_object(result_value)
        command_hash = calculate_persisted_command_hash(
            request,
            tuple(db_plans),
            _persisted_descriptors(tuple(projections)),
            tuple(sync_events),
            frozen_result,
            resolution,
        )
        return cls(
            request,
            tuple(db_plans),
            tuple(projections),
            tuple(sync_events),
            frozen_result,
            resolution,
            command_hash,
        )

    def persisted(self) -> PersistedMutationCommand:
        projections = _persisted_descriptors(self.projections)
        return PersistedMutationCommand(
            self.request,
            self.db_plans,
            projections,
            self.sync_events,
            self.result_value,
            self.resolution,
            self.command_hash,
        )


@dataclass(frozen=True, slots=True)
class PersistedMutationCommand:
    request: MutationRequest
    db_plans: tuple[DbMutationPlan, ...]
    projections: tuple[PersistedProjectionDescriptor, ...]
    sync_events: tuple[SyncEventPlan, ...]
    result_value: Mapping[str, object]
    resolution: Literal["remote"] | None
    command_hash: str

    def __post_init__(self) -> None:
        if not isinstance(self.request, MutationRequest):
            raise TypeError("request must be a MutationRequest")
        object.__setattr__(
            self, "db_plans", require_typed_tuple(self.db_plans, DbMutationPlan, label="db_plans")
        )
        object.__setattr__(
            self,
            "projections",
            require_typed_tuple(
                self.projections,
                PersistedProjectionDescriptor,
                label="projections",
            ),
        )
        validate_projection_ordinals(self.projections)
        object.__setattr__(
            self,
            "sync_events",
            require_typed_tuple(self.sync_events, SyncEventPlan, label="sync_events"),
        )
        object.__setattr__(self, "result_value", require_frozen_object(self.result_value))
        validate_resolution(self.resolution)
        expected = calculate_persisted_command_hash(
            self.request,
            self.db_plans,
            self.projections,
            self.sync_events,
            self.result_value,
            self.resolution,
        )
        if not hmac.compare_digest(self.command_hash, expected):
            raise ValueError("command_hash does not match persisted command")


def persisted_command_bytes(command: PersistedMutationCommand) -> bytes:
    return canonical_json_bytes(command)


def decode_persisted_command(payload: bytes | str) -> PersistedMutationCommand:
    encoded = payload.encode("utf-8") if isinstance(payload, str) else payload
    try:
        value = json.loads(encoded)
        request = MutationRequest(**value["request"])
        command = PersistedMutationCommand(
            request=request,
            db_plans=tuple(DbMutationPlan(**item) for item in value["db_plans"]),
            projections=tuple(
                PersistedProjectionDescriptor(
                    ProjectionActionTag(item["tag"]),
                    None
                    if item["source"] is None
                    else ContainedProjectionActionField(item["source"]),
                    ContainedProjectionActionField(item["target"]),
                    item["ordinal"],
                    item["before_sha256"],
                    item["before_size"],
                    item["after_sha256"],
                    item["after_size"],
                )
                for item in value["projections"]
            ),
            sync_events=tuple(SyncEventPlan(**item) for item in value["sync_events"]),
            result_value=value["result_value"],
            resolution=value["resolution"],
            command_hash=value["command_hash"],
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("invalid persisted mutation command") from exc
    if not hmac.compare_digest(encoded, persisted_command_bytes(command)):
        raise ValueError("persisted command bytes are not canonical")
    return command


@dataclass(frozen=True, slots=True)
class MutationResult:
    operation_id: str
    batch_id: str
    entity_type: str
    entity_id: str
    version: int | None
    resolution: Literal["remote"] | None
    state: MutationState
    value: Mapping[str, object]

    def __post_init__(self) -> None:
        object.__setattr__(self, "value", require_frozen_object(self.value))
        validate_expected_version(self.version)
        validate_resolution(self.resolution)
        try:
            object.__setattr__(self, "state", MutationState(self.state))
        except ValueError as exc:
            raise ValueError("unsupported mutation result state") from exc


def _validate_rejection(code: str, retryable: bool) -> None:
    from app.errors import MUTATION_REJECTION_SPECS

    try:
        expected = MUTATION_REJECTION_SPECS[code].retryable
    except KeyError as exc:
        raise ValueError(f"unknown mutation rejection code: {code}") from exc
    if type(retryable) is not bool or retryable is not expected:
        raise ValueError("persisted retryable does not match rejection spec")


@dataclass(frozen=True, slots=True)
class MutationRejection:
    request_index: int
    operation_id: str
    entity_type: str
    entity_id: str
    code: str
    retryable: bool
    details: Mapping[str, object]

    def __post_init__(self) -> None:
        if type(self.request_index) is not int or self.request_index < 0:
            raise ValueError("request_index must be a nonnegative integer")
        object.__setattr__(self, "details", require_frozen_object(self.details))
        _validate_rejection(self.code, self.retryable)


@dataclass(frozen=True, slots=True)
class PreparedBatchItem:
    request_index: int
    operation_id: str
    intent_hash: str
    request: MutationRequest | None
    pre_rejection: MutationRejection | None

    def __post_init__(self) -> None:
        if type(self.request_index) is not int or self.request_index < 0:
            raise ValueError("request_index must be a nonnegative integer")
        validate_sha256(self.intent_hash, label="intent_hash")
        if (self.request is None) == (self.pre_rejection is None):
            raise ValueError("prepared item requires exactly one outcome")
        if self.request is not None and not isinstance(self.request, MutationRequest):
            raise TypeError("request must be a MutationRequest")
        if self.pre_rejection is not None and not isinstance(self.pre_rejection, MutationRejection):
            raise TypeError("pre_rejection must be a MutationRejection")
        if self.pre_rejection is not None and (
            self.pre_rejection.request_index != self.request_index
            or self.pre_rejection.operation_id != self.operation_id
        ):
            raise ValueError("prepared rejection identity mismatch")


@dataclass(frozen=True, slots=True)
class BatchMutationResult:
    batch_id: str
    applied: tuple[MutationResult, ...]
    rejected: tuple[MutationRejection, ...]
    operation_id_derivations: Mapping[str, object] = field(default_factory=dict)
    input_count: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "applied",
            require_typed_tuple(self.applied, MutationResult, label="applied"),
        )
        object.__setattr__(
            self,
            "rejected",
            require_typed_tuple(self.rejected, MutationRejection, label="rejected"),
        )
        expected_input_count = len(self.applied) + len(self.rejected)
        if self.input_count is None:
            object.__setattr__(self, "input_count", expected_input_count)
        elif type(self.input_count) is not int or self.input_count != expected_input_count:
            raise ValueError("batch result input_count does not cover every input item")
        result_ids = {
            *(item.operation_id for item in self.applied),
            *(item.operation_id for item in self.rejected),
        }
        if not isinstance(self.operation_id_derivations, Mapping):
            raise TypeError("operation ID derivations must be a mapping")
        for operation_id, derivation in self.operation_id_derivations.items():
            if (
                operation_id not in result_ids
                or not isinstance(derivation, Mapping)
                or set(derivation) != {"parent_id", "suffix"}
                or not isinstance(derivation["parent_id"], str)
                or not isinstance(derivation["suffix"], str)
                or bounded_child_operation_id(
                    derivation["parent_id"], derivation["suffix"]
                )
                != operation_id
            ):
                raise ValueError("operation ID derivation is invalid")
        object.__setattr__(
            self,
            "operation_id_derivations",
            require_frozen_object(self.operation_id_derivations),
        )


class MutationRuleViolation(RuntimeError):
    __slots__ = ("_code", "_details", "_retryable")

    def __init__(
        self,
        code: str,
        details: Mapping[str, object],
        *,
        retryable: bool = False,
    ) -> None:
        object.__setattr__(self, "_code", code)
        object.__setattr__(self, "_retryable", retryable)
        object.__setattr__(self, "_details", require_frozen_object(details))
        _validate_rejection(code, retryable)
        super().__init__(code)

    def __setattr__(self, name: str, value: object) -> None:
        if name in {"_code", "_retryable", "_details", "code", "retryable", "details"}:
            raise AttributeError("MutationRuleViolation is immutable")
        super().__setattr__(name, value)

    @property
    def code(self) -> str:
        return self._code

    @property
    def retryable(self) -> bool:
        return self._retryable

    @property
    def details(self) -> Mapping[str, object]:
        return self._details


@dataclass(frozen=True, slots=True)
class RecoveryResult:
    finalized: tuple[str, ...]
    aborted: tuple[str, ...]
    compensated: tuple[str, ...]
    failed_manual: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RecoveryInspection:
    pending_batches: tuple[str, ...]
    failed_manual: tuple[str, ...]
    orphan_stages: tuple[str, ...]
    clean: bool
    reasons: tuple[str, ...]
