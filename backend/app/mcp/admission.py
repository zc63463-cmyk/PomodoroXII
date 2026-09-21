"""TS-03: MCP task-space write admission (bounded, fail-closed).

MCP is reachable over two transports, and neither passes through the HTTP
middleware stack that protects the REST batch endpoint
(:mod:`app.rate_limit`):

- ``stdio`` runs in-process for a local agent — ``trusted_stdio`` is an
  *identity mode*, never a caller-controlled budget bypass;
- ``http`` mounts FastMCP, whose own stack is not the app's
  ``RateLimitMiddleware``.

Admission therefore lives at the shared authenticated MCP boundary and is
enforced **before** any mutation runtime is opened, so an over-budget call
cannot reach the UoW, the journal, or the business database.

Budget accounting
-----------------
- Key: ``(principal.subject, space_id)``.  The key is derived only from the
  transport-authenticated principal, so a tool argument such as ``client_id``
  can never select someone else's budget.
- Units: one per subcommand.  A batch of *n* commands reserves *n* units, is
  charged by the number of accepted commands, and the unused remainder of the
  reservation is returned.  A batch whose size exceeds the remaining budget is
  rejected whole, before charging.
- Lifecycle: :meth:`McpWriteAdmission.check` reserves; the caller must then
  either :meth:`AdmissionLease.commit` (execution succeeded) or
  :meth:`AdmissionLease.release` (pre-execution rejection: authorization
  failure, validation failure, …).  A released reservation burns nothing.

★ Scope boundary (explicit, not silently claimed): this budget is
**process-local**.  A multi-process deployment (several workers, stdio agents
plus an HTTP worker, a future shared broker) does not share these counters, so
the effective aggregate limit multiplies by the number of processes.  A shared
multi-process quota requires a shared counter (database or broker) and is a
deliberate infrastructure decision, not something this module pretends to
provide.
"""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from collections.abc import Callable

from app.auth.authority import Principal
from app.errors import AppError
from app.task_space.contracts import TASK_SPACE_BATCH_MAX_COMMANDS

#: Sliding-window capacity per ``(principal.subject, space_id)``.
#: Bounded by the task-space batch limit so one maximum-size batch can never
#: exceed a single window's whole budget.
MCP_WRITE_ADMISSION_BURST = 100
#: Sliding-window length in seconds.
MCP_WRITE_ADMISSION_WINDOW_SECONDS = 60.0
#: Cap on tracked budget keys before new keys fail closed rather than growing
#: the table without bound (mirrors ``RateLimitMiddleware.max_clients``).
MCP_WRITE_ADMISSION_MAX_KEYS = 10_000

if MCP_WRITE_ADMISSION_BURST > TASK_SPACE_BATCH_MAX_COMMANDS:
    raise RuntimeError("MCP write admission burst exceeds the batch command limit")


class McpWriteRateLimitError(AppError):
    """Fail-closed admission rejection with REST-compatible error semantics."""

    detail = "MCP task-space write budget exhausted"
    status_code = 429
    legacy_error_type = "rate_limit_exceeded"
    code = "rate_limit_exceeded"
    retryable = True

    def __init__(self, details: dict[str, object]) -> None:
        super().__init__(details=details)


def _budget_key(principal: Principal, space_id: str) -> tuple[str, str]:
    return (principal.subject, space_id)


class AdmissionLease:
    """One reservation of admission units for a single tool call."""

    __slots__ = ("_admission", "_key", "_units", "_consumed", "_settled")

    def __init__(
        self, admission: "McpWriteAdmission", key: tuple[str, str], units: int
    ) -> None:
        self._admission = admission
        self._key = key
        self._units = units
        self._consumed = 0
        self._settled = False

    @property
    def units(self) -> int:
        return self._units

    @property
    def consumed(self) -> int:
        return self._consumed

    @property
    def settled(self) -> bool:
        return self._settled

    async def commit(self, consumed: int | None = None) -> None:
        """Charge ``consumed`` (default: the whole reservation) to the budget."""
        if self._settled:
            raise RuntimeError("admission lease is already settled")
        self._settled = True
        await self._admission._settle(
            self._key, self._units, self._units if consumed is None else consumed
        )

    async def release(self) -> None:
        """Return the whole reservation: nothing was executed."""
        if self._settled:
            return
        self._settled = True
        await self._admission._settle(self._key, self._units, 0)


