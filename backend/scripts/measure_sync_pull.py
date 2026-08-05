#!/usr/bin/env python
"""Measure the bounded Sync v2 incremental-pull path.

The probe creates a disposable Space-shaped SQLite database, inserts finalized
visible ledger rows, then traverses those rows through ``SyncProtocol.pull``.
It is intentionally self-contained so the Linux RSS gate can run it without a
developer database or a running server.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.sync_client import SyncClient
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.sync.contracts import MAX_DECODED_CANONICAL_PAGE_BYTES, canonical_contract_bytes
from app.sync.cursor import SyncCursorCodec
from app.sync.protocol import SyncProtocol

CATALOG_HASH = "a" * 64
SPACE_ID = "measure-space"
CLIENT_ID = "measure-client"
UTC = "2026-01-01T00:00:00.000Z"


@dataclass(frozen=True, slots=True)
class _Catalog:
    hash: str = CATALOG_HASH


class _NoopUow:
    async def recover_under_lease(self, _scope: object, _lease: object) -> None:
        return None


class _MeasureScope:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory
        self.scope = SimpleNamespace(space_id=SPACE_ID)

    @asynccontextmanager
    async def exclusive_space_resources(
        self, _purpose: str, _timeout: float
    ):
        yield object()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", type=int, default=512)
    parser.add_argument("--payload-bytes", type=int, default=262144)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.events < 1:
        parser.error("--events must be positive")
    if args.payload_bytes < 1:
        parser.error("--payload-bytes must be positive")
    if not 1 <= args.limit <= 500:
        parser.error("--limit must be between 1 and 500")
    return args


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    events: int,
    payload_bytes: int,
) -> set[str]:
    body = "x" * payload_bytes
    payload = json.dumps({"body": body}, ensure_ascii=False, separators=(",", ":"))
    expected_ids = {f"measure-op-{index:06d}" for index in range(events)}
    async with session_factory() as session:
        async with session.begin():
            current_cursor = 0
            for start in range(0, events, 32):
                rows = [
                    SyncOutbox(
                        entity_type="note",
                        entity_id=f"measure-note-{index:06d}",
                        action="create",
                        payload=payload,
                        created_at=UTC,
                        operation_id=f"measure-op-{index:06d}",
                        batch_id=f"measure-batch-{index:06d}",
                        version=1,
                        visible=True,
                    )
                    for index in range(start, min(start + 32, events))
                ]
                session.add_all(rows)
                await session.flush()
                current_cursor = rows[-1].id

            session.add(SyncState(id=1, retention_floor=0, current_cursor=current_cursor))
            session.add(
                SyncClient(
                    client_id=CLIENT_ID,
                    ack_sequence=0,
                    catalog_hash=CATALOG_HASH,
                    registered_at=UTC,
                    last_seen_at=UTC,
                    expires_at="2099-01-01T00:00:00.000Z",
                    requires_recovery=False,
                    recovery_generation=0,
                )
            )
    return expected_ids


async def _measure(args: argparse.Namespace) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="pomodoroxii-sync-pull-") as directory:
        database = Path(directory) / "space.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
        tables = [SyncOutbox.__table__, SyncState.__table__, SyncClient.__table__]
        async with engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))

        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        expected_ids = await _seed(
            session_factory,
            events=args.events,
            payload_bytes=args.payload_bytes,
        )
        scope = _MeasureScope(session_factory)
        protocol = SyncProtocol(
            scope,
            uow=_NoopUow(),
            catalog=_Catalog(),
            cursor=SyncCursorCodec(b"m" * 32),
            ttl_days=30,
        )

        cursor: str | None = None
        seen: set[str] = set()
        returned_events = 0
        maximum_page_bytes = 0
        first_has_more: bool | None = None
        while True:
            page = await protocol.pull(CLIENT_ID, cursor, args.limit)
            page_bytes = len(canonical_contract_bytes(page))
            maximum_page_bytes = max(maximum_page_bytes, page_bytes)
            if len(page.events) > 500 or page_bytes > MAX_DECODED_CANONICAL_PAGE_BYTES:
                raise RuntimeError("bounded pull page exceeded its protocol limit")
            if first_has_more is None:
                first_has_more = page.has_more
            for event in page.events:
                if event.operation_id in seen:
                    raise RuntimeError(f"duplicate event returned: {event.operation_id}")
                seen.add(event.operation_id)
                returned_events += 1
            if not page.has_more:
                break
            cursor = page.next_cursor

        await engine.dispose()

    if seen != expected_ids:
        missing = sorted(expected_ids - seen)[:3]
        extra = sorted(seen - expected_ids)[:3]
        raise RuntimeError(f"event traversal mismatch: missing={missing}, extra={extra}")
    if first_has_more is not True:
        raise RuntimeError("the first bounded page did not require continuation")
    if maximum_page_bytes > MAX_DECODED_CANONICAL_PAGE_BYTES:
        raise RuntimeError("canonical page bytes exceeded 8 MiB")

    return {
        "events": args.events,
        "payload_bytes": args.payload_bytes,
        "requested_limit": args.limit,
        "returned_events": returned_events,
        "canonical_page_bytes": maximum_page_bytes,
        "has_more": first_has_more,
        "pull_complete": True,
    }


def main() -> int:
    args = _parse_args()
    try:
        summary = asyncio.run(_measure(args))
    except Exception as exc:  # pragma: no cover - CLI failure receipt
        print(f"measure_sync_pull failed: {exc}", file=sys.stderr)
        return 1
    encoded = json.dumps(summary, ensure_ascii=True, separators=(",", ":"))
    print(encoded)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="ascii")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
