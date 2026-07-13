"""R6-F4: Disk-full and process-kill crash recovery verification.

Tests prove that sync operations fail-closed under disk I/O errors, that
orphaned building snapshots are never served after engine disposal, and
that the database remains consistent after a simulated process kill
followed by engine reconstruction.

No production code is modified.
"""
from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select

from app.services.time import utc_now_iso

_PAGE_SIZE = 500


async def _init_space(_isolate_env, space_id: str = "spc_crash"):
    from app.db.meta_session import init_meta_db
    from app.space_manager import get_space_engine_manager

    await init_meta_db()
    manager = get_space_engine_manager()
    session = await manager.get_session(space_id)
    return session, manager


async def _cleanup(session, manager):
    if session is not None:
        await session.close()
    from app.space_manager import dispose_space_engine_manager
    await dispose_space_engine_manager()
    from app.db.meta_session import close_meta_db
    await close_meta_db()


@pytest.mark.asyncio
async def test_orphaned_building_snapshot_not_served_after_engine_dispose(_isolate_env):
    """A snapshot left in 'building' status after engine disposal is never
    served to clients. After engine reconstruction, requesting full sync
    creates a fresh ready snapshot instead.
    """
    from app.models.sync_state import SyncSnapshot
    from app.services.sync import SyncService, SyncSnapshotExpiredError
    from app.services.sync_outbox import record_sync_event

    session, manager = await _init_space(_isolate_env)
    space_id = "spc_crash"
    try:
        for i in range(5):
            await record_sync_event(
                session, entity_type="task", entity_id=f"crash-{i}", action="create"
            )
        await session.commit()

        service = SyncService(session)
        orphan_token = str(uuid.uuid4())
        now = utc_now_iso()
        session.add(SyncSnapshot(
            token=orphan_token,
            cursor=5,
            payload="",
            format="gzip-chunks-v1",
            status="building",
            item_count=0,
            chunk_count=0,
            uncompressed_bytes=0,
            compressed_bytes=0,
            checksum="0" * 64,
            created_at=now,
            expires_at="2099-01-01T00:00:00.000Z",
        ))
        await session.commit()

        with pytest.raises(SyncSnapshotExpiredError):
            await service.full(
                cursor=0, limit=_PAGE_SIZE,
                snapshot_token=orphan_token, snapshot_offset=0,
            )

        await session.close()
        await manager.dispose(space_id)

        new_session = await manager.get_session(space_id)
        new_service = SyncService(new_session)
        result = await new_service.full(cursor=0, limit=_PAGE_SIZE)
        new_token = result["snapshot_token"]
        assert new_token is not None
        assert new_token != orphan_token

        snapshot = await new_session.get(SyncSnapshot, new_token)
        assert snapshot is not None
        assert snapshot.status == "ready"

        orphan = await new_session.get(SyncSnapshot, orphan_token)
        assert orphan is not None
        assert orphan.status == "building"
        await new_session.close()
    finally:
        await _cleanup(None, manager)


@pytest.mark.asyncio
async def test_database_consistent_after_engine_dispose_and_reconstruct(_isolate_env):
    """Write events, dispose engine (simulating process kill), reconstruct
    engine. All previously committed data must be visible and the sync
    state (cursor, floor) must be intact.
    """
    from app.models.sync_outbox import SyncOutbox
    from app.services.sync_outbox import (
        get_current_cursor,
        get_retention_floor,
        record_sync_event,
    )

    session, manager = await _init_space(_isolate_env)
    space_id = "spc_crash"
    try:
        events = [
            await record_sync_event(
                session, entity_type="task", entity_id=f"kill-{i}", action="create"
            )
            for i in range(10)
        ]
        await session.commit()
        cursor_before = await get_current_cursor(session)
        floor_before = await get_retention_floor(session)
        count_before = await session.scalar(
            select(__import__("sqlalchemy").func.count()).select_from(SyncOutbox)
        )

        await session.close()
        await manager.dispose(space_id)

        new_session = await manager.get_session(space_id)
        cursor_after = await get_current_cursor(new_session)
        floor_after = await get_retention_floor(new_session)
        count_after = await new_session.scalar(
            select(__import__("sqlalchemy").func.count()).select_from(SyncOutbox)
        )

        assert cursor_after == cursor_before
        assert floor_after == floor_before
        assert count_after == count_before
        assert count_after == 10

        ids_after = list(await new_session.scalars(
            select(SyncOutbox.id).order_by(SyncOutbox.id.asc())
        ))
        assert ids_after == [e.id for e in events]
        await new_session.close()
    finally:
        await _cleanup(None, manager)


