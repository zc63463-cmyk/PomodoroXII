"""Append-only sync event ledger backed by ``sync_outbox``.

The existing table name is retained for schema compatibility. H2 treats its
monotonic integer primary key as the authoritative server-side event sequence.
This service only flushes; the caller owns the surrounding transaction.

H2-E retention helpers are service-internal. No public client-facing prune
endpoint is exposed until client ACKs can establish a safe deletion floor.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import RetentionAckRequiredError
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState

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
        await db.execute(
            sqlite_insert(SyncState)
            .values(id=1, retention_floor=0, current_cursor=event.id)
            .on_conflict_do_update(
                index_elements=[SyncState.id],
                set_={"current_cursor": func.max(SyncState.current_cursor, event.id)},
            )
        )
    return event


async def advance_retention_floor(db: AsyncSession, *, floor: int) -> None:
    """Reject retention until S4 owns registered-client ACK waterlines."""
    raise RetentionAckRequiredError()


async def prune_sync_events(db: AsyncSession, *, before_id: int) -> int:
    """Reject pruning until S4 owns registered-client ACK waterlines."""
    raise RetentionAckRequiredError()


async def get_current_cursor(db: AsyncSession) -> int:
    state = await db.get(SyncState, 1)
    if state is not None:
        return state.current_cursor
    return int(await db.scalar(select(func.max(SyncOutbox.id))) or 0)


async def get_retention_floor(db: AsyncSession) -> int:
    state = await db.get(SyncState, 1)
    return state.retention_floor if state is not None else 0


async def get_ledger_stats(db: AsyncSession) -> dict[str, Any]:
    """Return count/min/max using one aggregate query."""
    row = (
        await db.execute(
            select(
                func.count(SyncOutbox.id),
                func.min(SyncOutbox.id),
                func.max(SyncOutbox.id),
            )
        )
    ).one()
    return {
        "total_events": int(row[0] or 0),
        "min_id": row[1],
        "max_id": row[2],
    }
