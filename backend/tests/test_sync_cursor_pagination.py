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
    - next_since_id is the id of the last returned row so the next page
      can resume via (since=ts, since_id=last_id).

    See ``test_pull_same_timestamp_pagination_with_since_id`` for the
    full two-page flow that verifies the 3rd row is reachable.
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
    assert page1["next_since_id"] == "same-ts-2", (
        f"next_since_id should be last returned id, got {page1.get('next_since_id')}"
    )


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
async def test_pull_same_timestamp_pagination_with_since_id(space_session):
    """since_id lets the second page pick up the 3rd same-timestamp row.

    Flow:
    - 3 tasks sharing updated_at="2026-07-04T10:00:00.000Z" with ids
      s1/s2/s3 (inserted out of order to also verify id-asc sorting).
    - Page 1: pull(since="", since_id="", limit=2) returns s1+s2,
      has_more=True, next_since=ts, next_since_id="s2".
    - Page 2: pull(since=ts, since_id="s2", limit=2) returns s3 only,
      has_more=False.

    Without since_id, page 2 would use WHERE updated_at > ts and skip s3.
    """
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
    page1 = await svc.pull(since="", since_id="", limit=2)
    assert page1["has_more"] is True
    page1_ids = [t["id"] for t in page1["tasks"]]
    assert page1_ids == ["s1", "s2"], (
        f"page 1 should return s1+s2 in id-asc order, got {page1_ids}"
    )
    assert page1["next_since"] == ts
    assert page1["next_since_id"] == "s2", (
        f"page 1 next_since_id should be 's2', got {page1.get('next_since_id')}"
    )

    page2 = await svc.pull(since=ts, since_id="s2", limit=2)
    page2_ids = [t["id"] for t in page2["tasks"]]
    assert page2_ids == ["s3"], (
        f"page 2 should return only s3 (the 3rd same-ts row), got {page2_ids}"
    )
    assert page2["has_more"] is False


@pytest.mark.asyncio
async def test_pull_same_timestamp_5_rows_three_pages_with_since_id(space_session):
    """5 rows with the same updated_at, limit=2: since_id must survive page2.

    Regression: the original implementation only returned next_since_id when
    max_ts advanced past since_n. On page2 all remaining rows still share the
    same timestamp, so max_ts == since_n and next_since_id was dropped. The
    client then fell back to (since, "") and skipped the 5th row.

    Flow:
    - Page 1: pull(since="", since_id="", limit=2) -> s1, s2; next_since_id=s2.
    - Page 2: pull(since=ts, since_id="s2", limit=2) -> s3, s4; has_more=True;
      next_since_id=s4 (this is the regression fix).
    - Page 3: pull(since=ts, since_id="s4", limit=2) -> s5; has_more=False.
    """
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

    page1 = await svc.pull(since="", since_id="", limit=2)
    assert page1["has_more"] is True
    assert [t["id"] for t in page1["tasks"]] == ["s1", "s2"]
    assert page1["next_since"] == ts
    assert page1["next_since_id"] == "s2"

    page2 = await svc.pull(since=ts, since_id="s2", limit=2)
    assert page2["has_more"] is True
    assert [t["id"] for t in page2["tasks"]] == ["s3", "s4"], (
        f"page 2 should return s3+s4, got {[t['id'] for t in page2['tasks']]}"
    )
    assert page2["next_since"] == ts
    assert page2["next_since_id"] == "s4", (
        f"page 2 next_since_id should be 's4', got {page2.get('next_since_id')}"
    )

    page3 = await svc.pull(since=ts, since_id="s4", limit=2)
    assert page3["has_more"] is False
    assert [t["id"] for t in page3["tasks"]] == ["s5"], (
        f"page 3 should return s5, got {[t['id'] for t in page3['tasks']]}"
    )
    assert page3["next_since"] == ts
    assert page3["next_since_id"] == "s5", (
        f"page 3 next_since_id should be 's5', got {page3.get('next_since_id')}"
    )


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
async def test_pull_since_id_with_distinct_timestamps(space_session):
    """since_id is harmless when timestamps are distinct.

    When each row has a unique updated_at, the (ts == since AND id > since_id)
    branch never matches, so the filter reduces to ``updated_at > since``.
    The 2nd row should be returned on page 2 even though since_id is set
    to a value that doesn't share the page-1 timestamp.
    """
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
    page1 = await svc.pull(since="", limit=1)
    assert page1["has_more"] is True
    assert [t["id"] for t in page1["tasks"]] == ["dt-1"]
    next_since = page1["next_since"]
    next_since_id = page1["next_since_id"]
    assert next_since == "2026-07-04T10:00:00.000Z"
    assert next_since_id == "dt-1"

    # Page 2: pass since_id=dt-1 (which is at 10:00, not 11:00). Since dt-2
    # has a different (later) timestamp, the ts > since branch matches and
    # dt-2 is returned. The id > since_id branch is irrelevant here.
    page2 = await svc.pull(since=next_since, since_id=next_since_id, limit=1)
    assert [t["id"] for t in page2["tasks"]] == ["dt-2"], (
        f"page 2 should return dt-2, got {[t['id'] for t in page2['tasks']]}"
    )
    assert page2["has_more"] is False


