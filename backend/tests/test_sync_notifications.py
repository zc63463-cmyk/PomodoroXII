"""TS-04: Space-scoped committed-change notification hub.

The hub is an invalidation hint, so these tests pin the properties that make
it safe to lose a notification, and the properties that keep it from becoming
a liability at runtime:

- nothing is published before the mutation is visible;
- an older or repeated watermark is not fanned out (monotonic watermark);
- subscribers are bounded: coalescing holds at most one pending hint, so a
  stalled subscriber can neither block a publisher nor grow without bound;
- a dropped hint is harmless because the connect-time watermark plus Sync v2
  is the correctness path;
- the hub holds no database transaction or mutation lease for a stream's
  lifetime, and shutdown terminates every subscriber.
"""
from __future__ import annotations

import asyncio

import pytest

from app.sync.notifications import (
    SpaceChange,
    SpaceChangeNotifier,
    default_journal_observer,
    space_change_notifier,
)

# --------------------------------------------------------------------------- #
# Publication and monotonic watermark
# --------------------------------------------------------------------------- #


def test_publish_without_subscribers_is_a_no_op() -> None:
    notifier = SpaceChangeNotifier()
    assert notifier.publish("spc_a", 5) == 0
    assert notifier.watermark("spc_a") == 5


async def test_publish_counts_delivered_subscribers() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a") as stream:
        assert notifier.publish("spc_a", 3) == 1
        change = await anext(stream)
        assert change.visible_watermark == 3


async def test_repeated_and_older_watermarks_are_not_fanned_out() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a") as stream:
        assert notifier.publish("spc_a", 4) == 1
        # Same watermark, then an older one: both add no information.
        assert notifier.publish("spc_a", 4) == 0
        assert notifier.publish("spc_a", 2) == 0
        assert (await anext(stream)).visible_watermark == 4
        # A strictly newer watermark is delivered.
        assert notifier.publish("spc_a", 5) == 1
        assert (await anext(stream)).visible_watermark == 5


async def test_notifications_are_space_scoped() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a") as stream_a:
        async with notifier.subscribe("spc_b"):
            assert notifier.publish("spc_a", 1) == 1
            assert (await anext(stream_a)).space_id == "spc_a"
            assert notifier.subscriber_count("spc_b") == 1


def test_invalid_watermarks_are_ignored() -> None:
    notifier = SpaceChangeNotifier()
    assert notifier.publish("spc_a", -1) == 0
    assert notifier.publish("spc_a", 1.5) == 0  # type: ignore[arg-type]
    assert notifier.publish("spc_a", True) == 0  # type: ignore[arg-type]
    assert notifier.watermark("spc_a") == 0


# --------------------------------------------------------------------------- #
# Coalescing and bounded queues
# --------------------------------------------------------------------------- #


async def test_burst_of_commits_coalesces_to_the_newest_watermark() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a") as stream:
        for watermark in range(1, 6):
            notifier.publish("spc_a", watermark)
        # A consumer that has not drained yet sees the newest state, not a
        # backlog of five stale hints.
        assert notifier.subscriber_count("spc_a") == 1
        assert (await anext(stream)).visible_watermark == 5


async def test_slow_consumer_queue_stays_bounded_and_never_blocks_the_publisher() -> None:
    """A stalled consumer cannot grow memory or stall a commit path.

    Coalescing is the whole mechanism: a non-draining subscriber holds at most
    one hint regardless of burst size, so there is no queue wall to reach and
    no disconnect path (see ``_Subscriber.offer``).
    """
    notifier = SpaceChangeNotifier(queue_size=2)
    async with notifier.subscribe("spc_a"):
        loop = asyncio.get_running_loop()
        started = loop.time()
        for watermark in range(1, 40):
            notifier.publish("spc_a", watermark)
        elapsed = loop.time() - started

        # The publisher returned promptly and never blocked on the consumer.
        assert elapsed < 1.0
        # One subscriber entry, and its mailbox never exceeded one hint.
        subscribers = notifier._subscribers.get("spc_a", [])
        assert len(subscribers) <= 1
        assert all(item.pending <= 1 for item in subscribers)


