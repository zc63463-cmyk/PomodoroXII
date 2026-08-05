"""Durable Sync v2 client registration and ACK waterline state."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, SyncCursorExpiredError
from app.models.sync_client import SyncClient
from app.models.sync_recovery import SyncRecoveryManifest
from app.services.sync_outbox import get_current_cursor, get_retention_floor
from app.services.time import utc_now_iso_ms

_MAX_MAINTENANCE_PAGE = 100


def _validate_identifier(value: str, *, field: str) -> str:
    from app.task_space.document import ID_PATTERN

    if not isinstance(value, str) or ID_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{field} is invalid")
    return value


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _expires_at(now: str, ttl_days: int) -> str:
    return (_parse_time(now) + timedelta(days=ttl_days)).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    )[:23] + "Z"


@dataclass(frozen=True, slots=True)
class ClientRegistration:
    client_id: str
    ack_sequence: int
    catalog_hash: str
    requires_recovery: bool
    recovery_generation: int
    recovery_manifest_token: str | None
    recovery_waterline: int | None
    recovery_completed_at: str | None
    expires_at: str


@dataclass(frozen=True, slots=True)
class AckResult:
    client_id: str
    accepted: Literal[True]
    requires_recovery: bool
    catalog_hash: str


@dataclass(frozen=True, slots=True)
class AckDecision:
    result: AckResult | None
    error: AppError | None

    def __post_init__(self) -> None:
        if (self.result is None) == (self.error is None):
            raise ValueError("ACK decision requires exactly one outcome")


class SyncClientRegistry:
    """Session-bound registry; callers own the transaction and lease."""

    def __init__(
        self,
        session: AsyncSession,
        catalog_hash: str,
        ttl_days: int,
        *,
        space_id: str | None = None,
        now_factory=utc_now_iso_ms,
    ) -> None:
        if type(ttl_days) is not int or ttl_days <= 0:
            raise ValueError("ttl_days must be a positive integer")
        if not isinstance(catalog_hash, str) or not catalog_hash:
            raise ValueError("catalog_hash must not be empty")
        self.db = session
        self.catalog_hash = catalog_hash
        self.ttl_days = ttl_days
        self.space_id = space_id
        self._now_factory = now_factory

    def _now(self) -> str:
        return self._now_factory()

    @staticmethod
    def _registration(row: SyncClient) -> ClientRegistration:
        return ClientRegistration(
            client_id=row.client_id,
            ack_sequence=row.ack_sequence,
            catalog_hash=row.catalog_hash,
            requires_recovery=row.requires_recovery,
            recovery_generation=row.recovery_generation,
            recovery_manifest_token=row.recovery_manifest_token,
            recovery_waterline=row.recovery_waterline,
            recovery_completed_at=row.recovery_completed_at,
            expires_at=row.expires_at,
        )

    @staticmethod
    def _expired_error() -> SyncCursorExpiredError:
        return SyncCursorExpiredError(recovery_action="full_recovery")

    async def register_or_touch(self, client_id: str) -> ClientRegistration:
        client_id = _validate_identifier(client_id, field="client_id")
        now = self._now()
        expires = _expires_at(now, self.ttl_days)
        row = await self.db.get(SyncClient, client_id)
        if row is None:
            row = SyncClient(
                client_id=client_id,
                ack_sequence=0,
                catalog_hash=self.catalog_hash,
                registered_at=now,
                last_seen_at=now,
                expires_at=expires,
                requires_recovery=True,
                recovery_generation=0,
            )
            self.db.add(row)
        else:
            stale = row.expires_at <= now or row.catalog_hash != self.catalog_hash
            if stale:
                row.requires_recovery = True
                row.recovery_manifest_token = None
                row.recovery_waterline = None
                row.recovery_completed_at = None
                row.catalog_hash = self.catalog_hash
            row.last_seen_at = now
            row.expires_at = expires
        await self.db.flush()
        return self._registration(row)

    async def acknowledge(self, client_id: str, position) -> AckDecision:
        from app.sync.cursor import CursorPosition

        try:
            client_id = _validate_identifier(client_id, field="client_id")
        except ValueError:
            return AckDecision(None, self._expired_error())
        if not isinstance(position, CursorPosition):
            return AckDecision(None, self._expired_error())
        row = await self.db.get(SyncClient, client_id)
        if row is None:
            return AckDecision(None, self._expired_error())

        def reject() -> AckDecision:
            return AckDecision(None, self._expired_error())

        if position.client_id != client_id:
            return reject()
        if self.space_id is not None and position.space_id != self.space_id:
            return reject()
        if position.catalog_hash != self.catalog_hash or row.catalog_hash != self.catalog_hash:
            row.requires_recovery = True
            row.recovery_manifest_token = None
            row.recovery_waterline = None
            row.recovery_completed_at = None
            row.catalog_hash = self.catalog_hash
            await self.db.flush()
            return reject()
        if position.generation != row.recovery_generation:
            return reject()

        current_cursor = await get_current_cursor(self.db)
        floor = await get_retention_floor(self.db)
        if position.sequence > current_cursor or position.sequence < floor:
            return reject()

        now = self._now()
        if row.requires_recovery:
            token = row.recovery_manifest_token
            if row.recovery_waterline is None or row.recovery_completed_at is None or token is None:
                return reject()
            manifest = await self.db.get(SyncRecoveryManifest, token)
            if manifest is None:
                return reject()
            if position.sequence != row.recovery_waterline:
                return reject()
            if (
                (self.space_id is not None and manifest.space_id != self.space_id)
                or manifest.client_id != client_id
                or manifest.catalog_hash != self.catalog_hash
                or manifest.generation != row.recovery_generation
                or manifest.expires_at <= now
            ):
                return reject()
            row.requires_recovery = False
            row.recovery_manifest_token = None
            row.recovery_waterline = None
            row.recovery_completed_at = None

        if position.sequence < row.ack_sequence:
            return reject()
        row.ack_sequence = position.sequence
        row.last_seen_at = now
        row.expires_at = _expires_at(now, self.ttl_days)
        await self.db.flush()
        return AckDecision(
            AckResult(
                client_id=client_id,
                accepted=True,
                requires_recovery=row.requires_recovery,
                catalog_hash=self.catalog_hash,
            ),
            None,
        )

    async def minimum_safe_retention_sequence(self) -> int | None:
        active_ack = await self.db.scalar(
            select(func.min(SyncClient.ack_sequence)).where(
                SyncClient.requires_recovery.is_(False)
            )
        )
        recovery_pin = await self.db.scalar(
            select(func.min(SyncRecoveryManifest.waterline)).join(
                SyncClient,
                SyncClient.recovery_manifest_token == SyncRecoveryManifest.token,
            ).where(SyncClient.recovery_manifest_token.is_not(None))
        )
        candidates = [value for value in (active_ack, recovery_pin) if value is not None]
        return min(candidates) if candidates else None

    async def expire_inactive(self) -> tuple[str, ...]:
        now = self._now()
        rows = (
            await self.db.execute(
                select(SyncClient)
                .where(
                    or_(
                        SyncClient.requires_recovery.is_(False),
                        SyncClient.recovery_manifest_token.is_not(None),
                        SyncClient.recovery_waterline.is_not(None),
                        SyncClient.recovery_completed_at.is_not(None),
                        SyncClient.catalog_hash != self.catalog_hash,
                    ),
                    or_(
                        SyncClient.expires_at <= now,
                        SyncClient.catalog_hash != self.catalog_hash,
                    )
                )
                .order_by(SyncClient.client_id.asc())
                .limit(_MAX_MAINTENANCE_PAGE)
            )
        ).scalars().all()
        changed: list[str] = []
        for row in rows:
            row.requires_recovery = True
            row.recovery_manifest_token = None
            row.recovery_waterline = None
            row.recovery_completed_at = None
            row.catalog_hash = self.catalog_hash
            changed.append(row.client_id)
        if changed:
            await self.db.flush()
        return tuple(changed)

    async def collect_expired_recovery(self) -> int:
        now = self._now()
        stale_manifest = or_(
            SyncRecoveryManifest.token.is_(None),
            SyncRecoveryManifest.expires_at <= now,
            SyncRecoveryManifest.catalog_hash != self.catalog_hash,
            SyncRecoveryManifest.client_id != SyncClient.client_id,
            SyncRecoveryManifest.generation != SyncClient.recovery_generation,
        )
        if self.space_id is not None:
            stale_manifest = or_(
                stale_manifest,
                SyncRecoveryManifest.space_id != self.space_id,
            )
        rows = (
            await self.db.execute(
                select(SyncClient)
                .outerjoin(
                    SyncRecoveryManifest,
                    SyncClient.recovery_manifest_token == SyncRecoveryManifest.token,
                )
                .where(
                    SyncClient.recovery_manifest_token.is_not(None),
                    stale_manifest,
                )
                .order_by(SyncClient.client_id.asc())
                .limit(_MAX_MAINTENANCE_PAGE)
            )
        ).scalars().all()
        changed = 0
        for row in rows:
            assert row.recovery_manifest_token is not None
            manifest = await self.db.get(SyncRecoveryManifest, row.recovery_manifest_token)
            invalid = manifest is None or manifest.expires_at <= now
            if manifest is not None:
                invalid = invalid or manifest.catalog_hash != self.catalog_hash
                invalid = invalid or manifest.client_id != row.client_id
                invalid = invalid or manifest.generation != row.recovery_generation
                if self.space_id is not None:
                    invalid = invalid or manifest.space_id != self.space_id
            if not invalid:
                continue
            row.requires_recovery = True
            row.recovery_manifest_token = None
            row.recovery_waterline = None
            row.recovery_completed_at = None
            changed += 1
        if changed:
            await self.db.flush()

        # Delete only stale manifests that are already unreferenced.  The
        # query is deliberately bounded so a maintenance call cannot create
        # an unbounded transaction.
        referenced = select(SyncClient.recovery_manifest_token).where(
            SyncClient.recovery_manifest_token.is_not(None)
        )
        manifests = (
            await self.db.execute(
                select(SyncRecoveryManifest)
                .where(
                    or_(
                        SyncRecoveryManifest.expires_at <= now,
                        SyncRecoveryManifest.catalog_hash != self.catalog_hash,
                    ),
                    ~SyncRecoveryManifest.token.in_(referenced),
                )
                .order_by(SyncRecoveryManifest.token.asc())
                .limit(_MAX_MAINTENANCE_PAGE)
            )
        ).scalars().all()
        for manifest in manifests:
            await self.db.delete(manifest)
        if manifests:
            await self.db.flush()
        return changed

    async def delete_expired_registrations(self, limit: int = _MAX_MAINTENANCE_PAGE) -> int:
        if type(limit) is not int or not 1 <= limit <= _MAX_MAINTENANCE_PAGE:
            raise ValueError("registration deletion limit must be an integer from 1 to 100")
        now = self._now()
        rows = (
            await self.db.execute(
                select(SyncClient)
                .where(
                    SyncClient.requires_recovery.is_(True),
                    SyncClient.expires_at <= now,
                    SyncClient.recovery_manifest_token.is_(None),
                    SyncClient.recovery_waterline.is_(None),
                    SyncClient.recovery_completed_at.is_(None),
                )
                .order_by(SyncClient.client_id.asc())
                .limit(limit)
            )
        ).scalars().all()
        for row in rows:
            await self.db.delete(row)
        if rows:
            await self.db.flush()
        return len(rows)


__all__ = [
    "AckDecision",
    "AckResult",
    "ClientRegistration",
    "SyncClientRegistry",
]
