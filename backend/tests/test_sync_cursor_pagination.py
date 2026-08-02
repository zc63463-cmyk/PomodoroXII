"""Tests for P0-2: Timestamp normalization + (updated_at, id) cursor pagination.

Covers:
- Seconds-precision DB rows are not re-emitted when cursor is the normalized
  millisecond form (lexicographic equality holds).
- Ordering by (updated_at, id) so rows sharing a timestamp are returned in a
  deterministic order (clients can de-dup).
- Tombstones follow the same (deleted_at, id) ordering for the same reason.
- since_id pagination: rows sharing the same timestamp can be paged through
  via the (since, since_id) tuple without skipping or repeating rows.

The cursor contract:
    The cursor is the ``(since, since_id)`` tuple. ``since`` is the max
    ``updated_at`` seen so far; ``since_id`` is the max ``id`` among rows
    sharing that timestamp. The filter is::
        (updated_at > since) OR (updated_at == since AND id > since_id)
    This guarantees no rows are skipped or repeated across pages, even when
    many rows share the same timestamp. ``next_since_id`` is returned in
    the response so clients can pass it on the next pull.
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.provisioned_space_storage


async def _setup_login_and_space_token(client) -> tuple[str, str]:
    """Setup admin, login, create a space, issue a space token."""
    resp = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert resp.status_code in (200, 201)
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert resp.status_code == 200
    master_token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post(
        "/api/v1/spaces", json={"name": "Sync Space"}, headers=headers
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    assert resp.status_code == 200
    space_token = resp.json()["space_token"]
    return master_token, space_token


# --------------------------------------------------------------------------- #
# Seconds-precision DB rows vs millisecond cursor
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pull_with_milliseconds_precision_db_does_not_repeat(space_session):
    """Rows stored with millisecond precision should not be re-emitted when
    the cursor equals their timestamp.

    Flow:
    1. Insert a Task row with updated_at="2026-07-04T10:00:00.000Z" (ms).
    2. pull(since="") returns the row; next_since = "2026-07-04T10:00:00.000Z".
    3. pull(since=next_since) should NOT return the row again.

    Note: seconds-precision historical rows are migrated to ms precision by
    alembic 006 (tested separately). After migration, all DB rows are ms
    precision, so the cursor comparison is lexicographically consistent.
    """
    from app.models.task import Task
    from app.services.sync import SyncService

    task = Task(
        id="ms-precision-1",
        title="Milliseconds",
        status="todo",
        priority="medium",
        tags="[]",
        updated_at="2026-07-04T10:00:00.000Z",
    )
    space_session.add(task)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    first = await svc.pull(since="", limit=100)
    task_ids = [t["id"] for t in first["tasks"]]
    assert "ms-precision-1" in task_ids
    next_since = first["next_since"]
    assert next_since == "2026-07-04T10:00:00.000Z", (
        f"expected normalized cursor, got {next_since}"
    )

    # Second pull with the same cursor: row must NOT repeat.
    second = await svc.pull(since=next_since, limit=100)
    second_ids = [t["id"] for t in second["tasks"]]
    assert "ms-precision-1" not in second_ids, (
        "row was re-emitted after cursor advanced past its timestamp"
    )


# --------------------------------------------------------------------------- #
# Deterministic (updated_at, id) ordering
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pull_orders_by_updated_at_then_id(space_session):
    """Rows sharing the same updated_at should be ordered by id ascending
    so clients receive a deterministic sequence."""
    from app.models.task import Task
    from app.services.sync import SyncService

    # Insert 3 tasks with the SAME updated_at but out-of-order ids.
    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["charlie", "alpha", "bravo"]:
        t = Task(
            id=tid, title=tid, status="todo", priority="medium",
            tags="[]", updated_at=ts,
        )
        space_session.add(t)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    result = await svc.pull(since="", limit=100)
    returned_ids = [t["id"] for t in result["tasks"]]
    # Expect alphabetical (id-asc) ordering.
    assert returned_ids == ["alpha", "bravo", "charlie"], (
        f"expected id-asc order, got {returned_ids}"
    )


@pytest.mark.asyncio
async def test_pull_same_timestamp_3_rows_requires_cursor_upgrade(space_session):
    """A same-timestamp legacy overflow must not return an advancing cursor."""
    from app.errors import CursorUpgradeRequiredError
    from app.models.task import Task
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["same-ts-3", "same-ts-1", "same-ts-2"]:
        t = Task(
            id=tid, title=tid, status="todo", priority="medium",
            tags="[]", updated_at=ts,
        )
        space_session.add(t)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await svc.pull(since="", limit=2)
    assert raised.value.details == {"truncated_groups": ("tasks",)}


# --------------------------------------------------------------------------- #
# Cross-entity pagination safety
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_legacy_pull_global_cursor_skips_truncated_older_entity_rows(space_session):
    """A newer entity cannot make an unsafe legacy cursor advance.

    With ``limit=2`` the task group has one remaining 10:00 row, while a
    quick note at 12:00 exists. The legacy global cursor must fail closed.
    """
    from app.errors import CursorUpgradeRequiredError
    from app.models.quick_note import QuickNote
    from app.models.task import Task
    from app.services.sync import SyncService

    old_ts = "2026-07-04T10:00:00.000Z"
    for task_id in ["task-3", "task-1", "task-2"]:
        space_session.add(
            Task(
                id=task_id,
                title=task_id,
                status="todo",
                priority="medium",
                tags="[]",
                updated_at=old_ts,
            )
        )
    space_session.add(
        QuickNote(
            id="quick-newer",
            content="newer entity",
            tags="[]",
            updated_at="2026-07-04T12:00:00.000Z",
        )
    )
    await space_session.flush()

    service = SyncService(space_session, fs=None)
    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await service.pull(since="", limit=2)
    assert raised.value.details == {"truncated_groups": ("tasks",)}


@pytest.mark.asyncio
async def test_cursor_pull_pages_cross_entity_events_without_skipping(space_session):
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    await record_sync_event(
        space_session, entity_type="task", entity_id="task-1", action="create",
        payload={"id": "task-1", "title": "one"},
        visible=True,
    )
    await record_sync_event(
        space_session, entity_type="quickNote", entity_id="quick-1", action="create",
        payload={"id": "quick-1", "content": "quick"},
        visible=True,
    )
    await record_sync_event(
        space_session, entity_type="task", entity_id="task-2", action="create",
        payload={"id": "task-2", "title": "two"},
        visible=True,
    )

    service = SyncService(space_session)
    first = await service.pull(cursor=0, limit=2)
    second = await service.pull(cursor=first["next_cursor"], limit=2)

    assert first["cursor_version"] == 2
    assert first["has_more"] is True
    assert first["next_cursor"] < second["next_cursor"]
    assert {item["id"] for page in (first, second) for item in page["tasks"]} == {
        "task-1", "task-2",
    }
    assert [item["id"] for item in first["quickNotes"]] == ["quick-1"]


@pytest.mark.asyncio
async def test_cursor_pull_limit_one_reaches_delete_and_interleaved_update(space_session):
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    await record_sync_event(
        space_session, entity_type="task", entity_id="task-1", action="create",
        payload={"id": "task-1", "title": "created"},
        visible=True,
    )
    await record_sync_event(
        space_session, entity_type="quickNote", entity_id="quick-1", action="delete",
        visible=True,
    )
    await record_sync_event(
        space_session, entity_type="task", entity_id="task-1", action="update",
        payload={"id": "task-1", "title": "updated"},
        visible=True,
    )

    service = SyncService(space_session)
    cursor = 0
    pages = []
    while True:
        page = await service.pull(cursor=cursor, limit=1)
        pages.append(page)
        assert page["next_cursor"] >= cursor
        cursor = page["next_cursor"]
        if not page["has_more"]:
            break

    assert len(pages) == 3
    assert len(pages[1]["tombstones"]) == 1
    assert pages[1]["tombstones"][0]["entity_type"] == "quickNote"
    assert pages[1]["tombstones"][0]["entity_id"] == "quick-1"
    assert pages[2]["tasks"][0]["title"] == "updated"


@pytest.mark.asyncio
async def test_cursor_pull_folds_repeated_entity_events_to_last_scanned_state(space_session):
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    first = await record_sync_event(
        space_session, entity_type="task", entity_id="same", action="create",
        payload={"id": "same", "title": "first"},
        visible=True,
    )
    last = await record_sync_event(
        space_session, entity_type="task", entity_id="same", action="update",
        payload={"id": "same", "title": "last"},
        visible=True,
    )

    page = await SyncService(space_session).pull(cursor=0, limit=10)
    assert page["tasks"] == [{"id": "same", "title": "last"}]
    assert page["next_cursor"] == last.id
    assert page["next_cursor"] != first.id


@pytest.mark.asyncio
async def test_cursor_pull_excludes_invisible_events_but_keeps_allocated_cursor(space_session):
    from app.models.sync_state import SyncState
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    visible_event = await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="visible-task",
        action="create",
        payload={"id": "visible-task", "title": "visible"},
        visible=True,
    )
    invisible_event = await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="hidden-task",
        action="create",
        payload={"id": "hidden-task", "title": "hidden"},
        visible=False,
    )

    state = await space_session.get(SyncState, 1)
    page = await SyncService(space_session).pull(cursor=0, limit=10)

    assert state is not None
    assert state.current_cursor == invisible_event.id
    assert page["tasks"] == [{"id": "visible-task", "title": "visible"}]
    assert page["next_cursor"] == visible_event.id
    assert page["has_more"] is False


@pytest.mark.asyncio
async def test_cursor_pull_empty_ledger_returns_zero_cursor(client):
    """GET /sync/pull?cursor=0 on a fresh space (no events) returns next_cursor=None."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    resp = await client.get(
        "/api/v1/sync/pull?cursor=0&limit=10", headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["cursor_version"] == 2
    assert body["has_more"] is False
    # No events in the ledger → next_cursor stays at the requested cursor (0).
    assert body["next_cursor"] == 0