# --------------------------------------------------------------------------- #
# Tombstone since_id pagination — same-deleted_at rows paged without skip/repeat
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_tombstones_same_timestamp_5_rows_three_pages_with_since_id(space_session):
    """5 tombstones same deleted_at, limit=2: tombstone_since_id must survive page2.

    Flow:
    - Page 1: full(since="", tombstone_since_id="", limit=2) -> t1, t2;
      tombstones_has_more=True; next_tombstone_since_id="t2".
    - Page 2: full(since=ts, tombstone_since_id="t2", limit=2) -> t3, t4;
      tombstones_has_more=True; next_tombstone_since_id="t4".
    - Page 3: full(since=ts, tombstone_since_id="t4", limit=2) -> t5;
      tombstones_has_more=False.

    Without tombstone_since_id, page 2 would use WHERE deleted_at > ts and
    skip t3/t4/t5 (all share the same deleted_at).
    """
    from app.models.tombstone import Tombstone
    from app.services.sync import SyncService

    ts = "2026-07-04T10:00:00.000Z"
    for tid in ["t5", "t3", "t1", "t4", "t2"]:
        tb = Tombstone(entity_type="task", entity_id=tid, deleted_at=ts)
        space_session.add(tb)
    await space_session.flush()

    svc = SyncService(space_session, fs=None)

    page1 = await svc.full(since="", tombstone_since_id="", limit=2)
    assert page1["tombstones_has_more"] is True
    assert [t["entity_id"] for t in page1["tombstones"]] == ["t1", "t2"], (
        f"page 1 should return t1+t2 in entity_id-asc order, "
        f"got {[t['entity_id'] for t in page1['tombstones']]}"
    )
    assert page1["next_tombstone_since_id"] == "t2", (
        f"page 1 next_tombstone_since_id should be 't2', "
        f"got {page1.get('next_tombstone_since_id')}"
    )

    page2 = await svc.full(since=ts, tombstone_since_id="t2", limit=2)
    assert page2["tombstones_has_more"] is True
    assert [t["entity_id"] for t in page2["tombstones"]] == ["t3", "t4"], (
        f"page 2 should return t3+t4, "
        f"got {[t['entity_id'] for t in page2['tombstones']]}"
    )
    assert page2["next_tombstone_since_id"] == "t4", (
        f"page 2 next_tombstone_since_id should be 't4', "
        f"got {page2.get('next_tombstone_since_id')}"
    )

    page3 = await svc.full(since=ts, tombstone_since_id="t4", limit=2)
    assert page3["tombstones_has_more"] is False
    assert [t["entity_id"] for t in page3["tombstones"]] == ["t5"], (
        f"page 3 should return only t5, "
        f"got {[t['entity_id'] for t in page3['tombstones']]}"
    )


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
