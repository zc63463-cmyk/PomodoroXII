"""Durable sync client registration, lease renewal, and manual ACK."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ConflictError, NotFoundError, ValidationError
from app.models.sync_client import SyncClient
from app.models.sync_state import SyncState
from app.services.sync_outbox import get_current_cursor, get_retention_floor
from app.services.time import utc_now

CLIENT_LEASE = timedelta(days=30)
MAX_ACTIVE_CLIENTS_PER_USER = 20


def _canonical_client_id(client_id: str) -> str:
    try:
        parsed = uuid.UUID(client_id)
    except (ValueError, AttributeError) as exc:
        raise ValidationError("client_id must be a UUID", error_type="sync_client_invalid") from exc
    if str(parsed) != client_id.lower():
        raise ValidationError("client_id must use canonical UUID format", error_type="sync_client_invalid")
    return str(parsed)


def _lease_times() -> tuple[str, str]:
    now = utc_now()
    return (
        now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        (now + CLIENT_LEASE).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


class SyncClientService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def register(
        self,
        *,
        client_id: str,
        user_id: str,
        display_name: str | None = None,
    ) -> dict[str, object]:
        canonical_id = _canonical_client_id(client_id)
        now, lease_expires_at = _lease_times()
        existing = await self.db.get(SyncClient, canonical_id)
        if existing is not None:
            if existing.user_id != user_id:
                raise ConflictError(
                    "client_id belongs to another user",
                    error_type="sync_client_owner_conflict",
                )
            if existing.revoked_at is not None:
                raise ConflictError(
                    "revoked client_id cannot be re-registered",
                    error_type="sync_client_revoked",
                )
            existing.display_name = display_name
            existing.last_seen_at = now
            existing.lease_expires_at = lease_expires_at
            await self.db.flush()
            return self._registration_result(existing)

        # Force SQLite to acquire the write lock before quota counting. The
        # no-op conditional update serializes concurrent registrations across
        # workers without relying on an in-process mutex.
        await self.db.execute(
            update(SyncState)
            .where(SyncState.id == 1)
            .values(current_cursor=SyncState.current_cursor)
        )
        active_count = await self.db.scalar(
            select(func.count())
            .select_from(SyncClient)
            .where(
                SyncClient.user_id == user_id,
                SyncClient.revoked_at.is_(None),
                SyncClient.lease_expires_at > now,
            )
        )
        if int(active_count or 0) >= MAX_ACTIVE_CLIENTS_PER_USER:
            raise ConflictError(
                "sync client quota exceeded",
                error_type="sync_client_quota_exceeded",
            )
        floor = await get_retention_floor(self.db)
        client = SyncClient(
            client_id=canonical_id,
            user_id=user_id,
            display_name=display_name,
            ack_cursor=floor,
            last_seen_at=now,
            lease_expires_at=lease_expires_at,
            created_at=now,
            snapshot_required=floor > 0,
        )
        self.db.add(client)
        try:
            await self.db.flush()
        except IntegrityError as exc:
            raise ConflictError(
                "client_id registration conflicted",
                error_type="sync_client_registration_conflict",
            ) from exc
        return self._registration_result(client)

    async def acknowledge(
        self,
        *,
        client_id: str,
        user_id: str,
        ack_cursor: int,
        cursor_version: int,
    ) -> dict[str, object]:
        canonical_id = _canonical_client_id(client_id)
        if cursor_version != 2:
            raise ValidationError(
                "cursor_version must be 2",
                error_type="sync_ack_cursor_version_invalid",
            )
        client = await self.db.get(SyncClient, canonical_id)
        if client is None or client.user_id != user_id:
            raise NotFoundError(
                "sync client not found",
                error_type="sync_client_not_found",
            )
        if client.revoked_at is not None:
            raise ConflictError(
                "sync client is revoked",
                error_type="sync_client_revoked",
            )

        # Acquire SQLite's database write lock before reading the cursor bounds.
        # This keeps the bounds check and conditional ACK update in one serialized
        # writer transaction across workers and processes.
        await self.db.execute(
            update(SyncState)
            .where(SyncState.id == 1)
            .values(current_cursor=SyncState.current_cursor)
        )
        floor = await get_retention_floor(self.db)
        current = await get_current_cursor(self.db)
        if ack_cursor < floor:
            raise ConflictError(
                "ack_cursor is below retention floor",
                error_type="sync_ack_below_floor",
            )
        if ack_cursor > current:
            raise ConflictError(
                "ack_cursor exceeds current cursor",
                error_type="sync_ack_above_current",
            )
        if client.snapshot_required and ack_cursor <= floor:
            raise ConflictError(
                "full snapshot must be completed before acknowledging this client",
                error_type="sync_snapshot_required",
            )
        now, lease_expires_at = _lease_times()
        result = await self.db.execute(
            update(SyncClient)
            .where(
                SyncClient.client_id == canonical_id,
                SyncClient.user_id == user_id,
                SyncClient.revoked_at.is_(None),
                SyncClient.ack_cursor <= ack_cursor,
            )
            .values(
                ack_cursor=ack_cursor,
                last_seen_at=now,
                lease_expires_at=lease_expires_at,
                snapshot_required=False,
            )
        )
        if result.rowcount == 0:
            raise ConflictError(
                "ack_cursor cannot move backwards",
                error_type="sync_ack_regression",
            )
        await self.db.flush()
        return {
            "ack_cursor": ack_cursor,
            "lease_expires_at": lease_expires_at,
            "retention_floor": floor,
            "current_cursor": current,
        }

    @staticmethod
    def _registration_result(client: SyncClient) -> dict[str, object]:
        return {
            "client_id": client.client_id,
            "display_name": client.display_name,
            "ack_cursor": client.ack_cursor,
            "lease_expires_at": client.lease_expires_at,
            "snapshot_required": client.snapshot_required,
        }