@pytest.mark.asyncio
async def test_cursor_pull_via_http_after_push_returns_events(client):
    """POST /sync/push then GET /sync/pull?cursor=0 returns the pushed events."""
    _, space_token = await _setup_login_and_space_token(client)
    headers = {"Authorization": f"Bearer {space_token}"}

    eid = uuid.uuid4().hex
    resp = await client.post(
        "/api/v1/sync/push",
        json={"events": [{
            "entity_type": "task",
            "entity_id": eid,
            "action": "create",
            "payload": {"id": eid, "title": "Cursor HTTP", "status": "todo", "priority": "medium", "tags": "[]"},
            "client_updated_at": "2026-07-04T10:00:00.000Z",
        }]},
        headers=headers,
    )
    assert resp.status_code == 200

    resp = await client.get(
        "/api/v1/sync/pull?cursor=0&limit=10", headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["cursor_version"] == 2
    task_ids = [t["id"] for t in body.get("tasks", [])]
    assert eid in task_ids
    assert body["next_cursor"] is not None
    assert body["has_more"] is False


# --------------------------------------------------------------------------- #
# Tombstones (deleted_at, id) ordering
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_tombstones_same_timestamp_ordered_by_id(space_session):
    """Tombstones sharing the same deleted_at should be ordered by id ascending."""
    from app.models.tombstone import Tombstone
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["tomb-c", "tomb-a", "tomb-b"]:
        tb = Tombstone(
            entity_type="task",
            entity_id=tid,
            deleted_at=ts,
        )
        space_session.add(tb)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    result = await svc.full(since="", limit=100)
    tomb_ids = [t["entity_id"] for t in result["tombstones"]]
    assert tomb_ids == ["tomb-a", "tomb-b", "tomb-c"], (
        f"expected id-asc tombstone order, got {tomb_ids}"
    )


# --------------------------------------------------------------------------- #
# since_id pagination — same-timestamp rows paged without skip/repeat
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pull_same_timestamp_since_id_still_rejects_overflow(space_session):
    """A supplied legacy secondary cursor does not make group overflow safe."""
    from app.errors import CursorUpgradeRequiredError
    from app.models.task import Task
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["s3", "s1", "s2"]:
        t = Task(
            id=tid, title=tid, status="todo", priority="medium",
            tags="[]", updated_at=ts,
        )
        space_session.add(t)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await svc.pull(since="", since_id="", limit=2)
    assert raised.value.details == {"truncated_groups": ("tasks",)}


@pytest.mark.asyncio
async def test_pull_five_same_timestamp_rows_requires_cursor_upgrade(space_session):
    """Legacy pages cannot represent a five-row same-timestamp overflow."""
    from app.errors import CursorUpgradeRequiredError
    from app.models.task import Task
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["s5", "s3", "s1", "s4", "s2"]:
        t = Task(
            id=tid, title=tid, status="todo", priority="medium",
            tags="[]", updated_at=ts,
        )
        space_session.add(t)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)

    with pytest.raises(CursorUpgradeRequiredError):
        await svc.pull(since="", since_id="", limit=2)


