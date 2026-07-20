"""Domain exceptions, canonical records, and FastAPI error adapters."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field, fields, is_dataclass
from types import MappingProxyType
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.logging import request_id_var
from app.schemas.common import (
    CanonicalErrorResponse,
    RequestValidationErrorResponse,
    RequestValidationIssue,
)

CANONICAL_ERROR_MEDIA_TYPE = "application/vnd.pomodoroxii.error+json;version=2"

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class MutationRejectionSpec:
    status_code: int
    message: str
    legacy_error_type: str
    retryable: bool


S3_MUTATION_REJECTION_CODES = frozenset(
    {
        "space_scope_mismatch",
        "version_conflict",
        "cycle_detected",
        "relation_endpoint_missing",
        "entity_id_mismatch",
        "delete_payload_not_empty",
        "not_found",
    }
)
RESERVED_TS_CODES = frozenset(
    {
        "space_scope_mismatch",
        "version_conflict",
        "idempotency_conflict",
        "invalid_payload_hash",
        "invalid_project_key",
        "project_key_conflict",
        "unsupported_content_version",
        "invalid_note_document",
        "invalid_work_item_tree",
        "not_found",
        "active_child_conflict",
        "active_session_exists",
        "stale_session_owner",
        "session_activation_conflict",
        "offline_formal_creation_forbidden",
        "command_result_unknown",
        "active_session_recovery_required",
        "work_item_structure_changed",
    }
)
RESERVED_S4_MAPPING_CODES = frozenset({"entity_not_sync_enabled"})


def _spec(status: int, message: str, legacy: str, retryable: bool = False) -> MutationRejectionSpec:
    return MutationRejectionSpec(status, message, legacy, retryable)


MUTATION_REJECTION_SPECS = MappingProxyType(
    {
        "space_scope_mismatch": _spec(
            403, "Mutation does not belong to the authorized Space", "authorization_error"
        ),
        "version_conflict": _spec(409, "Entity version conflict", "conflict"),
        "cycle_detected": _spec(409, "Mutation would create a cycle", "conflict"),
        "relation_endpoint_missing": _spec(409, "Relation endpoint does not exist", "conflict"),
        "entity_id_mismatch": _spec(
            422, "Entity identity does not match payload", "validation_error"
        ),
        "delete_payload_not_empty": _spec(422, "Delete payload must be empty", "validation_error"),
        "idempotency_conflict": _spec(
            409, "Operation ID is already bound to a different request", "conflict"
        ),
        "invalid_payload_hash": _spec(
            422, "Payload hash does not match canonical payload", "validation_error"
        ),
        "invalid_project_key": _spec(422, "Project key is invalid", "validation_error"),
        "project_key_conflict": _spec(409, "Project key conflict", "conflict"),
        "unsupported_content_version": _spec(
            422, "Content version is unsupported", "validation_error"
        ),
        "invalid_note_document": _spec(422, "Note document is invalid", "validation_error"),
        "invalid_work_item_tree": _spec(422, "Work item tree is invalid", "validation_error"),
        "not_found": _spec(404, "Entity not found", "not_found"),
        "active_child_conflict": _spec(409, "An active child prevents this mutation", "conflict"),
        "active_session_exists": _spec(409, "An active Session already exists", "conflict"),
        "stale_session_owner": _spec(409, "Session ownership is stale", "conflict"),
        "session_activation_conflict": _spec(409, "Session activation conflict", "conflict"),
        "offline_formal_creation_forbidden": _spec(
            409, "Formal offline creation is forbidden", "conflict"
        ),
        "command_result_unknown": _spec(
            503, "Command result requires recovery", "service_unavailable", True
        ),
        "active_session_recovery_required": _spec(
            503,
            "Active Session coordination requires recovery",
            "service_unavailable",
            True,
        ),
        "work_item_structure_changed": _spec(409, "Work item structure changed", "conflict"),
        "entity_not_sync_enabled": _spec(
            422, "Entity type is not sync-enabled", "validation_error"
        ),
    }
)

if set(MUTATION_REJECTION_SPECS) != (
    S3_MUTATION_REJECTION_CODES | RESERVED_TS_CODES | RESERVED_S4_MAPPING_CODES
):
    raise RuntimeError("mutation rejection map does not match closed code sets")


def deep_freeze_json(value: object) -> object:
    """Validate and recursively freeze one JSON-compatible value."""
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        return MappingProxyType({key: deep_freeze_json(item) for key, item in value.items()})
    if isinstance(value, (tuple, list)):
        return tuple(deep_freeze_json(item) for item in value)
    if isinstance(value, float) and not math.isfinite(value):
        raise TypeError("JSON numbers must be finite")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def thaw_json(value: object) -> JsonValue:
    """Return a detached JSON-native copy of one deeply frozen value."""
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        return {key: thaw_json(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [thaw_json(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise TypeError("JSON numbers must be finite")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def to_wire_json(value: object) -> JsonValue:
    """Serialize dataclasses and frozen JSON through the sole recursive owner."""
    if is_dataclass(value) and not isinstance(value, type):
        return {item.name: to_wire_json(getattr(value, item.name)) for item in fields(value)}
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        return {key: to_wire_json(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [to_wire_json(item) for item in value]
    return thaw_json(value)


@dataclass(frozen=True, slots=True)
class DomainErrorRecord:
    code: str
    message: str
    retryable: bool
    request_id: str
    details: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        frozen = deep_freeze_json(self.details)
        if not isinstance(frozen, Mapping):
            raise TypeError("error details must be a JSON object")
        object.__setattr__(self, "details", frozen)

    def to_wire_json(self) -> dict[str, JsonValue]:
        wire = to_wire_json(self)
        if not isinstance(wire, dict):
            raise TypeError("domain error did not serialize to an object")
        return wire


class AppError(Exception):
    """Base class for stable legacy and canonical application errors."""

    detail: str = "Application error"
    status_code: int = 500
    legacy_error_type: str = "app_error"
    code: str = "app_error"
    retryable: bool = False

    def __init__(
        self,
        detail: str | None = None,
        status_code: int | None = None,
        error_type: str | None = None,
        *,
        code: str | None = None,
        retryable: bool | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        if type(self) is AppError and code is not None:
            spec = MUTATION_REJECTION_SPECS.get(code)
            if spec is None:
                raise ValueError("unknown direct AppError code")
            else:
                overrides = (detail, status_code, error_type, retryable)
                expected = (
                    spec.message,
                    spec.status_code,
                    spec.legacy_error_type,
                    spec.retryable,
                )
                if any(
                    value is not None and value != expected[index]
                    for index, value in enumerate(overrides)
                ):
                    raise ValueError("closed mutation error override conflicts with spec")
                detail, status_code, error_type, retryable = expected
        self.detail = detail if detail is not None else type(self).detail
        self.status_code = status_code if status_code is not None else type(self).status_code
        self.legacy_error_type = (
            error_type if error_type is not None else type(self).legacy_error_type
        )
        self.code = code if code is not None else type(self).code
        self.retryable = retryable if retryable is not None else type(self).retryable
        frozen = deep_freeze_json(details or {})
        if not isinstance(frozen, Mapping):
            raise TypeError("error details must be a JSON object")
        self.details = frozen
        super().__init__(self.detail)

    @property
    def error_type(self) -> str:
        """Compatibility alias retained for existing v1 callers."""
        return self.legacy_error_type

    def to_domain_record(self, request_id: str) -> DomainErrorRecord:
        return DomainErrorRecord(
            code=self.code,
            message=self.detail,
            retryable=self.retryable,
            request_id=request_id,
            details=self.details,
        )


class MutationRejectedError(AppError):
    def __init__(self, rejection: Any) -> None:
        from app.mutation.types import MutationRejection

        if not isinstance(rejection, MutationRejection):
            raise TypeError("rejection must be a frozen MutationRejection")
        spec = MUTATION_REJECTION_SPECS[rejection.code]
        if rejection.retryable is not spec.retryable:
            raise ValueError("persisted retryable does not match rejection spec")
        self.rejection = rejection
        super().__init__(
            spec.message,
            spec.status_code,
            spec.legacy_error_type,
            code=rejection.code,
            retryable=rejection.retryable,
            details=rejection.details,
        )


class IdempotencyConflictError(AppError):
    detail = MUTATION_REJECTION_SPECS["idempotency_conflict"].message
    status_code = MUTATION_REJECTION_SPECS["idempotency_conflict"].status_code
    legacy_error_type = MUTATION_REJECTION_SPECS["idempotency_conflict"].legacy_error_type
    code = "idempotency_conflict"
    retryable = False

    def __init__(
        self,
        *,
        operation_id: str | None = None,
        existing_batch_id: str | None = None,
        requested_batch_id: str | None = None,
    ) -> None:
        details = {
            key: value
            for key, value in (
                ("operation_id", operation_id),
                ("existing_batch_id", existing_batch_id),
                ("requested_batch_id", requested_batch_id),
            )
            if value is not None
        }
        super().__init__(details=details)


class NotFoundError(AppError):
    detail = "Resource not found"
    status_code = 404
    legacy_error_type = "not_found"
    code = "not_found"


class ConflictError(AppError):
    detail = "Conflict with current state"
    status_code = 409
    legacy_error_type = "conflict"
    code = "conflict"


class ValidationError(AppError):
    detail = "Validation error"
    status_code = 422
    legacy_error_type = "validation_error"
    code = "validation_error"


class AuthenticationError(AppError):
    detail = "Authentication required"
    status_code = 401
    legacy_error_type = "authentication_error"
    code = "auth_required"


class AuthorizationError(AppError):
    detail = "Not authorized"
    status_code = 403
    legacy_error_type = "authorization_error"
    code = "forbidden"


class SpaceNotFoundError(AppError):
    detail = "Space is not registered"
    status_code = 404
    legacy_error_type = "not_found"
    code = "space_not_found"


class PathOutsideSpaceError(AppError):
    detail = "Registered storage path is outside the authorized Space"
    status_code = 403
    legacy_error_type = "authorization_error"
    code = "path_outside_space"


class SpaceStorageMissingError(AppError):
    detail = "Registered Space storage is missing or invalid"
    status_code = 503
    legacy_error_type = "conflict"
    code = "space_storage_missing"


class PlatformUnsupportedError(AppError):
    detail = "Native contained storage is supported only on Windows"
    status_code = 501
    legacy_error_type = "platform_unsupported"
    code = "platform_unsupported"
    retryable = False


class SpaceEnginePathMismatchError(AppError):
    detail = "Space storage identity does not match the cached engine"
    status_code = 409
    legacy_error_type = "conflict"
    code = "space_engine_path_mismatch"


class SQLiteAuthorityRevokedError(AppError):
    detail = "SQLite storage authority has been revoked"
    status_code = 409
    legacy_error_type = "conflict"
    code = "sqlite_authority_revoked"


class ExternalPathCapabilityRequiredError(AppError):
    detail = "External path capability is required for this operation"
    status_code = 403
    legacy_error_type = "authorization_error"
    code = "external_path_capability_required"


class SyncCursorExpiredError(AppError):
    detail = "Sync cursor expired; perform a full sync"
    status_code = 409
    legacy_error_type = "sync_cursor_expired"
    code = "cursor_expired"

    def __init__(self, *, floor: int, current_cursor: int) -> None:
        self.floor = floor
        self.current_cursor = current_cursor
        self.recovery_action = "full_sync"
        super().__init__(
            details={
                "floor": floor,
                "current_cursor": current_cursor,
                "recovery_action": self.recovery_action,
            }
        )


class CursorUpgradeRequiredError(AppError):
    detail = "Legacy sync cursor cannot safely advance"
    status_code = 409
    legacy_error_type = "conflict"
    code = "cursor_upgrade_required"
    retryable = False

    def __init__(self, *, truncated_groups: list[str]) -> None:
        super().__init__(
            details={"truncated_groups": sorted(set(truncated_groups))},
        )


class RetentionAckRequiredError(AppError):
    detail = "Client ACK waterline is required before retention"
    status_code = 409
    legacy_error_type = "conflict"
    code = "retention_ack_required"
    retryable = False


class SyncSnapshotExpiredError(AppError):
    detail = "Sync snapshot expired; restart full sync"
    status_code = 409
    legacy_error_type = "sync_snapshot_expired"
    code = "snapshot_expired"
    recovery_action = "restart_full_sync"

    def __init__(self) -> None:
        super().__init__(details={"recovery_action": self.recovery_action})


def _request_id(request: Request) -> str:
    return request_id_var.get() or request.headers.get("x-request-id", "")


def _canonical_requested(request: Request) -> bool:
    return CANONICAL_ERROR_MEDIA_TYPE in {
        item.strip() for item in request.headers.get("accept", "").split(",")
    }


def _canonical_headers(record: DomainErrorRecord) -> dict[str, str]:
    return {
        "X-PomodoroXII-Error-Code": record.code,
        "X-PomodoroXII-Retryable": str(record.retryable).lower(),
        "X-Request-ID": record.request_id,
    }


def _response(
    request: Request,
    *,
    status_code: int,
    record: DomainErrorRecord,
    legacy: dict[str, JsonValue],
) -> JSONResponse:
    canonical = _canonical_requested(request)
    return JSONResponse(
        status_code=status_code,
        content=record.to_wire_json() if canonical else legacy,
        headers=_canonical_headers(record),
        media_type=CANONICAL_ERROR_MEDIA_TYPE if canonical else "application/json",
    )


def _install_openapi_error_contract(app: FastAPI) -> None:
    original_openapi = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = original_openapi()
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        schemas["CanonicalErrorResponse"] = CanonicalErrorResponse.model_json_schema()
        canonical_ref = {"$ref": "#/components/schemas/CanonicalErrorResponse"}
        header_schema = {"schema": {"type": "string"}}
        for path in schema.get("paths", {}).values():
            for operation in path.values():
                if not isinstance(operation, dict):
                    continue
                for status, response in operation.get("responses", {}).items():
                    if not str(status).startswith(("4", "5")):
                        continue
                    content = response.setdefault("content", {})
                    content.setdefault(CANONICAL_ERROR_MEDIA_TYPE, {"schema": canonical_ref})
                    headers = response.setdefault("headers", {})
                    for name in (
                        "X-PomodoroXII-Error-Code",
                        "X-PomodoroXII-Retryable",
                        "X-Request-ID",
                    ):
                        headers.setdefault(name, header_schema)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi


def register_exception_handlers(app: FastAPI) -> None:
    """Register legacy-compatible and canonical error adapters."""

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        record = exc.to_domain_record(_request_id(request))
        legacy: dict[str, JsonValue] = {
            "detail": exc.detail,
            "error_type": exc.error_type,
        }
        if isinstance(exc, SyncCursorExpiredError):
            legacy.update(
                {
                    "floor": exc.floor,
                    "current_cursor": exc.current_cursor,
                    "recovery_action": exc.recovery_action,
                }
            )
        elif isinstance(exc, SyncSnapshotExpiredError):
            legacy["recovery_action"] = exc.recovery_action
        return _response(
            request,
            status_code=exc.status_code,
            record=record,
            legacy=legacy,
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_request_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        issues = [
            RequestValidationIssue(
                loc=list(error.get("loc", [])),
                msg=error.get("msg", ""),
                type=error.get("type", ""),
            ).model_dump(mode="json")
            for error in exc.errors()
        ]
        body = RequestValidationErrorResponse(
            detail="Request validation failed",
            error_type="request_validation_error",
            errors=[RequestValidationIssue(**issue) for issue in issues],
        )
        record = DomainErrorRecord(
            code="validation_error",
            message="Request validation failed",
            retryable=False,
            request_id=_request_id(request),
            details={"errors": issues},
        )
        return _response(
            request,
            status_code=422,
            record=record,
            legacy=body.model_dump(mode="json"),
        )

    @app.exception_handler(500)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logging = __import__("logging")
        logging.getLogger("pomodoroxi.errors").error(
            "Unhandled exception on %s %s (error_type=%s)",
            request.method,
            request.url.path,
            type(exc).__name__,
            exc_info=True,
        )
        record = DomainErrorRecord(
            code="server_error",
            message="Internal server error",
            retryable=False,
            request_id=_request_id(request),
            details={},
        )
        return _response(
            request,
            status_code=500,
            record=record,
            legacy={
                "detail": "Internal server error",
                "error_type": "server_error",
            },
        )

    _install_openapi_error_contract(app)
