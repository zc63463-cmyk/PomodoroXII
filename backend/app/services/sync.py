"""SyncService — push/pull/full/status for cross-device synchronization.

Iron rules:
- Does NOT import FastAPI (MCP-consumable).
- Only flushes, never commits (routes commit).
- Uses SAVEPOINT (db.begin_nested) to isolate per-event failures.
- Note entities are routed through NoteService once C6 lands; until then
  the note entity path uses the same ORM logic as other entities.
"""

from __future__ import annotations

import hashlib
import json
import logging
import pickle
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, delete, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import (
    SyncCursorExpiredError,
    SyncSnapshotExpiredError,
    ValidationError,
)
from app.models.note import Note
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncSnapshot, SyncSnapshotChunk
from app.models.tombstone import Tombstone
from app.registry.sync_registry import build_sync_registry
from app.services.serializers import serialize_entity
from app.services.sync_entity_types import canonicalize_entity_type
from app.services.sync_outbox import (
    get_current_cursor,
    get_retention_floor,
    record_sync_event,
)
from app.services.sync_safety import (
    check_folder_circular_ref,
    check_lww_conflict,
    normalize_timestamp,
    sanitize_zero_time,
    strip_client_fields,
)
from app.services.sync_snapshot_chunks import (
    EncodedSnapshotChunk,
    SnapshotChunkEncoder,
    decode_snapshot_chunk,
)
from app.services.time import utc_now, utc_now_iso
from app.services.tombstone import TombstoneService

logger = logging.getLogger(__name__)

SYNC_SNAPSHOT_TTL = timedelta(hours=1)
SNAPSHOT_SCAN_MAX_ATTEMPTS = 3


class _NoteSnapshotConflict(Exception):
    """The note body changed relative to the pinned database snapshot."""


# --------------------------------------------------------------------------- #
# Entity registry — derived from REGISTRY (single source of truth)
# --------------------------------------------------------------------------- #
# P2.4: replaced 14 hardcoded ORM imports + camelCase dict with
# build_sync_registry() which derives from REGISTRY.list_sync_enabled().
# The build is lazy (runs at module import); tests in test_build_sync_registry.py
# verify parity with the legacy hardcoded dict.

