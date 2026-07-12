"""Append-only sync event ledger backed by ``sync_outbox``.

The existing table name is retained for schema compatibility. H2 treats its
monotonic integer primary key as the authoritative server-side event sequence.
This service only flushes; the caller owns the surrounding transaction.

H2-E: includes ``prune_sync_events`` for retention — safely removes events
with ``id <= before_id`` so the ledger does not grow unbounded. The caller
must guarantee no client is still pulling from a cursor ``<= before_id``.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sync_outbox import SyncOutbox

SyncAction = Literal["create", "update", "delete"]
_VALID_ACTIONS = frozenset({"create", "update", "delete"})


async def record_sync_event(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: str,
    action: SyncAction,
    payload: Mapping[str, Any] | None = None,
    flush: bool = True,
) -> SyncOutbox:
    """Append one mutation event and return its allocated global sequence.

    The event is inserted in the caller's current transaction. A rollback
    therefore removes both the domain mutation and its ledger event. Repeated
    mutations intentionally create distinct rows: the sequence records change
    order rather than deduplicating entity state.
    """
    if not entity_type.strip():
        raise ValueError("entity_type must not be empty")
    if not entity_id.strip():
        raise ValueError("entity_id must not be empty")
    if action not in _VALID_ACTIONS:
        raise ValueError(f"Unsupported sync action: {action}")

    event = SyncOutbox(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        payload=json.dumps(
            payload or {},
            ensure_ascii=False,
            sort_keys=True,
            allow_nan=False,
        ),
    )
    db.add(event)
    if flush:
        await db.flush()
        await db.refresh(event)
    return event


async def prune_sync_events(
    db: AsyncSession,
    *,
    before_id: int,
) -> int:
    """Delete ledger events with ``id <= before_id`` and return the count removed.

    H2-E retention: the caller is responsible for ensuring no active client
    is pulling from a cursor ``<= before_id``. A safe heuristic is to prune
    only events older than the oldest known client cursor, or events older
    than a TTL window (e.g. 90 days, matching tombstone TTL).

    This function only flushes; the caller owns the surrounding transaction
    (typically a route that calls ``db.commit()`` afterwards).
    """
    if before_id < 0:
        raise ValueError("before_id must be >= 0")

    rows = (
        await db.execute(
            select(SyncOutbox).where(SyncOutbox.id <= before_id)
        )
    ).scalars().all()
    for row in rows:
        await db.delete(row)
    await db.flush()
    return len(rows)


async def get_ledger_stats(db: AsyncSession) -> dict[str, Any]:
    """Return ledger size statistics for monitoring / retention decisions.

    Returns ``{"total_events": int, "min_id": int|None, "max_id": int|None}``.
    """
    total = await db.scalar(
        select(func.count()).select_from(SyncOutbox)
    )
    min_id = await db.scalar(select(func.min(SyncOutbox.id)))
    max_id = await db.scalar(select(func.max(SyncOutbox.id)))
    return {
        "total_events": total or 0,
        "min_id": min_id,
        "max_id": max_id,
    }

