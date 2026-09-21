"""TS-04: Space-scoped committed-change notification hub.

Purpose and boundary
--------------------
An idle client has no polling trigger: today a change made by another device
becomes visible only when *this* device happens to run a sync cycle.  This hub
turns "the mutation journal finalized a visible commit" into a low-latency
wakeup so a subscribed client can run its **existing** Sync v2 cycle.

It is an *invalidation hint*, never a data channel:

- a notification carries only ``space_id``, a monotonic visible watermark and a
  Space-scoped event id — no post-image, no row, no derived field, no cursor
  and no ACK;
- correctness never depends on delivery.  The watermark a subscriber reads on
  connect/reconnect plus the existing Sync v2 pull/recovery path is the sole
  source of truth, so a dropped, coalesced or duplicated notification is
  harmless;
- publishing happens only after the visibility transaction has committed, so a
  subscriber can never be told about a change it cannot yet pull.

Operational guarantees
----------------------
- Subscriber queues are bounded; a subscriber that stops draining is
  disconnected rather than allowed to grow memory or stall a publisher.
- Repeated watermarks for one Space coalesce: a subscriber always sees the
  newest visible watermark, never a backlog of stale hints.
- No database transaction or mutation lease is held for the lifetime of a
  stream: the hub is pure in-process fan-out, and the route re-reads the
  durable watermark through the normal ledger read path.

★ Scope boundary (explicit): this hub is **process-local**.  A multi-process
deployment does not share these queues, so a client connected to worker A is
not woken by a commit finalized in worker B — its stream still emits on
connect/reconnect and its own sync triggers still work, which is why
correctness is unaffected.  Cross-process fan-out requires a shared broker and
is a deliberate deployment decision, not something this module pretends to
provide.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass

#: Per-subscriber queue depth.  A subscriber that falls this far behind is
#: considered stalled and is disconnected (see ``_Subscriber.offer``).
DEFAULT_SUBSCRIBER_QUEUE_SIZE = 8
#: Closed-flag re-check interval for a parked subscriber (seconds).
DEFAULT_SUBSCRIBER_POLL_SECONDS = 0.25
#: Hard cap on concurrent subscribers of one Space.
DEFAULT_MAX_SUBSCRIBERS_PER_SPACE = 64


@dataclass(frozen=True, slots=True)
class SpaceChange:
    """One invalidation hint: identity and watermark only."""

    space_id: str
    visible_watermark: int
    event_id: str

    def to_payload(self) -> dict[str, object]:
        """The complete wire payload — deliberately just these two fields."""
        return {
            "space_id": self.space_id,
            "visible_watermark": self.visible_watermark,
        }


class _Subscriber:
    """One bounded subscriber mailbox with coalescing by watermark."""

    __slots__ = ("_closed", "_poll", "_queue", "_queue_size", "dropped", "space_id")

    def __init__(self, space_id: str, queue_size: int, poll_interval: float) -> None:
        self.space_id = space_id
        self._queue_size = queue_size
        #: How often a parked consumer re-checks the closed flag.  Bounds the
        #: shutdown latency of a stream with no traffic.
        self._poll = poll_interval
        self._queue: asyncio.Queue[SpaceChange | None] = asyncio.Queue(
            maxsize=queue_size
        )
        self._closed = False
        #: Number of hints coalesced away for this subscriber (observability).
        self.dropped = 0

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def pending(self) -> int:
        return self._queue.qsize()

    def offer(self, change: SpaceChange) -> bool:
        """Try to enqueue ``change``; return False if this subscriber is stale.

        Coalescing rule: if the queue already holds a hint, replace the newest
        unconsumed hint with this one *when it carries a greater watermark*.
        A subscriber only ever needs the newest state, so collapsing hints is
        both safe and the intended behavior for a burst of commits.
        """
        if self._closed:
            return False
        if self._queue.full():
            # The consumer is not draining at all: drop it instead of blocking
            # the publisher or growing without bound.
            self._closed = True
            return False
        while not self._queue.empty():
            existing = self._queue.get_nowait()
            if existing is not None and existing.visible_watermark >= change.visible_watermark:
                # Keep the newer hint we already have; merge this one away.
                self._queue.put_nowait(existing)
                self._dropped_increment()
                return True
            self._dropped_increment()
        try:
            self._queue.put_nowait(change)
        except asyncio.QueueFull:  # pragma: no cover - guarded above
            self._closed = True
            return False
        return True

    def _dropped_increment(self) -> None:
        self.dropped += 1

    def close(self) -> None:
        """Wake the consumer so it can observe the close and exit."""
        self._closed = True
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:  # pragma: no cover - best effort wakeup
            pass

    async def next_change(self) -> SpaceChange | None:
        """Await the next hint, or None when this subscriber is closed.

        Polls the closed flag rather than relying solely on a sentinel wakeup,
        so closure is observed even when the queue is empty and even when the
        consumer is cancelled while parked here.  ``close()`` remains the fast
        path (it queues a wakeup); this loop is the guaranteed one.
        """
        while True:
            if self._closed and self._queue.empty():
                return None
            try:
                change = await asyncio.wait_for(self._queue.get(), timeout=self._poll)
            except TimeoutError:
                continue
            return change


class SpaceChangeNotifier:
    """Process-local publish/subscribe hub keyed by Space."""

    def __init__(
        self,
        *,
        queue_size: int = DEFAULT_SUBSCRIBER_QUEUE_SIZE,
        max_subscribers_per_space: int = DEFAULT_MAX_SUBSCRIBERS_PER_SPACE,
        poll_interval: float = DEFAULT_SUBSCRIBER_POLL_SECONDS,
    ) -> None:
        if queue_size < 1:
            raise ValueError("queue_size must be positive")
        if max_subscribers_per_space < 1:
            raise ValueError("max_subscribers_per_space must be positive")
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        self._queue_size = queue_size
        self._max_subscribers = max_subscribers_per_space
        self._poll_interval = poll_interval
        self._subscribers: dict[str, list[_Subscriber]] = {}
        self._sequences: dict[str, int] = {}
        self._watermarks: dict[str, int] = {}
        self._closed = False

    # -- publication ---------------------------------------------------- #

    def publish(self, space_id: str, visible_watermark: int) -> int:
        """Publish one committed visible watermark; return the subscriber count.

        Called only after the mutation journal has finalized the batch and the
        visibility transaction has committed.  Must never raise into the
        mutation path: a failure to notify delays a wakeup but cannot make a
        committed mutation incorrect.
        """
        if self._closed or type(visible_watermark) is not int or visible_watermark < 0:
            return 0
        previous = self._watermarks.get(space_id, 0)
        if visible_watermark <= previous:
            # Monotonic watermark: an older or equal watermark adds no
            # information, so it is not fanned out at all.
            return 0
        self._watermarks[space_id] = visible_watermark
        sequence = self._sequences.get(space_id, 0) + 1
        self._sequences[space_id] = sequence
        change = SpaceChange(
            space_id=space_id,
            visible_watermark=visible_watermark,
            event_id=f"{space_id}:{sequence}:{visible_watermark}",
        )
        delivered = 0
        for subscriber in list(self._subscribers.get(space_id, ())):
            if subscriber.offer(change):
                delivered += 1
        self._reap_closed(space_id)
        return delivered

    def watermark(self, space_id: str) -> int:
        """The newest watermark this process has published for ``space_id``."""
        return self._watermarks.get(space_id, 0)

    # -- subscription --------------------------------------------------- #

    @asynccontextmanager
    async def subscribe(
        self, space_id: str, *, initial_watermark: int = 0
    ) -> AsyncIterator[AsyncIterator[SpaceChange]]:
        """Yield a bounded async iterator of hints for exactly one Space."""
        subscriber = self._register(space_id)
        try:
            yield self._iterate(subscriber, initial_watermark)
        finally:
            subscriber.close()
            self._unregister(space_id, subscriber)

    def _register(self, space_id: str) -> _Subscriber:
        if self._closed:
            raise RuntimeError("SpaceChangeNotifier is closed")
        subscribers = self._subscribers.setdefault(space_id, [])
        if len(subscribers) >= self._max_subscribers:
            # Fail closed: refuse the new subscriber rather than let one Space
            # accumulate unbounded queues.
            raise RuntimeError("too many subscribers for this Space")
        subscriber = _Subscriber(space_id, self._queue_size, self._poll_interval)
        subscribers.append(subscriber)
        return subscriber

    def _unregister(self, space_id: str, subscriber: _Subscriber) -> None:
        subscribers = self._subscribers.get(space_id)
        if subscribers is None:
            return
        try:
            subscribers.remove(subscriber)
        except ValueError:
            return
        if not subscribers:
            self._subscribers.pop(space_id, None)

    def _reap_closed(self, space_id: str) -> None:
        subscribers = self._subscribers.get(space_id)
        if subscribers is None:
            return
        remaining = [item for item in subscribers if not item.closed]
        if remaining:
            self._subscribers[space_id] = remaining
        else:
            self._subscribers.pop(space_id, None)

    async def _iterate(
        self, subscriber: _Subscriber, initial_watermark: int
    ) -> AsyncIterator[SpaceChange]:
        """Stream hints, emitting the connect-time watermark first.

        The initial hint is what makes a dropped notification safe: a
        (re)connecting client always learns the currently visible watermark and
        can run the ordinary Sync v2 catch-up, whether or not any notification
        reaches it while connected.
        """
        if initial_watermark > 0:
            yield SpaceChange(
                space_id=subscriber.space_id,
                visible_watermark=initial_watermark,
                event_id=f"{subscriber.space_id}:0:{initial_watermark}",
            )
        while True:
            change = await subscriber.next_change()
            if change is None:
                return
            yield change

    # -- lifecycle ------------------------------------------------------ #

    def subscriber_count(self, space_id: str) -> int:
        return len(self._subscribers.get(space_id, ()))

    def close(self) -> None:
        """Shut the hub down, waking every subscriber so streams terminate."""
        self._closed = True
        for subscribers in self._subscribers.values():
            for subscriber in subscribers:
                subscriber.close()
        self._subscribers.clear()


#: Process-wide hub used by the journal hook and the SSE route.
space_change_notifier = SpaceChangeNotifier()

#: Observer installed on the mutation journal factory.  Kept as a module-level
#: seam so a test (or a future shared-broker deployment) can swap the sink
#: without the mutation core knowing anything about transport.
JournalChangeObserver = Callable[[str, int], None]


def default_journal_observer(space_id: str, visible_watermark: int) -> None:
    """Default sink: fan out through the process-local hub."""
    space_change_notifier.publish(space_id, visible_watermark)


__all__ = [
    "DEFAULT_MAX_SUBSCRIBERS_PER_SPACE",
    "DEFAULT_SUBSCRIBER_POLL_SECONDS",
    "DEFAULT_SUBSCRIBER_QUEUE_SIZE",
    "JournalChangeObserver",
    "SpaceChange",
    "SpaceChangeNotifier",
    "default_journal_observer",
    "space_change_notifier",
]
