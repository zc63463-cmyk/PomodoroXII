"""REST routes for sync (Phase C).

Endpoints:
- POST /api/v1/sync/push   — apply a batch of sync events.
- GET  /api/v1/sync/pull   — incremental pull since a cursor.
- GET  /api/v1/sync/full   — full sync (all tombstones regardless of since).
- GET  /api/v1/sync/status — per-entity counts + tombstone count.

Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.deps import get_file_system, get_space_context, get_space_db
from app.errors import SyncSnapshotExpiredError
from app.file_system.interfaces import FileSystem
from app.models.sync_state import SyncSnapshot, SyncSnapshotChunk
from app.schemas.common import ErrorResponse
from app.schemas.sync import (
    SyncAckRequest,
    SyncAckResponse,
    SyncClientListResponse,
    SyncClientRegistrationRequest,
    SyncClientRegistrationResponse,
    SyncClientRevokeResponse,
    SyncFullResponse,
    SyncLedgerStatsResponse,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
    SyncStatusResponse,
)
from app.services.sync import SyncService
from app.services.sync_clients import SyncClientService
from app.services.sync_outbox import get_ledger_stats

router = APIRouter()


@router.get("/clients", response_model=SyncClientListResponse)
async def list_sync_clients(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    return {"clients": await SyncClientService(db).list_clients(user_id=ctx["user_id"])}


@router.delete(
    "/clients/{client_id}",
    response_model=SyncClientRevokeResponse,
    responses={
        401: {"model": ErrorResponse, "description": "Authentication required"},
        403: {"model": ErrorResponse, "description": "Space access denied"},
        404: {"model": ErrorResponse, "description": "Sync client not found"},
    },
)
async def revoke_sync_client(
    client_id: str = Path(..., min_length=36, max_length=36),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    result = await SyncClientService(db).revoke(
        client_id=client_id,
        user_id=ctx["user_id"],
    )
    await db.commit()
    return result


@router.post("/clients", response_model=SyncClientRegistrationResponse)
async def register_sync_client(
    body: SyncClientRegistrationRequest,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    result = await SyncClientService(db).register(
        client_id=body.client_id,
        user_id=ctx["user_id"],
        display_name=body.display_name,
    )
    await db.commit()
    return result


@router.post("/ack", response_model=SyncAckResponse)
async def acknowledge_sync_cursor(
    body: SyncAckRequest,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    result = await SyncClientService(db).acknowledge(
        client_id=body.client_id,
        user_id=ctx["user_id"],
        space_id=ctx["space_id"],
        ack_cursor=body.ack_cursor,
        cursor_version=body.cursor_version,
        recovery_proof=body.recovery_proof,
    )
    await db.commit()
    return result


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
    snapshot_token: str | None = Query(None, min_length=1, max_length=36),
    snapshot_offset: int = Query(0, ge=0),
    client_id: str | None = Query(None, min_length=36, max_length=36),
    recovery_continuation: str | None = Query(None, min_length=1, max_length=2048),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full sync: returns ALL tombstones regardless of since."""
    recovery_client = None
    if client_id is not None:
        recovery_client = await SyncClientService(db).validate_snapshot_client(
            client_id=client_id,
            user_id=ctx["user_id"],
        )
    try:
        result = await SyncService(db, fs).full(
            since=since, since_id=since_id,
            tombstone_since_id=tombstone_since_id, limit=limit, cursor=cursor,
            snapshot_token=snapshot_token, snapshot_offset=snapshot_offset,
        )
    except SyncSnapshotExpiredError as exc:
        if exc.expired_snapshot_token is not None:
            cleanup_factory = async_sessionmaker(
                bind=db.bind,
                expire_on_commit=False,
                autoflush=False,
            )
            async with cleanup_factory() as cleanup_db:
                async with cleanup_db.begin():
                    await cleanup_db.execute(
                        delete(SyncSnapshotChunk).where(
                            SyncSnapshotChunk.snapshot_token == exc.expired_snapshot_token
                        )
                    )
                    await cleanup_db.execute(
                        delete(SyncSnapshot).where(
                            SyncSnapshot.token == exc.expired_snapshot_token
                        )
                    )
        raise
    if (
        client_id is not None
        and result.get("cursor_version") == 2
        and result.get("is_full") is True
        and result.get("snapshot_token")
    ):
        from app.services.sync_recovery import (
            issue_recovery_continuation,
            issue_recovery_proof,
            verify_recovery_continuation,
        )

        assert recovery_client is not None
        snapshot = await db.get(SyncSnapshot, result["snapshot_token"])
        if snapshot is None or snapshot.status != "ready":
            raise SyncSnapshotExpiredError()
        canonical_client_id = recovery_client.client_id
        if snapshot_offset > 0:
            if recovery_continuation is None:
                raise SyncSnapshotExpiredError()
            verify_recovery_continuation(
                recovery_continuation,
                space_id=ctx["space_id"],
                user_id=ctx["user_id"],
                client_id=canonical_client_id,
                snapshot_token=snapshot.token,
                snapshot_cursor=snapshot.cursor,
                snapshot_offset=snapshot_offset,
            )
        if result.get("has_more") is False:
            if recovery_client.snapshot_required:
                result["recovery_proof"] = issue_recovery_proof(
                    space_id=ctx["space_id"],
                    user_id=ctx["user_id"],
                    client_id=canonical_client_id,
                    snapshot_token=snapshot.token,
                    snapshot_cursor=snapshot.cursor,
                    snapshot_expires_at=snapshot.expires_at,
                )
        else:
            result["recovery_continuation"] = issue_recovery_continuation(
                space_id=ctx["space_id"],
                user_id=ctx["user_id"],
                client_id=canonical_client_id,
                snapshot_token=snapshot.token,
                snapshot_cursor=snapshot.cursor,
                expected_offset=result["snapshot_offset"],
                snapshot_expires_at=snapshot.expires_at,
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


@router.get("/ledger-stats", response_model=SyncLedgerStatsResponse)
async def ledger_stats(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return sync event ledger size stats (H2-E monitoring)."""
    stats = await get_ledger_stats(db)
    await db.commit()
    return stats
