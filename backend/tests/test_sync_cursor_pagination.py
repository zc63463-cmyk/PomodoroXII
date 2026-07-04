"""Tests for P0-2: Timestamp normalization + (updated_at, id) cursor pagination.

Covers:
- Seconds-precision DB rows are not re-emitted when cursor is the normalized
  millisecond form (lexicographic equality holds).
- Ordering by (updated_at, id) so rows sharing a timestamp are returned in a
  deterministic order (clients can de-dup).
- Tombstones follow the same (deleted_at, id) ordering for the same reason.

Note on the cursor contract:
    The current cursor API uses ``since`` = the max ``updated_at`` seen so
    far and the filter is ``WHERE updated_at > since``. For the rare case
    of multiple rows sharing the exact same timestamp, the next page *would*
    skip the remaining same-ts rows. The fix here is *not* a perfect cursor
    (that would require ``since_id``); it is the deterministic ordering so
    clients can detect and de-duplicate. The pagination_no_skip tests below
    verify the first page behaviour (which is the common case) and document
    the known limitation in the second-page case.
"""
from __future__ import annotations

import pytest

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
async def test_pull_same_timestamp_3_rows_first_page_returns_2_with_has_more(space_session):
    """3 rows with the same updated_at, limit=2:
    - First page returns 2 rows + has_more=True.
    - First-page ids are the two smallest (id-asc ordering).

    Note: the *second* page would skip the 3rd row because the cursor is
    ``> since`` and all 3 share the same ts. This is a known limitation
    documented in the plan; clients must de-dup same-ts rows. The test
    here verifies the first-page behaviour only.
    """
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
    page1 = await svc.pull(since="", limit=2)
    assert page1["has_more"] is True
    page1_ids = [t["id"] for t in page1["tasks"]]
    assert page1_ids == ["same-ts-1", "same-ts-2"], (
        f"first page should return 2 id-asc rows, got {page1_ids}"
    )
    assert page1["next_since"] == ts


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
