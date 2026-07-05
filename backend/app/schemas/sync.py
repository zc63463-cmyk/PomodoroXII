"""Pydantic schemas for the sync API (Phase C)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class SyncEvent(BaseModel):
    """A single sync event pushed by a client."""

    entity_type: str = Field(..., max_length=50)
    entity_id: str = Field(..., max_length=36)
    action: str = Field(..., pattern="^(create|update|delete)$")
    payload: dict[str, Any] = Field(default_factory=dict)
    client_updated_at: str = Field(default="")


class SyncPushRequest(BaseModel):
    """Request body for POST /api/v1/sync/push."""

    events: list[SyncEvent]


class SyncAppliedItem(BaseModel):
    """An event that was successfully applied."""

    entity_type: str
    entity_id: str
    action: str
    # P1-1: present (="remote") when LWW resolved to the remote version;
    # absent for clean "ok" applications. conflict_remote no longer appears
    # in ``conflicts`` because it represents a successful application.
    resolution: str | None = None


class SyncConflictItem(BaseModel):
    """A conflict that was resolved by LWW (remote event REJECTED)."""

    entity_type: str
    entity_id: str
    resolution: str  # "local" | "tombstone" | "circular_ref"


class SyncErrorItem(BaseModel):
    """An event that failed to apply."""

    entity_type: str
    entity_id: str
    error: str


class SyncPushResponse(BaseModel):
    """Response body for POST /api/v1/sync/push."""

    applied: list[SyncAppliedItem]
    conflicts: list[SyncConflictItem]
    errors: list[SyncErrorItem]
    server_time: str


class SyncPullResponse(BaseModel):
    """Response body for GET /api/v1/sync/pull.

    Allows extra fields so the 14 entity groups keyed by pull_key
    (tasks, sessions, notes, ...) pass through Pydantic validation.
    """

    model_config = ConfigDict(extra="allow")

    server_time: str
    has_more: bool = False
    # D-5: tombstones pagination flag — True when tombstones were truncated
    # to *limit*. The top-level has_more is also surfaced True in that case.
    tombstones_has_more: bool = False
    next_since: str = ""
    # Composite cursor secondary key: max id among rows sharing next_since.
    # Empty when no rows share the latest timestamp.
    next_since_id: str = ""
    # Composite cursor for tombstones: max entity_id among tombstones sharing
    # next_since. Empty when no tombstones share the latest timestamp.
    next_tombstone_since_id: str = ""
    tombstones: list[dict[str, Any]] = Field(default_factory=list)


class SyncFullResponse(SyncPullResponse):
    """Response body for GET /api/v1/sync/full."""

    is_full: bool = True


class SyncStatusResponse(BaseModel):
    """Response body for GET /api/v1/sync/status."""

    server_time: str
    entity_counts: dict[str, int]
    tombstone_count: int