@pytest.mark.asyncio
async def test_pull_since_id_backward_compatible(space_session):
    """Omitting since_id (default empty string) preserves old behaviour.

    pull(since="") with no since_id returns all rows — the (updated_at, id)
    filter is skipped when since is empty, just like before.
    """
    from app.models.task import Task
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["bc-1", "bc-2"]:
        t = Task(
            id=tid, title=tid, status="todo", priority="medium",
            tags="[]", updated_at=ts,
        )
        space_session.add(t)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    # No since_id kwarg — should default to "" and behave as before.
    result = await svc.pull(since="", limit=10)
    ids = [t["id"] for t in result["tasks"]]
    assert set(ids) == {"bc-1", "bc-2"}, (
        f"both rows should be returned without since_id, got {ids}"
    )
    assert result["next_since"] == ts
    # next_since_id should be the max id among returned rows.
    assert result["next_since_id"] == "bc-2", (
        f"next_since_id should be 'bc-2', got {result.get('next_since_id')}"
    )


@pytest.mark.asyncio
async def test_pull_distinct_timestamp_overflow_requires_cursor_upgrade(space_session):
    """Distinct timestamps still cannot make a truncated legacy group safe."""
    from app.errors import CursorUpgradeRequiredError
    from app.models.task import Task
    from app.services.sync import SyncService

    t1 = Task(
        id="dt-1", title="t1", status="todo", priority="medium",
        tags="[]", updated_at="2026-07-04T10:00:00.000Z",
    )
    t2 = Task(
        id="dt-2", title="t2", status="todo", priority="medium",
        tags="[]", updated_at="2026-07-04T11:00:00.000Z",
    )
    space_session.add_all([t1, t2])
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    with pytest.raises(CursorUpgradeRequiredError):
        await svc.pull(since="", limit=1)


