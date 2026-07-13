"""Read-only operational health aggregation for sync infrastructure."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sync_audit_log import SyncAuditLog
from app.models.sync_client import SyncClient
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncSnapshot, SyncState
from app.models.tombstone import Tombstone
from app.registry import REGISTRY
from app.registry.resolve import resolve_model
from app.services.time import utc_now


class SyncOpsService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def health(self) -> dict[str, object]:
        now = utc_now()
        now_iso = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        audit_floor = (
            (now - timedelta(hours=24))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

        state = await self.db.get(SyncState, 1)
        retention_floor = state.retention_floor if state is not None else 0
        current_cursor = state.current_cursor if state is not None else 0

        retained_events, min_event_id, max_event_id = (
            await self.db.execute(
                select(
                    func.count(SyncOutbox.id),
                    func.min(SyncOutbox.id),
                    func.max(SyncOutbox.id),
                )
            )
        ).one()
        retained_events = int(retained_events or 0)

        client_counts = (
            await self.db.execute(
                select(
                    func.count(SyncClient.client_id),
                    func.sum(case((SyncClient.revoked_at.is_not(None), 1), else_=0)),
                    func.sum(
                        case(
                            (
                                SyncClient.revoked_at.is_(None)
                                & (SyncClient.lease_expires_at <= now_iso),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    func.sum(
                        case(
                            (
                                SyncClient.revoked_at.is_(None)
                                & (SyncClient.lease_expires_at > now_iso)
                                & SyncClient.snapshot_required.is_(True),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    func.sum(
                        case(
                            (
                                SyncClient.revoked_at.is_(None)
                                & (SyncClient.lease_expires_at > now_iso)
                                & SyncClient.snapshot_required.is_(False),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                )
            )
        ).one()
        total_clients, revoked_clients, expired_clients, recovering_clients, active_clients = (
            int(value or 0) for value in client_counts
        )
        active_filter = (
            SyncClient.revoked_at.is_(None)
            & (SyncClient.lease_expires_at > now_iso)
            & SyncClient.snapshot_required.is_(False)
        )
        min_active_ack, max_active_ack = (
            await self.db.execute(
                select(
                    func.min(SyncClient.ack_cursor),
                    func.max(SyncClient.ack_cursor),
                ).where(active_filter)
            )
        ).one()
        max_lag = current_cursor - min_active_ack if min_active_ack is not None else 0
        max_lag = max(max_lag, 0)

        snapshot_counts = (
            await self.db.execute(
                select(
                    func.count(SyncSnapshot.token),
                    func.sum(
                        case(
                            (
                                (SyncSnapshot.expires_at > now_iso)
                                & (SyncSnapshot.status == "ready"),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    func.sum(
                        case(
                            (
                                (SyncSnapshot.expires_at > now_iso)
                                & (SyncSnapshot.status == "building"),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    func.sum(case((SyncSnapshot.expires_at <= now_iso, 1), else_=0)),
                )
            )
        ).one()
        total_snapshots, ready_snapshots, building_snapshots, expired_snapshots = (
            int(value or 0) for value in snapshot_counts
        )
        ready_filter = (SyncSnapshot.expires_at > now_iso) & (SyncSnapshot.status == "ready")
        ready_items, ready_chunks, ready_compressed_bytes, min_snapshot_cursor, max_snapshot_cursor = (
            await self.db.execute(
                select(
                    func.coalesce(func.sum(SyncSnapshot.item_count), 0),
                    func.coalesce(func.sum(SyncSnapshot.chunk_count), 0),
                    func.coalesce(func.sum(SyncSnapshot.compressed_bytes), 0),
                    func.min(SyncSnapshot.cursor),
                    func.max(SyncSnapshot.cursor),
                ).where(ready_filter)
            )
        ).one()

        entity_rows = 0
        for spec in REGISTRY.list_sync_enabled():
            model = resolve_model(spec)
            entity_rows += int(
                (await self.db.execute(select(func.count()).select_from(model))).scalar_one()
            )
        tombstones = int(
            (await self.db.execute(select(func.count()).select_from(Tombstone))).scalar_one()
        )

        events_24h, last_event_at = (
            await self.db.execute(
                select(
                    func.sum(case((SyncAuditLog.created_at >= audit_floor, 1), else_=0)),
                    func.max(SyncAuditLog.created_at),
                )
            )
        ).one()
        events_24h = int(events_24h or 0)

        ledger_bounds_valid = retention_floor <= current_cursor
        if retained_events:
            ledger_bounds_valid = bool(
                ledger_bounds_valid
                and min_event_id is not None
                and max_event_id is not None
                and retention_floor < min_event_id <= max_event_id <= current_cursor
            )
        else:
            ledger_bounds_valid = bool(ledger_bounds_valid)

        active_ack_bounds_valid = bool(
            min_active_ack is None
            or (
                retention_floor <= min_active_ack
                and max_active_ack is not None
                and min_active_ack <= max_active_ack <= current_cursor
            )
        )
        status = "ok" if ledger_bounds_valid and active_ack_bounds_valid else "degraded"

        return {
            "ledger": {
                "retained_events": retained_events,
                "min_id": min_event_id,
                "max_id": max_event_id,
                "retention_floor": retention_floor,
                "current_cursor": current_cursor,
            },
            "clients": {
                "total": total_clients,
                "active": active_clients,
                "expired": expired_clients,
                "recovering": recovering_clients,
                "revoked": revoked_clients,
                "min_active_ack": min_active_ack,
                "max_active_ack": max_active_ack,
                "max_lag": max_lag,
            },
            "snapshots": {
                "total": total_snapshots,
                "ready": ready_snapshots,
                "building": building_snapshots,
                "expired": expired_snapshots,
                "ready_items": int(ready_items or 0),
                "ready_chunks": int(ready_chunks or 0),
                "ready_compressed_bytes": int(ready_compressed_bytes or 0),
                "min_cursor": min_snapshot_cursor,
                "max_cursor": max_snapshot_cursor,
            },
            "data": {"entity_rows": entity_rows, "tombstones": tombstones},
            "audit": {"events_24h": events_24h, "last_event_at": last_event_at},
            "invariants": {
                "ledger_bounds_valid": ledger_bounds_valid,
                "active_ack_bounds_valid": active_ack_bounds_valid,
            },
            "status": status,
            "server_time": now_iso,
        }
