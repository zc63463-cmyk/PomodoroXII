"""REST routes for sync (Phase C).

Endpoints:
- POST /api/v1/sync/push   — apply a batch of sync events.
- GET  /api/v1/sync/pull   — incremental pull since a cursor.
- GET  /api/v1/sync/full   — full sync (all tombstones regardless of since).
- GET  /api/v1/sync/status — per-entity counts + tombstone count.

Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_file_system, get_space_context, get_space_db
from app.file_system.interfaces import FileSystem
from app.schemas.sync import (
    SyncFullResponse,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
    SyncStatusResponse,
)
from app.services.sync import SyncService

router = APIRouter()


@router.post("/push", response_model=SyncPushResponse)
async def push_events(
    body: SyncPushRequest,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Apply a batch of sync events."""
    result = await SyncService(db, fs).push(
        [e.model_dump() for e in body.events]
    )
    await db.commit()
    return result


@router.get("/pull", response_model=SyncPullResponse)
async def pull_changes(
    since: str = Query("", description="ISO-8601 timestamp cursor"),
    since_id: str = Query("", description="Secondary cursor: last id within the same timestamp"),
    tombstone_since_id: str = Query("", description="Secondary cursor for tombstones: last entity_id within the same deleted_at"),
    limit: int = Query(1000, ge=1, le=5000),
    cursor: int | None = Query(None, ge=0, description="Global sync ledger cursor"),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Pull incremental changes since *since*."""
    result = await SyncService(db, fs).pull(
        since=since, since_id=since_id,
        tombstone_since_id=tombstone_since_id, limit=limit, cursor=cursor,
    )
    await db.commit()
    return result


@router.get("/full", response_model=SyncFullResponse)
async def full_sync(
    since: str = Query(""),
    since_id: str = Query("", description="Secondary cursor: last id within the same timestamp"),
    tombstone_since_id: str = Query("", description="Secondary cursor for tombstones: last entity_id within the same deleted_at"),
    limit: int = Query(1000, ge=1, le=5000),
    cursor: int | None = Query(None, ge=0, description="Global sync ledger cursor"),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full sync: returns ALL tombstones regardless of since."""
    result = await SyncService(db, fs).full(
        since=since, since_id=since_id,
        tombstone_since_id=tombstone_since_id, limit=limit, cursor=cursor,
    )
    await db.commit()
    return result


@router.get("/status", response_model=SyncStatusResponse)
async def sync_status(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return entity counts + tombstone count."""
    result = await SyncService(db).status()
    await db.commit()
    return result