# --------------------------------------------------------------------------- #
# Tombstone since_id pagination — same-deleted_at rows paged without skip/repeat
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_tombstone_overflow_requires_cursor_upgrade(space_session):
    """Legacy full/pull cannot return a truncated tombstone group."""
    from app.errors import CursorUpgradeRequiredError
    from app.models.tombstone import Tombstone
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["t5", "t3", "t1", "t4", "t2"]:
        tb = Tombstone(entity_type="task", entity_id=tid, deleted_at=ts)
        space_session.add(tb)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)

    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await svc.full(since="", tombstone_since_id="", limit=2)
    assert raised.value.details == {"truncated_groups": ("tombstones",)}


@pytest.mark.asyncio
async def test_full_cursor_zero_is_current_state_snapshot_not_ledger_replay(space_session):
    """历史实体即使从未写入账本，也必须出现在 cursor v2 full snapshot。"""
    from app.models.quick_note import QuickNote
    from app.models.task import Task
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    space_session.add(Task(id="historical", title="before-h2"))
    space_session.add(QuickNote(id="ledger-only", content="current", tags="[]"))
    await space_session.flush()
    await record_sync_event(
        space_session,
        entity_type="quickNote",
        entity_id="ledger-only",
        action="create",
        payload={"id": "ledger-only", "content": "current", "tags": "[]"},
        visible=True,
    )

    page = await SyncService(space_session).full(cursor=0, limit=100)

    assert {item["id"] for item in page["tasks"]} == {"historical"}
    assert {item["id"] for item in page["quickNotes"]} == {"ledger-only"}
    assert page["cursor_version"] == 2
    assert page["snapshot_token"]
    assert page["next_cursor"] >= 1


