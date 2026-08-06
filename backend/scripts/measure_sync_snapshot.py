"""Small isolated probe for the bounded recovery chunk contract."""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.note import Note
from app.models.sync_client import SyncClient
from app.models.sync_recovery import SyncRecoveryChunk, SyncRecoveryManifest
from app.models.sync_state import SyncState
from app.registry.sync_registry import CATALOG
from app.sync.clients import SyncClientRegistry
from app.sync.cursor import SyncCursorCodec
from app.sync.snapshot import (
    MAX_CHUNK_BYTES,
    MAX_CHUNK_ENTITIES,
    SyncPageTokenCodec,
    SyncSnapshotSerializer,
    SyncSnapshotStore,
)


class _Bodies:
    def __init__(self, body: str) -> None:
        self.body = body

    async def read_note(self, _note_id: str) -> str:
        return self.body


class _Lease:
    def assert_active_owner(self, **_expected: object) -> None:
        return None


async def _measure(notes: int, body_bytes: int, run_root: Path) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="sync-snapshot-", dir=run_root) as temporary:
        database = Path(temporary) / "space.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database.as_posix()}")
        tables = (
            Note.__table__,
            SyncState.__table__,
            SyncClient.__table__,
            SyncRecoveryManifest.__table__,
            SyncRecoveryChunk.__table__,
        )
        async with engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        timestamp = "2026-08-06T00:00:00.000Z"
        async with sessions() as session, session.begin():
            session.add(SyncState(id=1, retention_floor=0, current_cursor=0))
            for start in range(0, notes, MAX_CHUNK_ENTITIES):
                batch = [
                    {
                        "id": f"note-{index:05d}",
                        "title": f"Note {index}",
                        "content_hash": "0" * 64,
                        "word_count": body_bytes,
                        "summary": "",
                        "tags": "[]",
                        "category": None,
                        "folder_id": None,
                        "status": "active",
                        "trashed_at": None,
                        "created_at": timestamp,
                        "updated_at": timestamp,
                        "version": 1,
                    }
                    for index in range(start, min(start + MAX_CHUNK_ENTITIES, notes))
                ]
                await session.execute(insert(Note), batch)
            await SyncClientRegistry(
                session, CATALOG.hash, 30, space_id="probe-space"
            ).register_or_touch("probe-client")
            catalog = SimpleNamespace(
                hash=CATALOG.hash,
                list_sync_enabled=lambda: (CATALOG.get("note"),),
                model_for=lambda _name: Note,
            )
            store = SyncSnapshotStore(
                session,
                catalog,
                SyncPageTokenCodec(b"probe-page-token-secret-0123456789"),
                SyncSnapshotSerializer(),
                cursor=SyncCursorCodec(b"probe-cursor-secret-0123456789abcdef"),
            )
            scope = SimpleNamespace(
                scope=SimpleNamespace(space_id="probe-space"),
                file_system=_Bodies("x" * body_bytes),
            )
            created = await store.create(scope, _Lease(), "probe-client")
            if created.error is not None or created.descriptor is None:
                raise RuntimeError("production snapshot creation failed")
            token = created.descriptor.first_page_token
            complete = False
            while token is not None:
                decision = await store.page(scope, _Lease(), "probe-client", token)
                if decision.error is not None or decision.page is None:
                    raise RuntimeError("production snapshot paging failed")
                token = decision.page.next_page_token
                complete = not decision.page.has_more
            chunk_count = await session.scalar(
                select(func.count()).select_from(SyncRecoveryChunk)
            )
        await engine.dispose()
    return {
        "notes": notes,
        "body_bytes": body_bytes,
        "chunks": chunk_count or 0,
        "max_chunk_entities": MAX_CHUNK_ENTITIES,
        "max_chunk_bytes": MAX_CHUNK_BYTES,
        "snapshot_complete": complete,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notes", type=int, required=True)
    parser.add_argument("--body-bytes", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.notes < 0 or args.body_bytes < 0:
        raise SystemExit("--notes and --body-bytes must be nonnegative")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = asyncio.run(_measure(args.notes, args.body_bytes, args.output.parent))
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
