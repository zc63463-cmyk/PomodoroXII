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

from sqlalchemy import event, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.errors import RetentionAckRequiredError, to_wire_json
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState

SyncAction = Literal["create", "update", "delete"]
_VALID_ACTIONS = frozenset({"create", "update", "delete"})
_DEFERRED_WATERMARK_EVENTS = "pomodoroxii_deferred_watermark_events"


def _advance_deferred_watermarks(session: Session, _flush_context: object) -> None:
    pending = tuple(session.info.pop(_DEFERRED_WATERMARK_EVENTS, ()))
    allocated = tuple(
        item.id for item in pending if getattr(item, "id", None) is not None
    )
    if not allocated:
        return
    highest = max(allocated)
    session.connection().execute(
        sqlite_insert(SyncState)
        .values(id=1, retention_floor=0, current_cursor=highest)
        .on_conflict_do_update(
            index_elements=[SyncState.id],
            set_={"current_cursor": func.max(SyncState.current_cursor, highest)},
        )
    )
    for state in session.identity_map.values():
        if getattr(getattr(state, "__table__", None), "name", None) == "sync_state":
            session.expire(state, ("current_cursor",))


def _discard_deferred_watermarks(session: Session) -> None:
    session.info.pop(_DEFERRED_WATERMARK_EVENTS, None)


if not getattr(Session, "_pomodoroxii_watermark_listeners", False):
    event.listen(Session, "after_flush_postexec", _advance_deferred_watermarks)
    event.listen(Session, "after_rollback", _discard_deferred_watermarks)
    Session._pomodoroxii_watermark_listeners = True


async def record_sync_event(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: str,
    action: SyncAction,
    payload: Mapping[str, Any] | None = None,
    operation_id: str | None = None,
    batch_id: str | None = None,
    version: int | None = None,
    created_at: str | None = None,
    visible: bool,
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
    if type(visible) is not bool:
        raise ValueError("visible must be an explicit boolean")
    if version is not None and (type(version) is not int or version < 0):
        raise ValueError("version must be a nonnegative integer or null")
    try:
        wire_payload = to_wire_json(payload or {})
    except TypeError as exc:
        if "finite" in str(exc):
            raise ValueError("Out of range float values are not JSON compliant") from exc
        raise

    event = SyncOutbox(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        payload=json.dumps(
            wire_payload,
            ensure_ascii=False,
            sort_keys=True,
            allow_nan=False,
        ),
        operation_id=operation_id,
        batch_id=batch_id,
        version=version,
        visible=visible,
    )
    if created_at is not None:
        event.created_at = created_at
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
    else:
        db.sync_session.info.setdefault(_DEFERRED_WATERMARK_EVENTS, []).append(event)
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
    visible_ids = select(SyncOutbox.id).where(
        SyncOutbox.visible.is_(True)
    ).subquery()
    return int(await db.scalar(select(func.max(visible_ids.c.id))) or 0)


async def get_retention_floor(db: AsyncSession) -> int:
    state = await db.get(SyncState, 1)
    return state.retention_floor if state is not None else 0


async def get_ledger_stats(db: AsyncSession) -> dict[str, Any]:
    """Return count/min/max using one aggregate query."""
    visible_ids = select(SyncOutbox.id).where(
        SyncOutbox.visible.is_(True)
    ).subquery()
    row = (
        await db.execute(
            select(
                func.count(visible_ids.c.id),
                func.min(visible_ids.c.id),
                func.max(visible_ids.c.id),
            )
        )
    ).one()
    return {
        "total_events": int(row[0] or 0),
        "min_id": row[1],
        "max_id": row[2],
    }
