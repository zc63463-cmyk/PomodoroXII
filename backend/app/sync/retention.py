"""Client-ACK governed Sync ledger and tombstone retention."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete

from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.models.tombstone import Tombstone
from app.sync.clients import SyncClientRegistry


@dataclass(frozen=True, slots=True)
class RetentionResult:
    waterline: int | None
    ledger_rows: int
    tombstones: int


class RetentionCoordinator:
    """Prune only from a durable active-client ACK waterline.

    The coordinator deliberately owns no session.  A caller supplies an S2
    ``SpaceRuntimeHandle`` and the whole operation runs under its exclusive
    lease and one transaction.
    """

    def __init__(
        self,
        catalog_hash=None,
        ttl_days: int = 30,
        *,
        catalog=None,
        uow=None,
        space_id: str | None = None,
    ) -> None:
        if catalog is not None:
            catalog_hash = getattr(catalog, "hash", catalog_hash)
        if catalog_hash is None:
            catalog_hash = "0" * 64
        self.catalog_hash = catalog_hash
        self.ttl_days = ttl_days
        self.uow = uow
        self.space_id = space_id

    @staticmethod
    def _scope_space_id(scope) -> str | None:
        nested = getattr(scope, "scope", None)
        return getattr(nested, "space_id", None) or getattr(scope, "space_id", None)

    async def _recover(self, scope, lease) -> None:
        if self.uow is not None:
            recover = getattr(self.uow, "recover_under_lease", None)
            if recover is not None:
                await recover(scope, lease)
                return
        runtime = getattr(scope, "_runtime", None)
        recover = getattr(runtime, "recover_under_lease", None)
        if recover is not None:
            await recover(scope, lease)

    async def prune(self, scope) -> RetentionResult:
        scope_id = self.space_id or self._scope_space_id(scope)
        async with scope.exclusive_space_resources("sync-retention", 60) as lease:
            await self._recover(scope, lease)
            async with scope.session_factory() as session, session.begin():
                registry = SyncClientRegistry(
                    session,
                    catalog_hash=self.catalog_hash,
                    ttl_days=self.ttl_days,
                    space_id=scope_id,
                )
                # These are bounded, durable state transitions.  Their
                # effects must be in the same transaction as the floor CAS.
                await registry.expire_inactive()
                await registry.collect_expired_recovery()
                await registry.delete_expired_registrations(limit=100)
                floor = await registry.minimum_safe_retention_sequence()
                if floor is None:
                    return RetentionResult(None, 0, 0)

                state = await session.get(SyncState, 1)
                if state is None:
                    state = SyncState(id=1, retention_floor=0, current_cursor=0)
                    session.add(state)
                    await session.flush()
                if floor > state.current_cursor:
                    raise RuntimeError("ack waterline exceeds allocated cursor")

                # The durable floor is monotonic even if a manually repaired
                # client row is older than the already committed floor.
                waterline = max(state.retention_floor, floor)

                ledger = await session.execute(
                    delete(SyncOutbox).where(
                        SyncOutbox.visible.is_(True), SyncOutbox.id <= waterline
                    )
                )
                tombstones = await session.execute(
                    delete(Tombstone).where(
                        Tombstone.delete_sequence.is_not(None),
                        Tombstone.delete_sequence <= waterline,
                    )
                )
                state.retention_floor = waterline
                await session.flush()
                assert_fence = getattr(lease, "assert_fence", None)
                if assert_fence is not None and scope_id is not None:
                    assert_fence(scope_id)
                return RetentionResult(
                    waterline=waterline,
                    ledger_rows=int(ledger.rowcount or 0),
                    tombstones=int(tombstones.rowcount or 0),
                )


__all__ = ["RetentionCoordinator", "RetentionResult"]