@pytest.mark.asyncio
async def test_full_snapshot_pages_all_entity_groups_and_tombstones_with_one_offset(space_session):
    from app.models.task import Task
    from app.models.tombstone import Tombstone
    from app.services.sync import SyncService

    space_session.add_all([
        Task(id="snap-task-1", title="one"),
        Task(id="snap-task-2", title="two"),
        Tombstone(entity_type="task", entity_id="deleted-task"),
    ])
    await space_session.flush()

    service = SyncService(space_session)
    first = await service.full(cursor=0, limit=1)
    second = await service.full(
        cursor=0,
        limit=1,
        snapshot_token=first["snapshot_token"],
        snapshot_offset=first["snapshot_offset"],
    )
    third = await service.full(
        cursor=0,
        limit=1,
        snapshot_token=second["snapshot_token"],
        snapshot_offset=second["snapshot_offset"],
    )

    all_task_ids = {
        item["id"] for page in (first, second, third) for item in page["tasks"]
    }
    all_tombstone_ids = {
        item["entity_id"]
        for page in (first, second, third)
        for item in page["tombstones"]
    }
    assert all_task_ids == {"snap-task-1", "snap-task-2"}
    assert all_tombstone_ids == {"deleted-task"}
    assert [first["has_more"], second["has_more"], third["has_more"]] == [True, True, False]
    assert first["next_cursor"] == second["next_cursor"] == third["next_cursor"]


@pytest.mark.asyncio
async def test_full_snapshot_rejects_offset_without_token_and_offset_past_end(space_session):
    from app.errors import ValidationError
    from app.models.task import Task
    from app.services.sync import SyncService

    service = SyncService(space_session)
    with pytest.raises(ValidationError, match="snapshot_offset requires"):
        await service.full(cursor=0, snapshot_offset=1, limit=10)

    space_session.add(Task(id="snapshot-bounds", title="bounds"))
    await space_session.flush()
    first = await service.full(cursor=0, limit=10)
    with pytest.raises(ValidationError, match="non-negative"):
        await service.full(
            cursor=0,
            snapshot_token=first["snapshot_token"],
            snapshot_offset=-1,
            limit=10,
        )
    with pytest.raises(ValidationError, match="exceeds snapshot size"):
        await service.full(
            cursor=0,
            snapshot_token=first["snapshot_token"],
            snapshot_offset=999,
            limit=10,
        )


@pytest.mark.asyncio
async def test_missing_snapshot_continuation_uses_stable_expired_error(space_session):
    from app.errors import SyncSnapshotExpiredError
    from app.services.sync import SyncService

    with pytest.raises(SyncSnapshotExpiredError) as raised:
        await SyncService(space_session).full(
            cursor=0,
            snapshot_token="already-pruned-snapshot",
            snapshot_offset=1,
            limit=10,
        )

    assert raised.value.error_type == "sync_snapshot_expired"
    assert raised.value.recovery_action == "restart_full_sync"