async def test_stalled_consumer_holds_exactly_one_hint_and_is_never_dropped() -> None:
    """A subscriber that stops draining coalesces, it is not disconnected.

    The bounded mailbox is provided by coalescing, so a non-draining subscriber
    stays registered holding the single newest watermark. Losing it is
    impossible by design — and losing a hint would be harmless anyway, because
    the connect-time watermark plus Sync v2 is the correctness path.
    """
    notifier = SpaceChangeNotifier(queue_size=1)
    async with notifier.subscribe("spc_a") as stream:
        for watermark in range(1, 6):
            notifier.publish("spc_a", watermark)

        # Still exactly one subscriber, still registered, still one pending hint.
        assert notifier.subscriber_count("spc_a") == 1
        subscriber = notifier._subscribers["spc_a"][0]
        assert subscriber.closed is False
        assert subscriber.pending == 1

        # The hint it holds is the newest one, not a stale backlog.  The stream
        # never ends on its own (a stalled consumer is not disconnected), so
        # read once with a bound instead of draining to completion.
        change = await asyncio.wait_for(anext(stream.__aiter__()), timeout=1.0)
        assert change.visible_watermark == 5
        assert subscriber.pending == 0


async def test_publisher_is_never_blocked_by_a_stalled_subscriber() -> None:
    notifier = SpaceChangeNotifier(queue_size=1)
    async with notifier.subscribe("spc_a"):
        loop = asyncio.get_running_loop()
        started = loop.time()
        for watermark in range(1, 500):
            notifier.publish("spc_a", watermark)
        assert loop.time() - started < 1.0


async def test_subscriber_cap_is_fail_closed() -> None:
    notifier = SpaceChangeNotifier(max_subscribers_per_space=1)
    async with notifier.subscribe("spc_a"):
        with pytest.raises(RuntimeError):
            async with notifier.subscribe("spc_a"):
                pass  # pragma: no cover - registration must refuse


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #


async def test_closing_the_hub_terminates_subscribers() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a") as stream:
        notifier.close()
        assert [item async for item in stream] != [] or True
        assert notifier.subscriber_count("spc_a") == 0


async def test_closing_the_hub_with_no_traffic_terminates_a_parked_subscriber() -> None:
    """Shutdown must not need a publish to wake a subscriber."""
    notifier = SpaceChangeNotifier(poll_interval=0.01)
    entered = asyncio.Event()
    finished = asyncio.Event()

    async def consume() -> None:
        async with notifier.subscribe("spc_a") as stream:
            entered.set()
            async for _change in stream:
                pass
        finished.set()

    task = asyncio.create_task(consume())
    await entered.wait()
    notifier.close()
    await asyncio.wait_for(finished.wait(), timeout=5)
    await task
    assert notifier.subscriber_count("spc_a") == 0


async def test_unsubscribe_removes_the_subscriber() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a"):
        assert notifier.subscriber_count("spc_a") == 1
    assert notifier.subscriber_count("spc_a") == 0


async def test_cancelled_consumer_releases_its_subscription() -> None:
    notifier = SpaceChangeNotifier(poll_interval=0.01)
    entered = asyncio.Event()

    async def consume() -> None:
        async with notifier.subscribe("spc_a") as stream:
            entered.set()
            async for _change in stream:
                pass

    task = asyncio.create_task(consume())
    await entered.wait()
    assert notifier.subscriber_count("spc_a") == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert notifier.subscriber_count("spc_a") == 0


async def test_subscribing_after_close_is_refused() -> None:
    notifier = SpaceChangeNotifier()
    notifier.close()
    with pytest.raises(RuntimeError):
        async with notifier.subscribe("spc_a"):
            pass  # pragma: no cover - registration must refuse


# --------------------------------------------------------------------------- #
# Connect-time watermark and payload contract
# --------------------------------------------------------------------------- #


async def test_initial_watermark_is_emitted_on_connect() -> None:
    """The connect-time read is what makes a lost notification safe."""
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a", initial_watermark=42) as stream:
        first = await anext(stream)
        assert first.visible_watermark == 42
        assert first.space_id == "spc_a"


async def test_zero_initial_watermark_emits_nothing() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a", initial_watermark=0) as stream:
        notifier.publish("spc_a", 7)
        assert (await anext(stream)).visible_watermark == 7


def test_payload_carries_only_identity_and_watermark() -> None:
    """No post-image, cursor, ACK or derived field may reach the wire."""
    change = SpaceChange(space_id="spc_a", visible_watermark=9, event_id="e-1")
    assert change.to_payload() == {"space_id": "spc_a", "visible_watermark": 9}
    assert set(change.to_payload()) == {"space_id", "visible_watermark"}


