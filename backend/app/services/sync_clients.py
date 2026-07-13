"""Durable sync client registration, lease renewal, and manual ACK."""

from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AuthenticationError, ConflictError, NotFoundError, ValidationError
from app.models.sync_client import SyncClient
from app.models.sync_state import SyncSnapshot, SyncSnapshotChunk, SyncState
from app.services.sync_outbox import (
    advance_retention_floor,
    get_current_cursor,
    get_retention_floor,
    prune_sync_events,
)
from app.services.sync_recovery import verify_recovery_proof
from app.services.time import utc_now

CLIENT_LEASE = timedelta(days=30)
MAX_ACTIVE_CLIENTS_PER_USER = 20
def _hash_device_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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
        client_token: str,
        display_name: str | None = None,
        authorized_by_client_id: str | None = None,
    ) -> dict[str, object]:
        canonical_id = _canonical_client_id(client_id)
        now, lease_expires_at = _lease_times()
        # Serialize renewal with floor advancement. Otherwise an expired client
        # could be renewed against a stale floor and briefly re-enter the active
        # minimum without being forced through snapshot recovery.
        await self.db.execute(
            update(SyncState)
            .where(SyncState.id == 1)
            .values(current_cursor=SyncState.current_cursor)
        )
        floor = await get_retention_floor(self.db)
        existing = await self.db.get(SyncClient, canonical_id, populate_existing=True)
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
            if existing.token_hash is None:
                existing.token_hash = _hash_device_token(client_token)
            else:
                self._verify_token(existing, client_token)
            existing.display_name = display_name
            existing.last_seen_at = now
            existing.lease_expires_at = lease_expires_at
            if existing.ack_cursor < floor:
                existing.ack_cursor = floor
                existing.snapshot_required = True
            await self.db.flush()
            return self._registration_result(existing)

        # The writer lock above serializes bootstrap, authorization, and quota
        # checks across workers without relying on an in-process mutex.
        total_count = int(await self.db.scalar(
            select(func.count())
            .select_from(SyncClient)
            .where(SyncClient.user_id == user_id)
        ) or 0)
        if total_count > 0 and authorized_by_client_id is None:
            raise AuthenticationError(
                "Invalid sync client credentials",
                error_type="sync_client_credentials_invalid",
            )
        if authorized_by_client_id is not None:
            authorizer = await self.db.get(
                SyncClient,
                _canonical_client_id(authorized_by_client_id),
                populate_existing=True,
            )
            if (
                authorizer is None
                or authorizer.user_id != user_id
                or authorizer.revoked_at is not None
                or authorizer.lease_expires_at <= now
                or authorizer.snapshot_required
            ):
                raise AuthenticationError(
                    "Invalid sync client credentials",
                    error_type="sync_client_credentials_invalid",
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
        client = SyncClient(
            client_id=canonical_id,
            user_id=user_id,
            display_name=display_name,
            ack_cursor=floor,
            last_seen_at=now,
            lease_expires_at=lease_expires_at,
            created_at=now,
            snapshot_required=floor > 0,
            token_hash=_hash_device_token(client_token),
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

    async def authenticate(
        self,
        *,
        client_id: str,
        client_token: str | None,
        user_id: str,
        allow_recovery: bool = True,
    ) -> SyncClient:
        canonical_id = _canonical_client_id(client_id)
        client = await self.db.get(SyncClient, canonical_id, populate_existing=True)
        if client is None or client.user_id != user_id:
            raise AuthenticationError(
                "Invalid sync client credentials",
                error_type="sync_client_credentials_invalid",
            )
        self._verify_token(client, client_token)
        if client.revoked_at is not None:
            raise ConflictError("sync client is revoked", error_type="sync_client_revoked")
        now = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
        if client.lease_expires_at <= now:
            raise ConflictError(
                "sync client lease has expired",
                error_type="sync_client_lease_expired",
            )
        if not allow_recovery and client.snapshot_required:
            raise ConflictError(
                "sync client must complete snapshot recovery before push",
                error_type="sync_client_recovery_required",
            )
        return client

    async def list_clients(self, *, user_id: str) -> list[dict[str, object]]:
        now = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
        clients = list(
            await self.db.scalars(
                select(SyncClient)
                .where(SyncClient.user_id == user_id)
                .order_by(SyncClient.created_at, SyncClient.client_id)
            )
        )
        return [self._client_item(client, now=now) for client in clients]

    async def revoke(
        self,
        *,
        client_id: str,
        user_id: str,
    ) -> dict[str, object]:
        canonical_id = _canonical_client_id(client_id)
        await self.db.execute(
            update(SyncState)
            .where(SyncState.id == 1)
            .values(current_cursor=SyncState.current_cursor)
        )
        client = await self.db.scalar(
            select(SyncClient).where(
                SyncClient.client_id == canonical_id,
                SyncClient.user_id == user_id,
            )
        )
        if client is None:
            raise NotFoundError(
                "sync client not found",
                error_type="sync_client_not_found",
            )
        if client.revoked_at is not None:
            maintenance = await self.advance_safe_retention_floor(lock_acquired=True)
            return {
                "client_id": client.client_id,
                "revoked_at": client.revoked_at,
                **maintenance,
            }

        now = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
        client.revoked_at = now
        client.last_seen_at = now
        await self.db.flush()
        maintenance = await self.advance_safe_retention_floor(lock_acquired=True)
        return {
            "client_id": client.client_id,
            "revoked_at": now,
            **maintenance,
        }

    async def validate_snapshot_client(
        self,
        *,
        client_id: str,
        user_id: str,
        require_recovery: bool = False,
    ) -> SyncClient:
        canonical_id = _canonical_client_id(client_id)
        client = await self.db.get(SyncClient, canonical_id, populate_existing=True)
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
        if require_recovery and not client.snapshot_required:
            raise ConflictError(
                "sync client does not require snapshot recovery",
                error_type="sync_recovery_proof_invalid",
            )
        return client

    async def acknowledge(
        self,
        *,
        client_id: str,
        user_id: str,
        space_id: str = "",
        ack_cursor: int,
        cursor_version: int,
        recovery_proof: str | None = None,
    ) -> dict[str, object]:
        canonical_id = _canonical_client_id(client_id)
        if cursor_version != 2:
            raise ValidationError(
                "cursor_version must be 2",
                error_type="sync_ack_cursor_version_invalid",
            )
        # Acquire SQLite's database write lock before reading client state or
        # cursor bounds. This serializes ACK with registration, renewal,
        # revocation, floor advancement, and event pruning across workers.
        await self.db.execute(
            update(SyncState)
            .where(SyncState.id == 1)
            .values(current_cursor=SyncState.current_cursor)
        )
        client = await self.db.get(SyncClient, canonical_id, populate_existing=True)
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
        now = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
        if client.lease_expires_at <= now:
            raise ConflictError(
                "sync client lease has expired",
                error_type="sync_client_lease_expired",
            )

        floor = await get_retention_floor(self.db)
        current = await get_current_cursor(self.db)
        snapshot_token = None
        if client.snapshot_required:
            if recovery_proof is None:
                raise ConflictError(
                    "recovery proof is required",
                    error_type="sync_recovery_proof_required",
                )
            claims = verify_recovery_proof(
                recovery_proof,
                space_id=space_id,
                user_id=user_id,
                client_id=canonical_id,
                ack_cursor=ack_cursor,
            )
            snapshot_token = claims["snapshot"]
            snapshot = await self.db.get(
                SyncSnapshot, snapshot_token, populate_existing=True
            )
            if (
                snapshot is None
                or snapshot.status != "ready"
                or snapshot.expires_at <= now
                or snapshot.cursor != ack_cursor
            ):
                raise ConflictError(
                    "sync recovery proof is invalid",
                    error_type="sync_recovery_proof_invalid",
                )
        elif recovery_proof is not None:
            raise ConflictError(
                "sync recovery proof is invalid",
                error_type="sync_recovery_proof_invalid",
            )
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
        if snapshot_token is not None:
            await self.db.execute(
                delete(SyncSnapshotChunk).where(
                    SyncSnapshotChunk.snapshot_token == snapshot_token
                )
            )
            deleted = await self.db.execute(
                delete(SyncSnapshot).where(SyncSnapshot.token == snapshot_token)
            )
            if deleted.rowcount != 1:
                raise ConflictError(
                    "sync recovery proof is invalid",
                    error_type="sync_recovery_proof_invalid",
                )
        await self.db.flush()
        maintenance = await self.advance_safe_retention_floor(lock_acquired=True)
        return {
            "ack_cursor": ack_cursor,
            "lease_expires_at": lease_expires_at,
            **maintenance,
        }

    async def advance_safe_retention_floor(
        self,
        *,
        lock_acquired: bool = False,
        evaluated_at: str | None = None,
    ) -> dict[str, int]:
        """Advance to the minimum durable ACK of every active client.

        The write lock must be acquired before computing the candidate so a
        concurrent registration cannot appear after the minimum ACK query and
        before old events are pruned. With no active clients, maintenance is a
        deliberate no-op.
        """
        if not lock_acquired:
            await self.db.execute(
                update(SyncState)
                .where(SyncState.id == 1)
                .values(current_cursor=SyncState.current_cursor)
            )
        now = evaluated_at or utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
        row = (
            await self.db.execute(
                select(
                    func.count(SyncClient.client_id),
                    func.min(SyncClient.ack_cursor),
                ).where(
                    SyncClient.revoked_at.is_(None),
                    SyncClient.lease_expires_at > now,
                    SyncClient.snapshot_required.is_(False),
                )
            )
        ).one()
        active_client_count = int(row[0] or 0)
        floor = await get_retention_floor(self.db)
        current = await get_current_cursor(self.db)
        if active_client_count == 0:
            return {
                "retention_floor": floor,
                "current_cursor": current,
                "active_client_count": 0,
                "pruned_events": 0,
            }

        candidate = int(row[1])
        if candidate <= floor:
            return {
                "retention_floor": floor,
                "current_cursor": current,
                "active_client_count": active_client_count,
                "pruned_events": 0,
            }
        if candidate > current:
            raise RuntimeError("active client ACK exceeds current cursor")

        await advance_retention_floor(
            self.db,
            floor=candidate,
            active_client_count=active_client_count,
            reason="active_client_min_ack",
        )
        pruned_events = await prune_sync_events(self.db, before_id=candidate)
        return {
            "retention_floor": candidate,
            "current_cursor": current,
            "active_client_count": active_client_count,
            "pruned_events": pruned_events,
        }

    @staticmethod
    def _verify_token(client: SyncClient, client_token: str | None) -> None:
        supplied_hash = _hash_device_token(client_token or "")
        if client.token_hash is None or not hmac.compare_digest(client.token_hash, supplied_hash):
            raise AuthenticationError(
                "Invalid sync client credentials",
                error_type="sync_client_credentials_invalid",
            )

    @staticmethod
    def _client_item(client: SyncClient, *, now: str) -> dict[str, object]:
        if client.revoked_at is not None:
            status = "revoked"
        elif client.lease_expires_at <= now:
            status = "expired"
        elif client.snapshot_required:
            status = "recovering"
        else:
            status = "active"
        return {
            "client_id": client.client_id,
            "display_name": client.display_name,
            "ack_cursor": client.ack_cursor,
            "last_seen_at": client.last_seen_at,
            "lease_expires_at": client.lease_expires_at,
            "created_at": client.created_at,
            "snapshot_required": client.snapshot_required,
            "revoked_at": client.revoked_at,
            "status": status,
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
