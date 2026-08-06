"""Frozen transport operation catalog shared by REST and MCP adapters."""

from dataclasses import dataclass
from typing import Literal

from app.errors import AppError, IdempotencyConflictError
from app.sync.contracts import SyncInputError


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
class SyncOperationSpec:
    name: str
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
    "SyncOperationSpec",
    "SyncTransportInputError",
    "sync_input_app_error",
]