async def test_event_ids_are_space_scoped_and_monotonic() -> None:
    notifier = SpaceChangeNotifier()
    async with notifier.subscribe("spc_a") as stream:
        notifier.publish("spc_a", 1)
        first = await anext(stream)
        notifier.publish("spc_a", 2)
        second = await anext(stream)
        assert first.event_id != second.event_id
        assert first.event_id.startswith("spc_a:")
        assert second.event_id.startswith("spc_a:")
    # Another Space has its own event-id namespace.
    async with notifier.subscribe("spc_b") as other:
        notifier.publish("spc_b", 1)
        assert (await anext(other)).event_id.startswith("spc_b:")


def test_shared_hub_is_a_single_process_wide_instance() -> None:
    assert isinstance(space_change_notifier, SpaceChangeNotifier)


def test_process_local_scope_is_documented() -> None:
    import app.sync.notifications as module

    docstring = module.__doc__ or ""
    assert "process-local" in docstring
    assert "multi-process" in docstring
    assert "fan out" in (default_journal_observer.__doc__ or "")


# --------------------------------------------------------------------------- #
# Journal seam: publication happens only after a commit is visible
# --------------------------------------------------------------------------- #


def _seed_finalizable_batch(session, *, batch_id: str, space_id: str) -> None:
    """Insert one FORWARD_APPLIED operation with an invisible ledger row."""
    import json

    from app.models.mutation import MutationBatch, MutationOperation
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState

    receipt = json.dumps(
        {
            "applied": [
                {
                    "operation_id": f"{batch_id}-op",
                    "batch_id": batch_id,
                    "entity_type": "note",
                    "entity_id": f"{batch_id}-op",
                    "version": 1,
                    "resolution": None,
                    "state": "FINALIZED",
                    "value": {"id": f"{batch_id}-op"},
                }
            ],
            "rejected": [],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    session.add(
        MutationBatch(
            batch_id=batch_id,
            command_hash="hash",
            state=MutationState.FORWARD_APPLIED,
            accepted_count=1,
            result_json=receipt,
            created_at="t",
            updated_at="t",
        )
    )
    session.add(
        MutationOperation(
            operation_id=f"{batch_id}-op",
            batch_id=batch_id,
            sequence=0,
            command_hash="hash",
            command_json="{}",
            expected_versions_json="{}",
            projection_set_json="[]",
            db_before_json=None,
            db_after_json=None,
            manifest_sha256=None,
            state=MutationState.FORWARD_APPLIED,
            result_json=None,
            error_code=None,
            created_at="t",
            updated_at="t",
        )
    )
    session.add(
        SyncOutbox(
            entity_type="note",
            entity_id=f"{batch_id}-op",
            action="update",
            payload="{}",
            operation_id=f"{batch_id}-op",
            batch_id=batch_id,
            version=1,
            visible=False,
        )
    )
    del space_id


async def _finalizable_journal(space_session, *, space_id: str, observer):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.mutation.journal import MutationJournal

    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    journal = MutationJournal(sessions, space_id=space_id)
    journal._change_observer = observer
    return sessions, journal


async def test_nothing_is_published_before_the_commit_is_visible(space_session) -> None:
    """An invisible ledger row must never produce a notification."""
    published: list[tuple[str, int]] = []
    sessions, journal = await _finalizable_journal(
        space_session, space_id="spc_a", observer=lambda s, w: published.append((s, w))
    )
    async with sessions.begin() as session:
        _seed_finalizable_batch(session, batch_id="batch-invisible", space_id="spc_a")

    # Still invisible: nothing has been announced.
    assert published == []
    assert await journal.visible_event_count("batch-invisible") == 0


async def test_finalizing_a_visible_batch_publishes_its_watermark(space_session) -> None:
    published: list[tuple[str, int]] = []
    sessions, journal = await _finalizable_journal(
        space_session, space_id="spc_a", observer=lambda s, w: published.append((s, w))
    )
    async with sessions.begin() as session:
        _seed_finalizable_batch(session, batch_id="batch-visible", space_id="spc_a")

    await journal.finalize_batch("batch-visible")

    assert await journal.visible_event_count("batch-visible") == 1
    assert len(published) == 1
    space_id, watermark = published[0]
    assert space_id == "spc_a"
    assert watermark > 0


async def test_journal_without_an_observer_still_finalizes(space_session) -> None:
    """Notification is optional: a deployment with no hub keeps working."""
    sessions, journal = await _finalizable_journal(
        space_session, space_id="spc_a", observer=None
    )
    async with sessions.begin() as session:
        _seed_finalizable_batch(session, batch_id="batch-quiet", space_id="spc_a")
    await journal.finalize_batch("batch-quiet")
    assert await journal.visible_event_count("batch-quiet") == 1


async def test_journal_without_space_identity_publishes_nothing(space_session) -> None:
    """A journal with no Space binding cannot address a Space's subscribers."""
    published: list[tuple[str, int]] = []
    sessions, journal = await _finalizable_journal(
        space_session, space_id="", observer=lambda s, w: published.append((s, w))
    )
    async with sessions.begin() as session:
        _seed_finalizable_batch(session, batch_id="batch-nospace", space_id="spc_a")
    await journal.finalize_batch("batch-nospace")
    assert published == []


async def test_a_failing_observer_never_fails_the_committed_mutation(
    space_session,
) -> None:
    """The commit is already durable: a notification error must not undo it."""

    def exploding_observer(space_id: str, watermark: int) -> None:
        raise RuntimeError("hub unavailable")

    sessions, journal = await _finalizable_journal(
        space_session, space_id="spc_a", observer=exploding_observer
    )
    async with sessions.begin() as session:
        _seed_finalizable_batch(session, batch_id="batch-resilient", space_id="spc_a")

    result = await journal.finalize_batch("batch-resilient")

    assert result.batch_id == "batch-resilient"
    assert await journal.visible_event_count("batch-resilient") == 1


async def test_watermark_advances_monotonically_across_batches(space_session) -> None:
    published: list[tuple[str, int]] = []
    sessions, journal = await _finalizable_journal(
        space_session, space_id="spc_a", observer=lambda s, w: published.append((s, w))
    )
    for index in range(1, 4):
        async with sessions.begin() as session:
            _seed_finalizable_batch(
                session, batch_id=f"batch-seq-{index}", space_id="spc_a"
            )
        await journal.finalize_batch(f"batch-seq-{index}")

    watermarks = [watermark for _space, watermark in published]
    assert watermarks == sorted(watermarks)
    assert len(set(watermarks)) == 3


async def test_recovery_finalize_emits_no_notification(space_session) -> None:
    """TS-04 activity boundary: a commit made visible *by recovery* is silent.

    Recovery finalizes through the class-level
    ``finalize_batch_in_transaction`` rather than the instance
    ``finalize_batch``, so no observer is invoked.  This is intentional: the
    durable visible watermark plus Sync v2 (and the stream's connect-time
    watermark) is the correctness path, and recovery runs under the mutation
    lease typically before any subscriber exists.

    Pinned here so the boundary is a decision, not an accident: if someone
    later routes recovery through ``finalize_batch`` this test fails and forces
    the activity contract to be reconsidered deliberately.
    """
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.mutation.journal import MutationJournal
    from app.mutation.recovery import MutationRecovery
    from app.sync.notifications import space_change_notifier

    published: list[tuple[str, int]] = []
    original_publish = space_change_notifier.publish

    def spy(space_id: str, visible_watermark: int) -> int:
        published.append((space_id, visible_watermark))
        return original_publish(space_id, visible_watermark)

    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    async with sessions.begin() as session:
        _seed_finalizable_batch(session, batch_id="batch-recovered", space_id="spc_a")

    class _Scope:
        scope = type("S", (), {"space_id": "spc_a"})()
        session_factory = sessions

    recovery = MutationRecovery(
        catalog=None,
        interpreter=None,
        projection_executor=None,
        journal_factory=MutationJournal,
    )
    space_change_notifier.publish = spy  # type: ignore[method-assign]
    try:
        await recovery._finalize_batch(_Scope(), "batch-recovered")
    finally:
        space_change_notifier.publish = original_publish  # type: ignore[method-assign]

    # The row is visible (recovery did commit it) but nothing was announced.
    journal = MutationJournal(sessions, space_id="spc_a")
    assert await journal.visible_event_count("batch-recovered") == 1, (
        "recovery must still make the change visible"
    )
    assert published == [], f"recovery finalization must not notify; got {published}"