@pytest.mark.asyncio
async def test_backup_to_unwritable_location_fails_and_source_intact(_isolate_env):
    """BackupService.create_backup fails when the backup directory is
    unwritable (simulated disk full). The source database must remain
    intact and accessible.
    """
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.file_system.backup import BackupService
    from app.services.sync_outbox import record_sync_event
    from app.space_manager import dispose_space_engine_manager, get_space_engine_manager

    await init_meta_db()
    manager = get_space_engine_manager()
    space_id = "spc_crash_backup"
    session = await manager.get_session(space_id)
    try:
        for i in range(3):
            await record_sync_event(
                session, entity_type="task", entity_id=f"bk-{i}", action="create"
            )
        await session.commit()
        await session.close()

        db_path = manager._engines[space_id][0].url.database
        if db_path:
            source_path = Path(db_path)
        else:
            pytest.skip("cannot resolve database path")

        import tempfile as _tempfile

        original_mkstemp = _tempfile.mkstemp

        def fail_mkstemp(*args, **kwargs):
            raise OSError("No space left on device")

        _tempfile.mkstemp = fail_mkstemp
        try:
            backup_dir = _isolate_env / "disk-full-backups"
            result = BackupService.create_backup(source_path, backup_dir)
            assert result is None
            assert not list(backup_dir.glob("index_*.db")) if backup_dir.exists() else True
        finally:
            _tempfile.mkstemp = original_mkstemp

        conn = sqlite3.connect(str(source_path))
        try:
            integrity = conn.execute("PRAGMA integrity_check").fetchone()
            assert integrity == ("ok",)
            count = conn.execute("SELECT count(*) FROM sync_outbox").fetchone()
            assert count[0] == 3
        finally:
            conn.close()
    finally:
        await dispose_space_engine_manager()
        await close_meta_db()


@pytest.mark.asyncio
async def test_push_invalid_events_does_not_advance_cursor(_isolate_env):
    """Push with invalid entity types returns errors but does not advance
    the sync cursor. The database state remains consistent.
    """
    from app.services.sync import SyncService
    from app.services.sync_outbox import get_current_cursor, record_sync_event

    session, manager = await _init_space(_isolate_env)
    try:
        await record_sync_event(
            session, entity_type="task", entity_id="pre-existing", action="create"
        )
        await session.commit()
        cursor_before = await get_current_cursor(session)

        service = SyncService(session)
        result = await service.push([
            {"entity_type": "invalid_type", "entity_id": "bad-1",
             "action": "create", "payload": {}},
            {"entity_type": "also_bad", "entity_id": "bad-2",
             "action": "create", "payload": {}},
        ])
        await session.commit()

        assert len(result["errors"]) == 2
        assert result["applied"] == []
        cursor_after = await get_current_cursor(session)
        assert cursor_after == cursor_before
    finally:
        await _cleanup(session, manager)


@pytest.mark.asyncio
async def test_wal_recovery_after_unexpected_shutdown(_isolate_env):
    """Data committed to WAL but not checkpointed must survive an unexpected
    shutdown (engine dispose). After reconstruction, all committed data
    must be visible.
    """
    from app.models.sync_outbox import SyncOutbox
    from app.services.sync_outbox import record_sync_event

    session, manager = await _init_space(_isolate_env, "spc_wal")
    space_id = "spc_wal"
    try:
        await session.execute(__import__("sqlalchemy").text("PRAGMA journal_mode=WAL"))
        await session.execute(__import__("sqlalchemy").text("PRAGMA wal_autocheckpoint=0"))

        for i in range(20):
            await record_sync_event(
                session, entity_type="task", entity_id=f"wal-{i}", action="create"
            )
        await session.commit()

        raw_conn = sqlite3.connect(str(_isolate_env / "spaces" / "spc_wal" / "space.db"))
        try:
            journal_mode = raw_conn.execute("PRAGMA journal_mode").fetchone()
            assert journal_mode[0] == "wal"
        finally:
            raw_conn.close()

        await session.close()
        await manager.dispose(space_id)

        new_session = await manager.get_session(space_id)
        count = await new_session.scalar(
            select(__import__("sqlalchemy").func.count()).select_from(SyncOutbox)
        )
        assert count == 20

        ids = list(await new_session.scalars(
            select(SyncOutbox.entity_id).order_by(SyncOutbox.id.asc())
        ))
        assert ids == [f"wal-{i}" for i in range(20)]
        await new_session.close()
    finally:
        await _cleanup(None, manager)
