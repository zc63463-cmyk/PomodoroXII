"""Append-only sync event ledger backed by ``sync_outbox``.

The existing table name is retained for schema compatibility. H2 treats its
monotonic integer primary key as the authoritative server-side event sequence.
This service only flushes; the caller owns the surrounding transaction.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

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
