"""TS-04: the Space committed-change SSE stream.

``GET /api/v1/sync/v2/events?space_id=<id>``

This endpoint is an **invalidation hint**, not a data channel.  It exists so an
idle client can learn that committed changes exist and run its existing Sync v2
cycle, instead of waiting for an unrelated local trigger.

Contract
--------
- Authorization is the ordinary one: a space token plus the Space registry
  (registration, deletion, epoch).  A revoked or deleted Space cannot hold a
  stream.
- Every event is named ``task_space_changed`` and carries an SSE ``id`` plus
  JSON data of exactly ``{"space_id", "visible_watermark"}``.  There is no
  post-image, relation row, derived task-space field, cursor or ACK — the
  payload is auditable by reading one function.
- On connect (and reconnect) the current visible watermark is read once from
  the durable ledger and emitted immediately.  That initial hint is what makes
  a dropped notification safe: the client re-syncs and catches up through the
  ordinary Sync v2 pull/recovery path, whatever it may have missed.
- Heartbeat comments are emitted within the configured idle interval so
  intermediaries do not reap a healthy connection.

Resource discipline
-------------------
No database transaction and no mutation lease is held for the stream's
lifetime.  The watermark read opens a short-lived runtime handle and closes it
before streaming begins; the subscriber side is pure in-process fan-out.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from app.auth.authority import Principal
from app.deps import get_current_user
from app.sync.notifications import SpaceChangeNotifier, space_change_notifier

router = APIRouter()

#: SSE event name.  Clients key their handler off this literal.
TASK_SPACE_CHANGED_EVENT = "task_space_changed"
#: Idle interval after which a comment heartbeat is written (seconds).
SSE_HEARTBEAT_SECONDS = 15.0
#: How often an idle stream re-verifies that its Space is still authorized.
SSE_AUTHORITY_RECHECK_SECONDS = 30.0

SpaceId = Annotated[str, Query(min_length=1, max_length=64)]


def _principal(user: dict[str, Any]) -> Principal:
    return Principal(
        subject=str(user.get("sub")),
        token_type=str(user.get("type")),  # type: ignore[arg-type]
        epoch=int(user.get("epoch", 0)),
        expires_at=user.get("exp") if isinstance(user.get("exp"), int) else None,
        space_id=user.get("space_id"),
    )


def _sse_frame(*, event_id: str, event: str, payload: dict[str, object]) -> bytes:
    """One SSE frame.  ``json.dumps`` is the only serializer used."""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event_id}\nevent: {event}\ndata: {body}\n\n".encode()


def _heartbeat_frame() -> bytes:
    return b": heartbeat\n\n"


async def read_visible_watermark(
    request: Request, principal: Principal, space_id: str
) -> int:
    """Authorize the Space and return its newest visible ledger sequence.

    Authorization and the read deliberately share one short-lived handle:
    opening a second handle after closing the first would evict the Space
    engine the read depends on.  Registration, deletion and epoch validation
    are the production registry checks, so a revoked, deleted or foreign Space
    fails here with the ordinary authorization error.

    The returned position is the same one a Sync v2 pull observes, so
    announcing it cannot promise a subscriber more than it can actually fetch.
    """
    from sqlalchemy import func, select

    from app.models.sync_outbox import SyncOutbox

    handle = await _open_space_handle(request, principal, space_id)
    try:
        # A Space handle only exposes its engine while Space resources are
        # active under a lease; this is the same activation the mutation and
        # sync paths use.  The lease is released again before this call
        # returns, so no lease or transaction outlives the read.
        async with handle.exclusive_space_resources("sync-events-read", 5):
            async with handle.session_factory() as space_session:
                watermark = await space_session.scalar(
                    select(func.max(SyncOutbox.id)).where(
                        SyncOutbox.visible.is_(True)
                    )
                )
    finally:
        await handle.aclose()
    return int(watermark or 0)


async def _open_space_handle(request: Request, principal: Principal, space_id: str):
    """Open one Space handle through the production scope opener.

    Uses the same ``RuntimeServices.scope`` opener every other Space-scoped
    route uses, so registration / deletion / epoch validation matches exactly.
    The handle is opened and closed within a single call — no lease or
    database transaction is held for the lifetime of a stream.
    """
    services = getattr(request.app.state, "runtime_services", None)
    if services is None:
        raise RuntimeError("RuntimeServices are not installed")
    return await services.scope.open(principal, space_id, "write")


class SpaceEventStream:
    """Renders the SSE byte stream from the notifier plus a watermark read."""

    def __init__(
        self,
        *,
        notifier: SpaceChangeNotifier,
        watermark_reader: Callable[[], Awaitable[int]],
        authority_check: Callable[[], Awaitable[None]] | None = None,
        heartbeat_seconds: float = SSE_HEARTBEAT_SECONDS,
        authority_recheck_seconds: float = SSE_AUTHORITY_RECHECK_SECONDS,
    ) -> None:
        self._notifier = notifier
        self._read_watermark = watermark_reader
        self._check_authority = authority_check
        self._heartbeat = heartbeat_seconds
        self._recheck = authority_recheck_seconds

    async def frames(self, space_id: str) -> AsyncIterator[bytes]:
        """Yield SSE frames until the client goes away or authority is lost.

        The connect-time watermark is emitted first (when non-zero), then the
        stream alternates between delivered hints and heartbeats.  A closed
        notifier or a lost subscription ends the stream rather than spinning.
        """
        watermark = await self._read_watermark()
        async with self._notifier.subscribe(
            space_id, initial_watermark=watermark
        ) as stream:
            iterator = stream.__aiter__()
            last_check = asyncio.get_running_loop().time()
            while True:
                try:
                    change = await asyncio.wait_for(
                        iterator.__anext__(), timeout=self._heartbeat
                    )
                except StopAsyncIteration:
                    return
                except TimeoutError:
                    yield _heartbeat_frame()
                    if self._check_authority is not None:
                        now = asyncio.get_running_loop().time()
                        if now - last_check >= self._recheck:
                            last_check = now
                            # A revoked or deleted Space must not hold a stream
                            # open: re-verify through the ordinary registry.
                            await self._check_authority()
                    continue
                yield _sse_frame(
                    event_id=change.event_id,
                    event=TASK_SPACE_CHANGED_EVENT,
                    payload=change.to_payload(),
                )


async def space_event_stream_response(
    *,
    request: Request,
    space_id: str,
    user: dict[str, Any],
    heartbeat_seconds: float = SSE_HEARTBEAT_SECONDS,
) -> StreamingResponse:
    """Authorize, then build the SSE response for one Space.

    Split out from the route so the stream generator can be driven directly in
    tests: an SSE body does not terminate, and a buffering test transport can
    never hand back a partial body.
    """
    principal = _principal(user)
    # Normal Space authorization first: registration, deletion and epoch are
    # all validated by the shared registry path before a stream is opened.
    await read_visible_watermark(request, principal, space_id)

    async def watermark_reader() -> int:
        return await read_visible_watermark(request, principal, space_id)

    async def authority_check() -> None:
        # Re-runs the same authorizing read: a revoked or deleted Space stops
        # the stream instead of silently holding an unauthorized connection.
        await read_visible_watermark(request, principal, space_id)

    stream = SpaceEventStream(
        notifier=space_change_notifier,
        watermark_reader=watermark_reader,
        authority_check=authority_check,
        heartbeat_seconds=heartbeat_seconds,
    )
    return StreamingResponse(
        stream.frames(space_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Defensive: the stream must never be buffered by a proxy.
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/v2/events")
async def stream_space_change_events(
    request: Request,
    space_id: SpaceId,
    user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    """Stream Space-scoped change invalidations (``text/event-stream``).

    The response carries only watermark hints; the client is expected to run
    its normal Sync v2 cycle on each one.
    """
    return await space_event_stream_response(
        request=request, space_id=space_id, user=user
    )


__all__ = [
    "SSE_AUTHORITY_RECHECK_SECONDS",
    "SSE_HEARTBEAT_SECONDS",
    "TASK_SPACE_CHANGED_EVENT",
    "SpaceEventStream",
    "read_visible_watermark",
    "space_event_stream_response",
    "router",
]
