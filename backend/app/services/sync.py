"""SyncService — push/pull/full/status for cross-device synchronization.

Iron rules:
- Does NOT import FastAPI (MCP-consumable).
- Only flushes, never commits (routes commit).
- Uses SAVEPOINT (db.begin_nested) to isolate per-event failures.
- Note entities are routed through NoteService once C6 lands; until then
  the note entity path uses the same ORM logic as other entities.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.folder import Folder
from app.models.habit import Habit
from app.models.habit_check_in import HabitCheckIn
from app.models.memo_comment import MemoComment
from app.models.note import Note
from app.models.quick_note import QuickNote
from app.models.reflection import Reflection
from app.models.schedule import Schedule
from app.models.schedule_quick_note import ScheduleQuickNote
from app.models.session import Session
from app.models.session_quick_note import SessionQuickNote
from app.models.task import Task
from app.models.task_quick_note import TaskQuickNote
from app.models.time_block import TimeBlock
from app.models.tombstone import Tombstone
from app.services.sync_safety import (
    check_folder_circular_ref,
    check_lww_conflict,
    normalize_timestamp,
    sanitize_zero_time,
    strip_client_fields,
)
from app.services.time import utc_now_iso
from app.services.tombstone import TombstoneService

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Entity registry
# --------------------------------------------------------------------------- #

ENTITY_REGISTRY: dict[str, dict[str, Any]] = {
    "task": {"model": Task, "pull_key": "tasks"},
    "session": {"model": Session, "pull_key": "sessions"},
    "note": {"model": Note, "pull_key": "notes"},
    "folder": {"model": Folder, "pull_key": "folders"},
    "quickNote": {"model": QuickNote, "pull_key": "quickNotes"},
    "reflection": {"model": Reflection, "pull_key": "reflections"},
    "habit": {"model": Habit, "pull_key": "habits"},
    "habitCheckIn": {"model": HabitCheckIn, "pull_key": "habitCheckIns"},
    "schedule": {"model": Schedule, "pull_key": "schedules"},
    "timeBlock": {"model": TimeBlock, "pull_key": "timeBlocks"},
    "memoComment": {"model": MemoComment, "pull_key": "memoComments"},
    "sessionQuickNote": {"model": SessionQuickNote, "pull_key": "sessionQuickNotes"},
    "scheduleQuickNote": {"model": ScheduleQuickNote, "pull_key": "scheduleQuickNotes"},
    "taskQuickNote": {"model": TaskQuickNote, "pull_key": "taskQuickNotes"},
}


class SyncService:
    """Push/pull/full/status service bound to a single space DB.

    Parameters:
        db: AsyncSession bound to the space's database.
        fs: optional FileSystem for note content (used by pull/full and
            note-specific push events once C6 lands).
    """

    def __init__(self, db: AsyncSession, fs: Any = None) -> None:
        self.db = db
        self.fs = fs
        # D-4: pending audit entries flushed in batch by _flush_pending_audits().
        self._pending_audits: list[Any] = []

    # ----------------------------------------------------------------- #
    # push
    # ----------------------------------------------------------------- #

    async def push(self, events: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply a batch of sync events.

        Each event is applied inside a SAVEPOINT so a failure on one
        event does not abort the whole batch. Returns a dict with
        ``applied`` / ``conflicts`` / ``errors`` / ``server_time``.
        """
        applied: list[dict[str, str]] = []
        conflicts: list[dict[str, str]] = []
        errors: list[dict[str, str]] = []

        for event in events:
            etype = event.get("entity_type", "")
            eid = event.get("entity_id", "")
            action = event.get("action", "")
            payload = event.get("payload", {}) or {}
            client_ts = event.get("client_updated_at", "") or ""

            if etype not in ENTITY_REGISTRY:
                errors.append({
                    "entity_type": etype,
                    "entity_id": eid,
                    "error": f"Unknown entity_type: {etype}",
                })
                continue

            # Note events are routed through NoteService(sync_mode=True) so
            # the filesystem (.md file) and DB row stay consistent and client
            # timestamps/version are preserved.
            if etype == "note":
                try:
                    async with self.db.begin_nested():
                        resolution = await self._push_note_event(
                            etype, eid, action, payload, client_ts,
                        )
                        if resolution == "conflict_local":
                            conflicts.append({
                                "entity_type": etype,
                                "entity_id": eid,
                                "resolution": "local",
                            })
                        elif resolution == "conflict_remote":
                            conflicts.append({
                                "entity_type": etype,
                                "entity_id": eid,
                                "resolution": "remote",
                            })
                        elif resolution == "conflict_tombstone":
                            conflicts.append({
                                "entity_type": etype,
                                "entity_id": eid,
                                "resolution": "tombstone",
                            })
                        applied.append({
                            "entity_type": etype,
                            "entity_id": eid,
                            "action": action,
                        })
                        await self._write_audit(
                            "push", etype, eid,
                            details=f"action={action} resolution={resolution}",
                        )
                except Exception as exc:
                    logger.warning("sync push note event failed: %s", exc)
                    errors.append({
                        "entity_type": etype,
                        "entity_id": eid,
                        "error": str(exc),
                    })
                continue

            model = ENTITY_REGISTRY[etype]["model"]
            try:
                async with self.db.begin_nested():
                    resolution = await self._apply_event(
                        model, etype, eid, action, payload, client_ts,
                    )
                    if resolution == "conflict_local":
                        conflicts.append({
                            "entity_type": etype,
                            "entity_id": eid,
                            "resolution": "local",
                        })
                    elif resolution == "conflict_remote":
                        conflicts.append({
                            "entity_type": etype,
                            "entity_id": eid,
                            "resolution": "remote",
                        })
                    elif resolution == "conflict_tombstone":
                        conflicts.append({
                            "entity_type": etype,
                            "entity_id": eid,
                            "resolution": "tombstone",
                        })
                    elif resolution == "conflict_circular_ref":
                        conflicts.append({
                            "entity_type": etype,
                            "entity_id": eid,
                            "resolution": "circular_ref",
                        })
                    applied.append({
                        "entity_type": etype,
                        "entity_id": eid,
                        "action": action,
                    })
                    await self._write_audit(
                        "push", etype, eid,
                        details=f"action={action} resolution={resolution}",
                    )
            except Exception as exc:
                logger.warning("sync push event failed: %s", exc)
                errors.append({
                    "entity_type": etype,
                    "entity_id": eid,
                    "error": str(exc),
                })

        # D-4: batched audit flush — one flush for all events in this push().
        await self._flush_pending_audits()

        return {
            "applied": applied,
            "conflicts": conflicts,
            "errors": errors,
            "server_time": utc_now_iso(),
        }

    async def _apply_event(
        self,
        model: type,
        etype: str,
        eid: str,
        action: str,
        payload: dict[str, Any],
        client_ts: str,
    ) -> str:
        """Apply a single event inside a SAVEPOINT.

        Returns one of:
            ``"ok"``                    — event applied cleanly
            ``"conflict_local"``        — LWW resolved to local (no-op)
            ``"conflict_remote"``       — LWW resolved to remote (applied)
            ``"conflict_tombstone"``    — entity is tombstoned, create/update rejected
            ``"conflict_circular_ref"`` — folder parent_id would create a cycle
        """
        client_ts_n = sanitize_zero_time(
            normalize_timestamp(client_ts), now=utc_now_iso()
        )

        # C2: Strip client-only and protected fields from payload.
        payload = strip_client_fields(payload, etype)

        # C1: Anti-resurrection — reject create/update for tombstoned entities.
        if action in ("create", "update"):
            tomb = await TombstoneService(self.db).exists(etype, eid)
            if tomb is not None:
                return "conflict_tombstone"

        if action == "create":
            # C3: Folder circular reference detection on create.
            if etype == "folder" and payload.get("parent_id"):
                if await check_folder_circular_ref(self.db, eid, payload["parent_id"]):
                    return "conflict_circular_ref"
            data = dict(payload)
            data["id"] = eid
            if "updated_at" in data:
                data["updated_at"] = sanitize_zero_time(
                    normalize_timestamp(data["updated_at"]),
                    now=client_ts_n,
                )
            else:
                data["updated_at"] = client_ts_n
            obj = model(**data)
            self.db.add(obj)
            await self.db.flush()
            return "ok"

        if action == "update":
            obj = await self.db.get(model, eid)
            if obj is None:
                # Idempotent upsert — but never resurrect a tombstoned entity.
                tomb = await TombstoneService(self.db).exists(etype, eid)
                if tomb is not None:
                    return "conflict_tombstone"
                data = dict(payload)
                data["id"] = eid
                data["updated_at"] = client_ts_n
                obj = model(**data)
                self.db.add(obj)
                await self.db.flush()
                return "ok"
            decision = check_lww_conflict(obj, client_ts_n)
            if decision == "local":
                return "conflict_local"
            # C3: Folder circular reference detection.
            if etype == "folder" and "parent_id" in payload:
                new_parent = payload["parent_id"]
                if await check_folder_circular_ref(self.db, eid, new_parent):
                    return "conflict_circular_ref"
            # Apply remote update.
            for k, v in payload.items():
                setattr(obj, k, v)
            obj.updated_at = client_ts_n
            if hasattr(obj, "version"):
                obj.version = (obj.version or 0) + 1
            await self.db.flush()
            return "conflict_remote"

        if action == "delete":
            obj = await self.db.get(model, eid)
            if obj is not None:
                await self.db.delete(obj)
                await self.db.flush()
            # M1: Record tombstone so pull/full propagates deletion to peers.
            await TombstoneService(self.db).create(etype, eid)
            return "ok"

        raise ValueError(f"Unknown action: {action}")

    # ----------------------------------------------------------------- #
    # _push_note_event (note-specific event handling via NoteService)
    # ----------------------------------------------------------------- #

    async def _push_note_event(
        self,
        etype: str,
        eid: str,
        action: str,
        payload: dict[str, Any],
        client_ts: str,
    ) -> str:
        """Apply a note event via NoteService(sync_mode=True).

        Routes note events through NoteService so the .md file and DB
        row stay consistent. Returns one of:
            ``"ok"``                    — event applied cleanly
            ``"conflict_local"``        — LWW resolved to local (no-op)
            ``"conflict_remote"``       — LWW resolved to remote (applied)
            ``"conflict_tombstone"``    — entity is tombstoned, create/update rejected
        """
        from app.services.note import NoteService

        client_ts_n = sanitize_zero_time(
            normalize_timestamp(client_ts), now=utc_now_iso()
        )

        # C2: Strip client-only and protected fields from payload.
        payload = strip_client_fields(payload, etype)

        # C1: Anti-resurrection — reject create/update for tombstoned entities.
        if action in ("create", "update"):
            tomb = await TombstoneService(self.db).exists(etype, eid)
            if tomb is not None:
                return "conflict_tombstone"

        if action == "create":
            data = dict(payload)
            data["id"] = eid
            # sync_mode=True preserves client updated_at/version/created_at.
            note_svc = NoteService(self.db, self.fs, sync_mode=True)
            await note_svc.create(data)
            return "ok"

        if action == "update":
            # LWW check before delegating to NoteService.
            existing = await self.db.get(Note, eid)
            if existing is None:
                tomb = await TombstoneService(self.db).exists(etype, eid)
                if tomb is not None:
                    return "conflict_tombstone"
                # Treat as create (idempotent upsert).
                data = dict(payload)
                data["id"] = eid
                note_svc = NoteService(self.db, self.fs, sync_mode=True)
                await note_svc.create(data)
                return "ok"
            decision = check_lww_conflict(existing, client_ts_n)
            if decision == "local":
                return "conflict_local"
            # Remote wins: apply update via NoteService.
            note_svc = NoteService(self.db, self.fs, sync_mode=True)
            update_data = dict(payload)
            update_data["updated_at"] = client_ts_n
            await note_svc.update(eid, update_data)
            return "conflict_remote"

        if action == "delete":
            note_svc = NoteService(self.db, self.fs, sync_mode=True)
            await note_svc.delete(eid)
            # sync_mode skips tombstone inside NoteService; push delete is authoritative.
            await TombstoneService(self.db).create(etype, eid)
            return "ok"

        raise ValueError(f"Unknown action: {action}")

    # ----------------------------------------------------------------- #
    # pull
    # ----------------------------------------------------------------- #

    async def pull(
        self,
        since: str = "",
        limit: int = 1000,
        *,
        tombstones_since_override: str | None = None,
    ) -> dict[str, Any]:
        """Return all entities updated after *since* grouped by pull_key.

        Each entity group is capped at *limit* rows; one extra row is
        fetched per group to detect ``has_more``. Tombstones with
        ``deleted_at > since`` are returned under the ``tombstones`` key.
        ``next_since`` is the maximum ``updated_at`` observed across
        all returned rows (empty string if no rows).

        D-3 optimization: ``tombstones_since_override`` lets ``full()``
        reuse ``pull()``'s single tombstones query instead of issuing
        a second one. ``None`` means "honor *since*" (default pull
        behaviour); an empty string means "return ALL tombstones"
        (used by ``full()``).
        """
        from app.services.sync_safety import serialize_entity

        since_n = normalize_timestamp(since)
        result: dict[str, Any] = {
            "server_time": utc_now_iso(),
            "has_more": False,
            "tombstones_has_more": False,  # D-5: tombstones pagination flag
            "next_since": "",
            "tombstones": [],
        }
        max_ts = since_n

        for entry in ENTITY_REGISTRY.values():
            model = entry["model"]
            pull_key = entry["pull_key"]
            q = select(model)
            if since_n:
                q = q.where(model.updated_at > since_n)
            q = q.order_by(model.updated_at.asc()).limit(limit + 1)
            rows = (await self.db.execute(q)).scalars().all()
            if len(rows) > limit:
                result["has_more"] = True
                rows = rows[:limit]
            serialized = [serialize_entity(r) for r in rows]
            result[pull_key] = serialized
            for r in rows:
                ts = normalize_timestamp(r.updated_at or "")
                if ts and ts > max_ts:
                    max_ts = ts

        # Tombstones — use override if provided, else honour *since*.
        tombstones_since = (
            since if tombstones_since_override is None else tombstones_since_override
        )
        tombstones, tomb_has_more = await self._fetch_tombstones(
            since=tombstones_since, limit=limit,
        )
        result["tombstones"] = [
            {
                "entity_type": t.entity_type,
                "entity_id": t.entity_id,
                "deleted_at": normalize_timestamp(t.deleted_at or ""),
            }
            for t in tombstones
        ]
        result["tombstones_has_more"] = tomb_has_more
        # D-5: surface tombstones overflow on the top-level has_more flag too,
        # so clients polling with has_more=True know to keep fetching.
        if tomb_has_more:
            result["has_more"] = True
        for t in tombstones:
            ts = normalize_timestamp(t.deleted_at or "")
            if ts and ts > max_ts:
                max_ts = ts

        result["next_since"] = max_ts
        await self._write_audit(
            "pull", "batch", "",
            details=f"since={since} limit={limit} has_more={result['has_more']}",
        )
        # D-4: batched audit flush — one flush for this pull() call.
        await self._flush_pending_audits()
        return result

    async def _fetch_tombstones(
        self, since: str = "", limit: int = 1000
    ) -> tuple[list[Any], bool]:
        """Return ``(tombstone_rows, has_more)`` optionally filtered by *since*.

        D-3: extracted helper so ``pull()`` and ``full()`` share a single
        tombstones query path (no duplicate scans).

        D-5: added *limit* (default 1000) to prevent unbounded result sets
        when tombstones accumulate over time (90-day TTL). Fetches
        ``limit + 1`` rows to detect ``has_more`` without an extra COUNT.

        If *since* is empty (or unnormalizable to a non-empty string),
        returns ALL tombstones — used by ``full()``.
        """
        since_n = normalize_timestamp(since) if since else ""
        tq = select(Tombstone)
        if since_n:
            tq = tq.where(Tombstone.deleted_at > since_n)
        tq = tq.order_by(Tombstone.deleted_at.asc()).limit(limit + 1)
        rows = (await self.db.execute(tq)).scalars().all()
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]
        return rows, has_more

    # ----------------------------------------------------------------- #
    # full
    # ----------------------------------------------------------------- #

    async def full(self, since: str = "", limit: int = 1000) -> dict[str, Any]:
        """Like pull() but tombstones are returned regardless of *since*.

        Sets ``is_full=True`` so clients can distinguish a full sync
        response from an incremental pull response.

        D-3 optimization: delegates to ``pull()`` with
        ``tombstones_since_override=""`` so the tombstones query is
        executed exactly once (the previous implementation issued a
        second SELECT over Tombstones just to override the filtered
        result).
        """
        result = await self.pull(
            since=since,
            limit=limit,
            tombstones_since_override="",
        )
        result["is_full"] = True
        return result

    # ----------------------------------------------------------------- #
    # status
    # ----------------------------------------------------------------- #

    async def status(self) -> dict[str, Any]:
        """Return server time + per-entity counts + tombstone count.

        D-2 optimization: collapsed 15 sequential COUNT queries (14 entities
        + tombstones) into a single UNION ALL query — one round-trip to the
        DB instead of 15.

        Table names come from ORM ``__tablename__`` (hard-coded in models,
        not user input), so injecting them into the SQL text is safe.
        """
        from sqlalchemy import text

        # Build one UNION ALL query covering all 14 entities + tombstones.
        select_parts: list[str] = []
        pull_keys: list[str] = []
        for entry in ENTITY_REGISTRY.values():
            pull_key = entry["pull_key"]
            table_name = entry["model"].__tablename__
            select_parts.append(
                f"SELECT '{pull_key}' AS k, COUNT(*) AS c FROM {table_name}"
            )
            pull_keys.append(pull_key)
        # Append tombstone count as the last UNION ALL member.
        select_parts.append(
            f"SELECT '__tombstones__' AS k, COUNT(*) AS c FROM {Tombstone.__tablename__}"
        )
        sql = text(" UNION ALL ".join(select_parts))
        result = (await self.db.execute(sql)).all()

        entity_counts: dict[str, int] = {pk: 0 for pk in pull_keys}
        tombstone_count = 0
        for row in result:
            k, c = row[0], int(row[1] or 0)
            if k == "__tombstones__":
                tombstone_count = c
            elif k in entity_counts:
                entity_counts[k] = c
        return {
            "server_time": utc_now_iso(),
            "entity_counts": entity_counts,
            "tombstone_count": tombstone_count,
        }

    # ----------------------------------------------------------------- #
    # _write_audit (best-effort audit log)
    # ----------------------------------------------------------------- #

    async def _write_audit(
        self,
        event_type: str,
        entity_type: str,
        entity_id: str,
        details: str = "",
    ) -> None:
        """Queue an audit log row for batched flush.

        D-4 optimization: previously flushed every audit entry
        individually, causing N round-trips for N events. Now we
        append to ``_pending_audits`` and let ``push()`` / ``pull()``
        flush the whole batch via ``_flush_pending_audits()`` at the
        end of the call.

        Audit failures are logged but never propagate — audit is
        diagnostics-only and must not break the main sync flow.
        Does NOT call ``db.rollback()`` because that would undo the
        event changes already applied in the surrounding SAVEPOINT.
        """
        from app.models.sync_audit_log import SyncAuditLog

        try:
            self._pending_audits.append(SyncAuditLog(
                event_type=event_type,
                entity_type=entity_type,
                entity_id=entity_id,
                details=details,
            ))
        except Exception as exc:
            logger.warning(
                "sync audit queue failed (event=%s etype=%s eid=%s): %s",
                event_type, entity_type, entity_id, exc,
            )

    async def _flush_pending_audits(self) -> None:
        """Flush all queued audit entries in one go (best-effort).

        D-4: collapses N per-event ``flush()`` calls into a single
        ``add_all`` + ``flush`` at the end of ``push()`` / ``pull()``.
        """
        if not self._pending_audits:
            return
        pending = self._pending_audits
        self._pending_audits = []  # Reset before flush so failures don't double-add.
        try:
            self.db.add_all(pending)
            await self.db.flush()
        except Exception as exc:
            logger.warning(
                "sync audit batch flush failed (%d entries): %s",
                len(pending), exc,
            )