ENTITY_REGISTRY: dict[str, dict[str, Any]] = build_sync_registry()


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
            etype_raw = event.get("entity_type", "")
            # P1-2: canonicalize snake_case (registry name) -> camelCase
            # (ENTITY_REGISTRY key) so clients using either convention work.
            etype = canonicalize_entity_type(etype_raw) or ""
            eid = event.get("entity_id", "")
            action = event.get("action", "")
            payload = event.get("payload", {}) or {}
            client_ts = event.get("client_updated_at", "") or ""

            if etype not in ENTITY_REGISTRY:
                errors.append({
                    "entity_type": etype_raw,
                    "entity_id": eid,
                    "error": f"Unknown entity_type: {etype_raw}",
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
                        elif resolution == "conflict_tombstone":
                            conflicts.append({
                                "entity_type": etype,
                                "entity_id": eid,
                                "resolution": "tombstone",
                            })
                        # P1-1: conflict_remote represents a successful
                        # application of the remote event, so it belongs ONLY
                        # in applied (with resolution='remote' for client
                        # visibility). conflicts is reserved for rejected
                        # events (local/tombstone).
                        if resolution in ("ok", "conflict_remote"):
                            await self._record_applied_event(
                                etype, eid, action, payload,
                            )
                            applied_item: dict[str, str] = {
                                "entity_type": etype,
                                "entity_id": eid,
                                "action": action,
                            }
                            if resolution == "conflict_remote":
                                applied_item["resolution"] = "remote"
                            applied.append(applied_item)
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
                    # P1-1: conflict_remote represents a successful
                    # application of the remote event, so it belongs ONLY
                    # in applied (with resolution='remote' for client
                    # visibility). conflicts is reserved for rejected
                    # events (local/tombstone/circular_ref).
                    if resolution in ("ok", "conflict_remote"):
                        await self._record_applied_event(
                            etype, eid, action, payload,
                        )
                        applied_item: dict[str, str] = {
                            "entity_type": etype,
                            "entity_id": eid,
                            "action": action,
                        }
                        if resolution == "conflict_remote":
                            applied_item["resolution"] = "remote"
                        applied.append(applied_item)
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

    async def _record_applied_event(
        self,
        entity_type: str,
        entity_id: str,
        action: str,
        payload: dict[str, Any],
    ) -> None:
        event_payload: dict[str, Any] | None = None
        if action != "delete":
            entry = ENTITY_REGISTRY[entity_type]
            obj = await self.db.get(entry["model"], entity_id)
            if obj is not None:
                event_payload = serialize_entity(obj)
                if entity_type == "note":
                    body = None
                    if self.fs is not None:
                        try:
                            body = await self.fs.read_note(entity_id)
                        except (KeyError, FileNotFoundError):
                            pass
                    event_payload["content"] = body or ""
                    event_payload["content_missing"] = body is None
            else:
                # Entity was concurrently deleted after push applied it.
                # Skip recording a phantom update event to prevent clients
                # from receiving a snapshot of a non-existent entity.
                return
        await record_sync_event(
            self.db,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,  # type: ignore[arg-type]
            payload=event_payload,
        )

    async def _check_preflight(
        self,
        etype: str,
        eid: str,
        action: str,
        payload: dict[str, Any],
        client_ts: str,
    ) -> tuple[str | None, str, dict[str, Any]]:
        """Shared pre-flight checks for _apply_event and _push_note_event.

        Performs:
        1. Timestamp sanitization (zero-time detection + normalization).
        2. Client field stripping (C2).
        3. Tombstone anti-resurrection check (C1) for create/update.

        Returns ``(resolution, client_ts_n, payload)`` where *resolution*
        is ``None`` if all checks pass, or a conflict string (e.g.
        ``"conflict_tombstone"``) if the event should be rejected.
        """
        client_ts_n = sanitize_zero_time(
            normalize_timestamp(client_ts), now=utc_now_iso()
        )
        payload = strip_client_fields(payload, etype)

        if action in ("create", "update"):
            tomb = await TombstoneService(self.db).exists(etype, eid)
            if tomb is not None:
                return "conflict_tombstone", client_ts_n, payload

        return None, client_ts_n, payload

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
        resolution, client_ts_n, payload = await self._check_preflight(
            etype, eid, action, payload, client_ts,
        )
        if resolution is not None:
            return resolution

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

        resolution, client_ts_n, payload = await self._check_preflight(
            etype, eid, action, payload, client_ts,
        )
        if resolution is not None:
            return resolution

        if action == "create":
            data = dict(payload)
            data["id"] = eid
            # P1-3: preserve client updated_at so subsequent LWW checks compare
            # against the client timestamp, not server-now.
            data["updated_at"] = client_ts_n
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
                data["updated_at"] = client_ts_n
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
            await note_svc.update(eid, update_data, updated_at_override=client_ts_n)
            return "conflict_remote"

        if action == "delete":
            note_svc = NoteService(self.db, self.fs, sync_mode=True)
            await note_svc.delete(eid, hard=True)
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
        since_id: str = "",
        tombstone_since_id: str = "",
        tombstones_since_override: str | None = None,
        cursor: int | None = None,
    ) -> dict[str, Any]:
        """Return all entities updated after *since* grouped by pull_key.

        Each entity group is capped at *limit* rows; one extra row is
        fetched per group to detect ``has_more``. Tombstones with
        ``deleted_at > since`` are returned under the ``tombstones`` key.
        ``next_since`` is the maximum ``updated_at`` observed across
        all returned rows (empty string if no rows).

        The composite cursor ``(since, since_id)`` guarantees that rows
        sharing the same ``updated_at`` can be paged without skipping or
        repeating: the filter is ``updated_at > since`` OR
        ``(updated_at == since AND id > since_id)``. Omitting ``since_id``
        preserves the legacy behaviour.

        D-3 optimization: ``tombstones_since_override`` lets ``full()``
        reuse ``pull()``'s single tombstones query instead of issuing
        a second one. ``None`` means "honor *since*" (default pull
        behaviour); an empty string means "return ALL tombstones"
        (used by ``full()``).
        """
        if cursor is not None:
            return await self._pull_by_cursor(cursor=cursor, limit=limit)

        since_n = normalize_timestamp(since)
        result: dict[str, Any] = {
            "server_time": utc_now_iso(),
            "has_more": False,
            "tombstones_has_more": False,  # D-5: tombstones pagination flag
            "next_since": "",
            "next_since_id": "",
            "tombstones": [],
        }
        max_ts = since_n
        # P1 hotfix: track the latest timestamp/id seen from *entities* separately
        # from the global max_ts (which may be advanced by tombstones). This keeps
        # next_since_id alive across multiple pages that all share the same
        # updated_at, instead of dropping it whenever max_ts == since_n.
        latest_entity_ts = ""
        latest_entity_id = ""
        # Track tombstone cursor separately so next_tombstone_since_id stays
        # alive across multiple pages sharing the same deleted_at.
        latest_tomb_ts = ""
        latest_tomb_id = ""

        for entry in ENTITY_REGISTRY.values():
            model = entry["model"]
            pull_key = entry["pull_key"]
            q = select(model)
            if since_n:
                if since_id:
                    q = q.where(
                        or_(
                            model.updated_at > since_n,
                            and_(model.updated_at == since_n, model.id > since_id),
                        )
                    )
                else:
                    q = q.where(model.updated_at > since_n)
            q = q.order_by(model.updated_at.asc(), model.id.asc()).limit(limit + 1)
            rows = (await self.db.execute(q)).scalars().all()
            if len(rows) > limit:
                result["has_more"] = True
                rows = rows[:limit]
            serialized = [serialize_entity(r) for r in rows]
            # P0-1: Note content lives in the filesystem, not the ORM row.
            # Inject `content` / `content_missing` so devices pulling changes
            # receive the full Markdown body, not just metadata.
            if model is Note and serialized:
                note_ids = [r.id for r in rows]
                if self.fs is not None:
                    contents = await self.fs.read_notes_batch(note_ids)
                else:
                    contents = [None] * len(note_ids)
                for note_payload, body in zip(serialized, contents):
                    if body is None:
                        note_payload["content"] = ""
                        note_payload["content_missing"] = True
                    else:
                        note_payload["content"] = body
                        note_payload["content_missing"] = False
            result[pull_key] = serialized
            for r in rows:
                ts = normalize_timestamp(r.updated_at or "")
                if ts and ts > max_ts:
                    max_ts = ts
                if ts and (
                    ts > latest_entity_ts
                    or (ts == latest_entity_ts and r.id > latest_entity_id)
                ):
                    latest_entity_ts = ts
                    latest_entity_id = r.id

        # Tombstones — use override if provided, else honour *since*.
        tombstones_since = (
            since if tombstones_since_override is None else tombstones_since_override
        )
        tombstones, tomb_has_more = await self._fetch_tombstones(
            since=tombstones_since, limit=limit, since_id=tombstone_since_id,
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
            if ts and (
                ts > latest_tomb_ts
                or (ts == latest_tomb_ts and t.entity_id > latest_tomb_id)
            ):
                latest_tomb_ts = ts
                latest_tomb_id = t.entity_id

        result["next_since"] = max_ts
        # Only expose next_since_id when the latest entity timestamp equals the
        # global cursor. If the global cursor was advanced solely by tombstones,
        # leave next_since_id empty because tombstones do not participate in the
        # (since, since_id) composite key.
        if latest_entity_ts and latest_entity_ts == max_ts:
            result["next_since_id"] = latest_entity_id
        # Expose next_tombstone_since_id when tombstones share the global cursor.
        if latest_tomb_ts and latest_tomb_ts == max_ts:
            result["next_tombstone_since_id"] = latest_tomb_id
        await self._write_audit(
            "pull", "batch", "",
            details=(
                f"since={since} since_id={since_id} limit={limit} "
                f"has_more={result['has_more']}"
            ),
        )
        # D-4: batched audit flush — one flush for this pull() call.
        await self._flush_pending_audits()
        return result

    async def _pull_by_cursor(self, *, cursor: int, limit: int) -> dict[str, Any]:
        floor = await get_retention_floor(self.db)
        current_cursor = await get_current_cursor(self.db)
        if cursor < floor:
            raise SyncCursorExpiredError(
                floor=floor,
                current_cursor=current_cursor,
            )
        rows = (
            await self.db.execute(
                select(SyncOutbox)
                .where(SyncOutbox.id > cursor)
                .order_by(SyncOutbox.id.asc())
                .limit(limit + 1)
            )
        ).scalars().all()
        has_more = len(rows) > limit
        scanned = rows[:limit]
        result: dict[str, Any] = {
            "server_time": utc_now_iso(),
            "has_more": has_more,
            "tombstones_has_more": False,
            "next_since": "",
            "next_since_id": "",
            "next_tombstone_since_id": "",
            "next_cursor": scanned[-1].id if scanned else cursor,
            "cursor_version": 2,
            "tombstones": [],
        }
        for entry in ENTITY_REGISTRY.values():
            result[entry["pull_key"]] = []

        latest: dict[tuple[str, str], SyncOutbox] = {}
        order: list[tuple[str, str]] = []
        for event in scanned:
            key = (event.entity_type, event.entity_id)
            if key not in latest:
                order.append(key)
            latest[key] = event

        note_payloads: list[dict[str, Any]] = []
        for key in order:
            event = latest[key]
            entry = ENTITY_REGISTRY.get(event.entity_type)
            if entry is None:
                continue
            if event.action == "delete":
                # Use the event timestamp as deleted_at.  This may differ
                # slightly from the Tombstone.deleted_at used by the legacy
                # cursor-less path, but both are server-side ISO timestamps
                # and clients treat this as a monotonic ordering key, not an
                # exact source-of-truth deletion time.
                result["tombstones"].append({
                    "entity_type": event.entity_type,
                    "entity_id": event.entity_id,
                    "deleted_at": normalize_timestamp(event.created_at or ""),
                })
                continue
            try:
                payload = json.loads(event.payload or "{}")
            except (json.JSONDecodeError, TypeError):
                payload = {}
            if not payload:
                obj = await self.db.get(entry["model"], event.entity_id)
                if obj is None:
                    continue
                payload = serialize_entity(obj)
            result[entry["pull_key"]].append(payload)
            if event.entity_type == "note":
                note_payloads.append(payload)

        missing_note_payloads = [
            payload for payload in note_payloads if "content" not in payload
        ]
        if missing_note_payloads:
            note_ids = [payload["id"] for payload in missing_note_payloads]
            if self.fs is not None:
                contents = await self.fs.read_notes_batch(note_ids)
            else:
                contents = [None] * len(note_ids)
            for payload, body in zip(missing_note_payloads, contents):
                payload["content"] = body or ""
                payload["content_missing"] = body is None

        await self._write_audit(
            "pull", "batch", "",
            details=f"cursor={cursor} limit={limit} has_more={has_more}",
        )
        await self._flush_pending_audits()
        return result

    async def _fetch_tombstones(
        self,
        since: str = "",
        limit: int = 1000,
        *,
        since_id: str = "",
    ) -> tuple[list[Any], bool]:
        """Return ``(tombstone_rows, has_more)`` optionally filtered by *since*.

        D-3: extracted helper so ``pull()`` and ``full()`` share a single
        tombstones query path (no duplicate scans).

        D-5: added *limit* (default 1000) to prevent unbounded result sets
        when tombstones accumulate over time (90-day TTL). Fetches
        ``limit + 1`` rows to detect ``has_more`` without an extra COUNT.

        The composite cursor ``(since, since_id)`` mirrors entity pagination:
        ``(deleted_at > since) OR (deleted_at == since AND entity_id > since_id)``.
        Omitting *since_id* preserves the legacy behaviour.

        If *since* is empty (or unnormalizable to a non-empty string),
        returns ALL tombstones — used by ``full()``.
        """
        since_n = normalize_timestamp(since) if since else ""
        tq = select(Tombstone)
        if since_n:
            if since_id:
                tq = tq.where(
                    or_(
                        Tombstone.deleted_at > since_n,
                        and_(Tombstone.deleted_at == since_n, Tombstone.entity_id > since_id),
                    )
                )
            else:
                tq = tq.where(Tombstone.deleted_at > since_n)
        elif since_id:
            # No timestamp constraint (e.g. full() with override=""), but
            # entity_id cursor still lets clients page through all tombstones.
            tq = tq.where(Tombstone.entity_id > since_id)
        tq = tq.order_by(Tombstone.deleted_at.asc(), Tombstone.entity_id.asc()).limit(limit + 1)
        rows = (await self.db.execute(tq)).scalars().all()
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]
        return rows, has_more

    # ----------------------------------------------------------------- #
    # full
    # ----------------------------------------------------------------- #

    async def full(
        self,
        since: str = "",
        limit: int = 1000,
        *,
        since_id: str = "",
        tombstone_since_id: str = "",
        cursor: int | None = None,
        snapshot_token: str | None = None,
        snapshot_offset: int = 0,
    ) -> dict[str, Any]:
        """Return a materialized current-state snapshot for cursor v2 clients."""
        if cursor is None:
            result = await self.pull(
                since=since,
                limit=limit,
                since_id=since_id,
                tombstone_since_id=tombstone_since_id,
                tombstones_since_override="",
            )
            result["is_full"] = True
            return result

        if snapshot_token is None:
            if snapshot_offset != 0:
                raise ValidationError("snapshot_offset requires snapshot_token")
            snapshot = await self._create_snapshot()
            snapshot_offset = 0
        else:
            snapshot = await self.db.get(SyncSnapshot, snapshot_token)
            if snapshot is None:
                raise SyncSnapshotExpiredError()
            now_dt = utc_now()
            try:
                if snapshot.expires_at:
                    expires_at = datetime.strptime(
                        snapshot.expires_at, "%Y-%m-%dT%H:%M:%SZ"
                    ).replace(tzinfo=timezone.utc)
                else:
                    created_at = datetime.strptime(
                        snapshot.created_at, "%Y-%m-%dT%H:%M:%SZ"
                    ).replace(tzinfo=timezone.utc)
                    expires_at = created_at + SYNC_SNAPSHOT_TTL
            except ValueError as exc:
                raise SyncSnapshotExpiredError(
                    expired_snapshot_token=snapshot.token
                ) from exc
            if expires_at <= now_dt:
                # Report the expired token without mutating the caller's session.
                # The HTTP boundary performs cleanup in a dedicated transaction.
                raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)

        if snapshot.status != "ready":
            raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)
        if snapshot_offset < 0:
            raise ValidationError("snapshot_offset must be non-negative")
        if snapshot.format == "legacy-json-v1":
            try:
                items = json.loads(snapshot.payload)
            except (TypeError, json.JSONDecodeError) as exc:
                raise SyncSnapshotExpiredError(
                    expired_snapshot_token=snapshot.token
                ) from exc
            if not isinstance(items, list):
                raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)
            if snapshot_offset > len(items):
                raise ValidationError("snapshot_offset exceeds snapshot size")
            page_items = items[snapshot_offset:snapshot_offset + limit]
            total_items = len(items)
        elif snapshot.format == "gzip-chunks-v1":
            if snapshot_offset > snapshot.item_count:
                raise ValidationError("snapshot_offset exceeds snapshot size")
            page_items = await self._read_chunk_page(
                snapshot=snapshot,
                offset=snapshot_offset,
                limit=limit,
            )
            total_items = snapshot.item_count
        else:
            raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)
        next_offset = snapshot_offset + len(page_items)
        has_more = next_offset < total_items
        result: dict[str, Any] = {
            "server_time": utc_now_iso(),
            "has_more": has_more,
            "tombstones_has_more": False,
            "next_since": "",
            "next_since_id": "",
            "next_tombstone_since_id": "",
            "next_cursor": snapshot.cursor,
            "cursor_version": 2,
            "snapshot_token": snapshot.token,
            "snapshot_offset": next_offset,
            "tombstones": [],
            "is_full": True,
        }
        for entry in ENTITY_REGISTRY.values():
            result[entry["pull_key"]] = []
        valid_pull_keys = {entry["pull_key"] for entry in ENTITY_REGISTRY.values()}
        try:
            for item in page_items:
                if not isinstance(item, dict) or not isinstance(item.get("payload"), dict):
                    raise ValueError("snapshot item must contain an object payload")
                kind = item.get("kind")
                if kind == "tombstone":
                    result["tombstones"].append(item["payload"])
                elif kind == "entity":
                    pull_key = item.get("pull_key")
                    if pull_key not in valid_pull_keys:
                        raise ValueError("snapshot entity has an unknown pull_key")
                    result[pull_key].append(item["payload"])
                else:
                    raise ValueError("snapshot item has an unknown kind")
        except (TypeError, ValueError, KeyError) as exc:
            raise SyncSnapshotExpiredError(
                expired_snapshot_token=snapshot.token
            ) from exc
        return result

    async def _read_chunk_page(
        self,
        *,
        snapshot: SyncSnapshot,
        offset: int,
        limit: int,
    ) -> list[dict[str, Any]]:
        # Validate the complete manifest at the two durable boundaries: before
        # returning the first page and before returning the terminal page. This
        # keeps continuation requests page-bounded while ensuring a client can
        # never complete and ACK a snapshot whose manifest root is invalid.
        validate_manifest = offset == 0 or offset + limit >= snapshot.item_count
        if validate_manifest:
            manifest_rows = await self.db.stream(
                select(
                    SyncSnapshotChunk.chunk_index,
                    SyncSnapshotChunk.item_start,
                    SyncSnapshotChunk.item_count,
                    SyncSnapshotChunk.uncompressed_bytes,
                    SyncSnapshotChunk.compressed_bytes,
                    SyncSnapshotChunk.checksum,
                )
                .where(SyncSnapshotChunk.snapshot_token == snapshot.token)
                .order_by(SyncSnapshotChunk.chunk_index)
            )
            manifest_hasher = hashlib.sha256()
            manifest_valid = True
            chunk_count = item_count = expected_start = 0
            uncompressed_bytes = compressed_bytes = 0
            try:
                async for row in manifest_rows:
                    checksum = row.checksum
                    if (
                        row.chunk_index != chunk_count
                        or row.item_start != expected_start
                        or not isinstance(checksum, str)
                        or len(checksum) != 64
                        or any(character not in "0123456789abcdef" for character in checksum)
                    ):
                        manifest_valid = False
                        break
                    chunk_count += 1
                    item_count += row.item_count
                    expected_start += row.item_count
                    uncompressed_bytes += row.uncompressed_bytes
                    compressed_bytes += row.compressed_bytes
                    manifest_hasher.update(checksum.encode("ascii"))
            except (TypeError, UnicodeEncodeError):
                manifest_valid = False
            if (
                not manifest_valid
                or chunk_count != snapshot.chunk_count
                or item_count != snapshot.item_count
                or uncompressed_bytes != snapshot.uncompressed_bytes
                or compressed_bytes != snapshot.compressed_bytes
                or manifest_hasher.hexdigest() != snapshot.checksum
                or (snapshot.chunk_count == 0 and snapshot.item_count != 0)
            ):
                raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)
        if offset == snapshot.item_count:
            return []
        start_index = await self.db.scalar(
            select(SyncSnapshotChunk.chunk_index)
            .where(
                SyncSnapshotChunk.snapshot_token == snapshot.token,
                SyncSnapshotChunk.item_start <= offset,
            )
            .order_by(SyncSnapshotChunk.item_start.desc())
            .limit(1)
        )
        if start_index is None:
            raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)
        # A size-sealed chunk may contain only one large item, so the strict
        # upper bound for a page is one chunk per requested item plus one edge.
        max_chunks = limit + 1
        rows = (
            await self.db.execute(
                select(SyncSnapshotChunk)
                .where(
                    SyncSnapshotChunk.snapshot_token == snapshot.token,
                    SyncSnapshotChunk.chunk_index >= start_index,
                )
                .order_by(SyncSnapshotChunk.chunk_index)
                .limit(max_chunks)
            )
        ).scalars().all()
        page: list[dict[str, Any]] = []
        try:
            expected_position = offset
            for chunk in rows:
                chunk_end = chunk.item_start + chunk.item_count
                if not chunk.item_start <= expected_position < chunk_end:
                    raise ValueError("snapshot page chunk sequence mismatch")
                items = decode_snapshot_chunk(
                    compressed_payload=chunk.compressed_payload,
                    checksum=chunk.checksum,
                    expected_uncompressed_bytes=chunk.uncompressed_bytes,
                    expected_compressed_bytes=chunk.compressed_bytes,
                    expected_item_count=chunk.item_count,
                )
                start = expected_position - chunk.item_start
                end = min(offset + limit - chunk.item_start, chunk.item_count)
                page.extend(items[start:end])
                expected_position = chunk.item_start + end
                if expected_position >= offset + limit:
                    break
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("snapshot chunk validation failed", exc_info=exc)
            raise SyncSnapshotExpiredError(
                expired_snapshot_token=snapshot.token
            ) from exc
        if len(page) != min(limit, snapshot.item_count - offset):
            raise SyncSnapshotExpiredError(expired_snapshot_token=snapshot.token)
        return page

    async def _create_snapshot(self) -> SyncSnapshot:
        """Spool one stable read-only scan, then publish it in a short write phase."""
        spool = None
        try:
            for attempt in range(SNAPSHOT_SCAN_MAX_ATTEMPTS):
                candidate_spool = tempfile.TemporaryFile()
                encoder = SnapshotChunkEncoder()
                manifest_hasher = hashlib.sha256()
                chunk_count = 0
                item_count = 0
                uncompressed_bytes = 0
                compressed_bytes = 0

                def spool_chunk(encoded: EncodedSnapshotChunk) -> None:
                    nonlocal chunk_count, uncompressed_bytes, compressed_bytes
                    pickle.dump(encoded, candidate_spool, protocol=pickle.HIGHEST_PROTOCOL)
                    manifest_hasher.update(encoded.checksum.encode("ascii"))
                    chunk_count += 1
                    uncompressed_bytes += encoded.uncompressed_bytes
                    compressed_bytes += encoded.compressed_bytes

                def append_item(item: dict[str, Any]) -> None:
                    nonlocal item_count
                    sealed = encoder.add(item)
                    item_count += 1
                    if sealed is not None:
                        spool_chunk(sealed)

                scan_db = AsyncSession(
                    bind=self.db.bind,
                    expire_on_commit=False,
                    autoflush=False,
                )
                try:
                    try:
                        # aiosqlite's deferred transactions do not pin a read snapshot
                        # until an explicit BEGIN is issued. All paged SELECTs below must
                        # observe the same database generation as snapshot_cursor.
                        await scan_db.execute(text("BEGIN"))
                        snapshot_cursor = await get_current_cursor(scan_db)
                        batch_size = 200
                        for entry in ENTITY_REGISTRY.values():
                            last_id = ""
                            while True:
                                rows = (
                                    await scan_db.execute(
                                        select(entry["model"])
                                        .where(entry["model"].id > last_id)
                                        .order_by(entry["model"].id.asc())
                                        .limit(batch_size)
                                    )
                                ).scalars().all()
                                if not rows:
                                    break
                                serialized = [serialize_entity(row) for row in rows]
                                if entry["model"] is Note:
                                    contents = (
                                        await self.fs.read_notes_batch([row.id for row in rows])
                                        if self.fs is not None
                                        else [None] * len(rows)
                                    )
                                    for row, payload, body in zip(rows, serialized, contents):
                                        payload["content"] = body or ""
                                        payload["content_missing"] = body is None
                                        if body is not None and row.content_hash:
                                            actual_hash = hashlib.sha256(
                                                body.encode("utf-8")
                                            ).hexdigest()
                                            if actual_hash != row.content_hash:
                                                raise _NoteSnapshotConflict(row.id)
                                for payload in serialized:
                                    append_item({
                                        "kind": "entity",
                                        "pull_key": entry["pull_key"],
                                        "payload": payload,
                                    })
                                last_id = rows[-1].id

                        last_tombstone_id = 0
                        while True:
                            tombstones = (
                                await scan_db.execute(
                                    select(Tombstone)
                                    .where(Tombstone.id > last_tombstone_id)
                                    .order_by(Tombstone.id.asc())
                                    .limit(batch_size)
                                )
                            ).scalars().all()
                            if not tombstones:
                                break
                            for tombstone in tombstones:
                                append_item({
                                    "kind": "tombstone",
                                    "payload": {
                                        "entity_type": tombstone.entity_type,
                                        "entity_id": tombstone.entity_id,
                                        "deleted_at": normalize_timestamp(
                                            tombstone.deleted_at or ""
                                        ),
                                    },
                                })
                            last_tombstone_id = tombstones[-1].id
                    finally:
                        await scan_db.close()
                except _NoteSnapshotConflict as exc:
                    candidate_spool.close()
                    if attempt + 1 == SNAPSHOT_SCAN_MAX_ATTEMPTS:
                        raise SyncSnapshotExpiredError() from exc
                    continue
                except BaseException:
                    candidate_spool.close()
                    raise

                spool = candidate_spool
                final_chunk = encoder.finish()
                if final_chunk is not None:
                    spool_chunk(final_chunk)
                break

            created_at = utc_now()
            now = created_at.strftime("%Y-%m-%dT%H:%M:%SZ")
            cutoff = (created_at - SYNC_SNAPSHOT_TTL).strftime("%Y-%m-%dT%H:%M:%SZ")
            snapshot = SyncSnapshot(
                token=str(uuid.uuid4()),
                cursor=snapshot_cursor,
                payload="",
                format="gzip-chunks-v1",
                status="building",
                item_count=item_count,
                chunk_count=chunk_count,
                uncompressed_bytes=uncompressed_bytes,
                compressed_bytes=compressed_bytes,
                checksum=manifest_hasher.hexdigest(),
                created_at=now,
                expires_at=(created_at + SYNC_SNAPSHOT_TTL).strftime("%Y-%m-%dT%H:%M:%SZ"),
            )
            publish_db = AsyncSession(
                bind=self.db.bind,
                expire_on_commit=False,
                autoflush=False,
            )
            try:
                async with publish_db.begin():
                    stale_tokens = list((await publish_db.scalars(
                        select(SyncSnapshot.token).where(
                            or_(
                                and_(SyncSnapshot.expires_at != "", SyncSnapshot.expires_at <= now),
                                and_(SyncSnapshot.expires_at == "", SyncSnapshot.created_at < cutoff),
                                and_(SyncSnapshot.status != "ready", SyncSnapshot.created_at < cutoff),
                            )
                        )
                    )).all())
                    if stale_tokens:
                        await publish_db.execute(
                            delete(SyncSnapshotChunk).where(
                                SyncSnapshotChunk.snapshot_token.in_(stale_tokens)
                            )
                        )
                        await publish_db.execute(
                            delete(SyncSnapshot).where(SyncSnapshot.token.in_(stale_tokens))
                        )

                    publish_db.add(snapshot)
                    await publish_db.flush()

                    spool.seek(0)
                    pending_chunks: list[SyncSnapshotChunk] = []
                    for chunk_index in range(chunk_count):
                        encoded = pickle.load(spool)
                        pending_chunks.append(
                            SyncSnapshotChunk(
                                snapshot_token=snapshot.token,
                                chunk_index=chunk_index,
                                item_start=encoded.item_start,
                                item_count=encoded.item_count,
                                compressed_payload=encoded.compressed_payload,
                                uncompressed_bytes=encoded.uncompressed_bytes,
                                compressed_bytes=encoded.compressed_bytes,
                                checksum=encoded.checksum,
                            )
                        )
                        if len(pending_chunks) == 100:
                            publish_db.add_all(pending_chunks)
                            await publish_db.flush()
                            for chunk in pending_chunks:
                                publish_db.expunge(chunk)
                            pending_chunks = []
                    if pending_chunks:
                        publish_db.add_all(pending_chunks)
                        await publish_db.flush()
                        for chunk in pending_chunks:
                            publish_db.expunge(chunk)

                    # Validate the persisted manifest before publishing it as ready.
                    metadata = (
                        await publish_db.execute(
                            select(
                                SyncSnapshotChunk.chunk_index,
                                SyncSnapshotChunk.item_start,
                                SyncSnapshotChunk.item_count,
                                SyncSnapshotChunk.uncompressed_bytes,
                                SyncSnapshotChunk.compressed_bytes,
                                SyncSnapshotChunk.checksum,
                            )
                            .where(SyncSnapshotChunk.snapshot_token == snapshot.token)
                            .order_by(SyncSnapshotChunk.chunk_index)
                        )
                    ).all()
                    if len(metadata) != chunk_count:
                        raise ValueError("snapshot chunk count mismatch before publish")
                    expected_start = 0
                    persisted_hasher = hashlib.sha256()
                    persisted_uncompressed_bytes = 0
                    persisted_compressed_bytes = 0
                    for expected_index, chunk in enumerate(metadata):
                        if chunk.chunk_index != expected_index or chunk.item_start != expected_start:
                            raise ValueError("snapshot chunk sequence mismatch before publish")
                        expected_start += chunk.item_count
                        persisted_uncompressed_bytes += chunk.uncompressed_bytes
                        persisted_compressed_bytes += chunk.compressed_bytes
                        persisted_hasher.update(chunk.checksum.encode("ascii"))
                    if (
                        expected_start != item_count
                        or persisted_uncompressed_bytes != uncompressed_bytes
                        or persisted_compressed_bytes != compressed_bytes
                        or persisted_hasher.hexdigest() != snapshot.checksum
                    ):
                        raise ValueError("snapshot manifest mismatch before publish")
                    snapshot.status = "ready"
                    await publish_db.flush()
            finally:
                await publish_db.close()
            return snapshot
        finally:
            if spool is not None:
                spool.close()

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