@pytest.mark.asyncio
async def test_existing_expired_snapshot_is_rejected(space_session):
    from app.errors import SyncSnapshotExpiredError
    from app.models.sync_state import SyncSnapshot
    from app.services.sync import SyncService

    space_session.add(
        SyncSnapshot(
            token="expired-existing-snapshot",
            cursor=0,
            payload="[]",
            created_at="2000-01-01T00:00:00Z",
        )
    )
    await space_session.flush()

    with pytest.raises(SyncSnapshotExpiredError, match="snapshot expired"):
        await SyncService(space_session).full(
            cursor=0,
            snapshot_token="expired-existing-snapshot",
            snapshot_offset=0,
            limit=10,
        )


@pytest.mark.asyncio
async def test_snapshot_continuation_rejects_expired_token_with_stable_error(space_session):
    from app.errors import SyncSnapshotExpiredError
    from app.models.sync_state import SyncSnapshot
    from app.services.sync import SyncService

    space_session.add(SyncSnapshot(
        token="expired-continuation",
        cursor=0,
        payload="[]",
        created_at="2000-01-01T00:00:00Z",
    ))
    await space_session.flush()

    with pytest.raises(SyncSnapshotExpiredError) as raised:
        await SyncService(space_session).full(
            cursor=0,
            snapshot_token="expired-continuation",
            snapshot_offset=0,
            limit=10,
        )

    assert raised.value.error_type == "sync_snapshot_expired"
    assert await space_session.get(SyncSnapshot, "expired-continuation") is None


@pytest.mark.asyncio
async def test_new_snapshot_prunes_expired_materialized_snapshots(space_session):
    from app.models.sync_state import SyncSnapshot
    from app.services.sync import SyncService

    space_session.add(
        SyncSnapshot(
            token="expired-snapshot",
            cursor=0,
            payload="[]",
            created_at="2000-01-01T00:00:00Z",
        )
    )
    await space_session.flush()

    await SyncService(space_session).full(cursor=0, limit=10)

    assert await space_session.get(SyncSnapshot, "expired-snapshot") is None


@pytest.mark.asyncio
async def test_full_after_prune_recovers_new_device_from_current_state(space_session):
    from sqlalchemy import delete

    from app.models.sync_outbox import SyncOutbox
    from app.models.sync_state import SyncState
    from app.models.task import Task
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    space_session.add(Task(id="survives-prune", title="current"))
    await space_session.flush()
    event = await record_sync_event(
        space_session,
        entity_type="task",
        entity_id="survives-prune",
        action="create",
        payload={"id": "survives-prune", "title": "current"},
        visible=True,
    )
    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.retention_floor = event.id
    await space_session.execute(
        delete(SyncOutbox).where(SyncOutbox.id <= event.id)
    )
    await space_session.flush()

    page = await SyncService(space_session).full(cursor=0, limit=100)
    assert {item["id"] for item in page["tasks"]} == {"survives-prune"}
    assert page["next_cursor"] == event.id


@pytest.mark.asyncio
async def test_tombstone_since_id_backward_compatible(space_session):
    """Omitting tombstone_since_id (default empty string) preserves old behaviour.

    full(since="") with no tombstone_since_id returns all tombstones — the
    (deleted_at, entity_id) filter is skipped when since is empty, just like
    before. next_tombstone_since_id is still returned for clients that want
    to page.
    """
    from app.models.tombstone import Tombstone
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["bc-b", "bc-a"]:
        tb = Tombstone(entity_type="task", entity_id=tid, deleted_at=ts)
        space_session.add(tb)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)
    result = await svc.full(since="", limit=10)
    ids = [t["entity_id"] for t in result["tombstones"]]
    assert ids == ["bc-a", "bc-b"], (
        f"both tombstones should be returned without tombstone_since_id, got {ids}"
    )
    assert result["next_tombstone_since_id"] == "bc-b", (
        f"next_tombstone_since_id should be 'bc-b', "
        f"got {result.get('next_tombstone_since_id')}"
    )