class McpWriteAdmission:
    """Process-local sliding-window budget for MCP task-space writes."""

    def __init__(
        self,
        *,
        burst: int = MCP_WRITE_ADMISSION_BURST,
        window_seconds: float = MCP_WRITE_ADMISSION_WINDOW_SECONDS,
        max_keys: int = MCP_WRITE_ADMISSION_MAX_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if burst < 1:
            raise ValueError("burst must be positive")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        if max_keys < 1:
            raise ValueError("max_keys must be positive")
        self._burst = burst
        self._window = window_seconds
        self._max_keys = max_keys
        self._clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._reserved: dict[tuple[str, str], int] = {}
        self._lock = asyncio.Lock()

    @property
    def burst(self) -> int:
        return self._burst

    @property
    def window_seconds(self) -> float:
        return self._window

    def _prune(self, key: tuple[str, str], now: float) -> deque[float]:
        timestamps = self._hits.get(key)
        if timestamps is None:
            timestamps = deque()
            self._hits[key] = timestamps
        cutoff = now - self._window
        while timestamps and timestamps[0] <= cutoff:
            timestamps.popleft()
        return timestamps

    def _retry_after(self, timestamps: deque[float], now: float) -> int:
        if not timestamps:
            return 1
        return max(1, math.ceil(self._window - (now - timestamps[0])))

    def _rejection(
        self,
        principal: Principal,
        space_id: str,
        units: int,
        available: float,
        retry_after: int,
    ) -> AppError:
        return McpWriteRateLimitError(
            {
                "reason": "mcp_write_budget_exhausted",
                "principal": principal.subject,
                "spaceId": space_id,
                "requestedUnits": units,
                "availableUnits": max(0, int(available)),
                "capacity": self._burst,
                "windowSeconds": self._window,
                "retryAfterSeconds": retry_after,
                "scope": "process_local",
            }
        )

    async def check(
        self, principal: Principal, space_id: str, units: int
    ) -> AdmissionLease:
        """Reserve ``units`` for ``(principal.subject, space_id)`` or reject.

        Raises before any runtime is opened when the request cannot be
        satisfied, so an over-budget call performs no domain work.
        """
        if type(units) is not int:
            raise TypeError("admission units must be an integer")
        if units < 1:
            raise ValueError("admission units must be positive")
        if not isinstance(space_id, str) or not space_id:
            raise ValueError("admission requires a non-empty space id")
        if units > self._burst:
            # Structural: no charge is consumed, but the request is impossible
            # by construction, so report it against the same key for visibility.
            key = _budget_key(principal, space_id)
            async with self._lock:
                timestamps = self._prune(key, self._clock())
                retry_after = self._retry_after(timestamps, self._clock())
                available = self._burst - len(timestamps) - self._reserved.get(key, 0)
            raise self._rejection(principal, space_id, units, available, retry_after)

        key = _budget_key(principal, space_id)
        async with self._lock:
            now = self._clock()
            known_key = key in self._hits
            timestamps = self._prune(key, now)
            in_flight = self._reserved.get(key, 0)
            available = self._burst - len(timestamps) - in_flight
            if available < units:
                if not known_key and len(self._hits) > self._max_keys:
                    # Table pressure: fail closed instead of growing unbounded.
                    self._hits.pop(key, None)
                    retry_after = max(1, math.ceil(self._window))
                else:
                    retry_after = self._retry_after(timestamps, now)
                raise self._rejection(
                    principal, space_id, units, available, retry_after
                )
            self._reserved[key] = in_flight + units
        return AdmissionLease(self, key, units)

    async def _settle(self, key: tuple[str, str], units: int, consumed: int) -> None:
        """Settle one reservation: charge ``consumed`` and return the rest."""
        if consumed < 0 or consumed > units:
            raise ValueError("consumed units must be within the reservation")
        async with self._lock:
            in_flight = self._reserved.get(key, 0)
            remaining = in_flight - units
            if remaining > 0:
                self._reserved[key] = remaining
            else:
                self._reserved.pop(key, None)
            if consumed:
                now = self._clock()
                timestamps = self._prune(key, now)
                timestamps.extend([now] * consumed)


#: Process-wide instance shared by the MCP write tools.
mcp_write_admission = McpWriteAdmission()


__all__ = [
    "AdmissionLease",
    "McpWriteAdmission",
    "McpWriteRateLimitError",
    "MCP_WRITE_ADMISSION_BURST",
    "MCP_WRITE_ADMISSION_MAX_KEYS",
    "MCP_WRITE_ADMISSION_WINDOW_SECONDS",
    "mcp_write_admission",
]
