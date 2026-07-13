"""R6-F3: Large-scale sync capacity verification.

Tests prove correctness of incremental pull paging, Full Snapshot creation
and chunked reading, ACK / floor advancement / pruning, and event ledger
integrity at 10k+ event volume — the production P95 scale baseline.

No production code is modified. Tests use the standard space_session fixture
and bulk-insert events for efficiency.
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.services.time import utc_now_iso

_EVENT_COUNT = 10_000
_PAGE_SIZE = 500
_CLIENT_TOKEN = "capacity-test-token-0123456789abcdef"


async def _bulk_insert_events(session, count: int) -> list[int]:
    """Bulk-insert *count* sync events and return their IDs."""
    rows = []
    base_ts = utc_now_iso()
    for i in range(count):
        rows.append({
            "entity_type": "task",
            "entity_id": f"task-{i:06d}",
            "action": "create",
            "payload": json.dumps(
                {"id": f"task-{i:06d}", "title": f"Task {i}", "i": i},
                ensure_ascii=False,
                sort_keys=True,
                allow_nan=False,
            ),
            "created_at": base_ts,
        })

    await session.execute(
        insert(SyncOutbox),
        rows,
    )
    await session.flush()

    ids = list(await session.scalars(
        select(SyncOutbox.id).order_by(SyncOutbox.id.asc())
    ))

    max_id = max(ids)
    await session.execute(
        sqlite_insert(SyncState)
        .values(id=1, retention_floor=0, current_cursor=max_id)
        .on_conflict_do_update(
            index_elements=[SyncState.id],
            set_={"current_cursor": max_id},
        )
    )
    await session.commit()
    return ids


async def _bulk_insert_tasks(session, count: int) -> None:
    """Bulk-insert *count* Task records for snapshot scanning."""
    from app.models.task import Task

    base_ts = utc_now_iso()
    rows = []
    for i in range(count):
        rows.append({
            "id": f"task-{i:06d}",
            "title": f"Task {i}",
            "description": f"Description for task {i}",
            "status": "todo",
            "priority": "medium",
            "tags": "[]",
            "plan": "",
            "completion": "0%",
            "estimated_pomodoros": 1,
            "actual_pomodoros": 0,
            "created_at": base_ts,
            "updated_at": base_ts,
            "version": 1,
        })

    await session.execute(insert(Task), rows)
    await session.commit()


@pytest.mark.asyncio
async def test_incremental_pull_pages_all_events_without_gaps(space_session):
    """10k events are paged through incremental pull with no gaps or duplicates."""
    from app.services.sync import SyncService

    ids = await _bulk_insert_events(space_session, _EVENT_COUNT)
    assert len(ids) == _EVENT_COUNT

    service = SyncService(space_session)
    cursor = 0
    collected_ids: list[int] = []
    pages = 0

    while True:
        result = await service.pull(cursor=cursor, limit=_PAGE_SIZE)
        page_events = []
        for key in ("tasks",):
            page_events.extend(result.get(key, []))
        for item in page_events:
            collected_ids.append(int(item["i"]))
        cursor = result["next_cursor"]
        pages += 1
        if not result["has_more"]:
            break
        if pages > 100:
            pytest.fail("pull did not converge within 100 pages")

    assert pages == (_EVENT_COUNT + _PAGE_SIZE - 1) // _PAGE_SIZE
    assert len(collected_ids) == _EVENT_COUNT
    assert collected_ids == list(range(_EVENT_COUNT))


@pytest.mark.asyncio
async def test_full_snapshot_create_and_read_all_chunks(space_session):
    """Snapshot of 10k tasks is correctly built, chunked, and paged."""
    from app.services.sync import SyncService

    await _bulk_insert_tasks(space_session, _EVENT_COUNT)
    await _bulk_insert_events(space_session, _EVENT_COUNT)

    service = SyncService(space_session)
    first = await service.full(cursor=0, limit=_PAGE_SIZE)
    snapshot_token = first["snapshot_token"]
    assert snapshot_token is not None

    collected = 0
    offset = 0
    token = snapshot_token
    pages = 0

    while True:
        page = await service.full(
            cursor=0, limit=_PAGE_SIZE,
            snapshot_token=token, snapshot_offset=offset,
        )
        items = page.get("tasks", [])
        collected += len(items)
        offset += len(items)
        pages += 1
        if not page["has_more"]:
            break
        if pages > 100:
            pytest.fail("snapshot read did not converge within 100 pages")

    assert collected == _EVENT_COUNT
    assert pages > 1


@pytest.mark.asyncio
async def test_ack_advances_floor_and_prunes_at_scale(space_session):
    """ACK at 8k on 10k events: floor = 8k, 8k events pruned, 2k remain."""
    from app.services.sync_clients import SyncClientService
    from app.services.sync_outbox import get_retention_floor, record_sync_event

    ids = await _bulk_insert_events(space_session, _EVENT_COUNT)
    ack_target = ids[7999]

    service = SyncClientService(space_session)
    client_id = str(uuid.uuid4())

    from datetime import datetime, timedelta, timezone

    from app.models.sync_client import SyncClient

    now = utc_now_iso()
    lease = (datetime.now(timezone.utc) + timedelta(days=30))
    space_session.add(SyncClient(
        client_id=client_id,
        user_id="user-cap",
        display_name="Capacity Client",
        ack_cursor=ids[0],
        last_seen_at=now,
        lease_expires_at=lease.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        created_at=now,
        snapshot_required=False,
        token_hash="ab" * 32,
    ))
    await space_session.commit()

    result = await service.acknowledge(
        client_id=client_id, user_id="user-cap",
        ack_cursor=ack_target, cursor_version=2,
    )
    await space_session.commit()

    assert result["retention_floor"] == ack_target
    assert result["pruned_events"] == _EVENT_COUNT - 2000

    floor = await get_retention_floor(space_session)
    assert floor == ack_target

    remaining = await space_session.scalar(
        select(func.count()).select_from(SyncOutbox)
    )
    assert remaining == 2000

    remaining_ids = list(await space_session.scalars(
        select(SyncOutbox.id).order_by(SyncOutbox.id.asc())
    ))
    assert remaining_ids[0] > ack_target


@pytest.mark.asyncio
async def test_pull_after_prune_returns_only_post_floor_events(space_session):
    """After floor advances to 8k, incremental pull from floor returns only
    the remaining 2k events, not the pruned 8k.
    """
    from app.services.sync import SyncService
    from app.services.sync_clients import SyncClientService

    ids = await _bulk_insert_events(space_session, _EVENT_COUNT)
    ack_target = ids[7999]

    from datetime import datetime, timedelta, timezone

    from app.models.sync_client import SyncClient

    now = utc_now_iso()
    lease = (datetime.now(timezone.utc) + timedelta(days=30))
    space_session.add(SyncClient(
        client_id=str(uuid.uuid4()),
        user_id="user-cap",
        display_name="Prune Pull Client",
        ack_cursor=ids[0],
        last_seen_at=now,
        lease_expires_at=lease.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        created_at=now,
        snapshot_required=False,
        token_hash="cd" * 32,
    ))
    await space_session.commit()

    client_service = SyncClientService(space_session)
    await client_service.acknowledge(
        client_id=(await space_session.scalars(
            select(SyncClient.client_id).where(SyncClient.user_id == "user-cap")
        )).one(),
        user_id="user-cap",
        ack_cursor=ack_target, cursor_version=2,
    )
    await space_session.commit()

    sync_service = SyncService(space_session)
    result = await sync_service.pull(cursor=ack_target, limit=_PAGE_SIZE)
    assert result["next_cursor"] > ack_target
    assert result["has_more"] is True

    collected = 0
    cursor = ack_target
    while True:
        page = await sync_service.pull(cursor=cursor, limit=_PAGE_SIZE)
        collected += len(page.get("tasks", []))
        cursor = page["next_cursor"]
        if not page["has_more"]:
            break
        if collected > _EVENT_COUNT:
            pytest.fail("collected more events than exist")

    assert collected == 2000
