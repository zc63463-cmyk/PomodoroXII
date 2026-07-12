"""Bounded, concurrency-safe rate limiting for sensitive endpoints."""

from __future__ import annotations

import asyncio
import ipaddress
import math
import time
from collections import deque
from collections.abc import Iterable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class RateLimitMiddleware:
    """In-memory sliding-window limiter keyed by endpoint and canonical client IP."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        limits: dict[str, tuple[int, float]] | None = None,
        max_clients: int = 10_000,
        trusted_proxies: Iterable[str] = (),
        cleanup_interval: float = 60.0,
    ) -> None:
        if max_clients < 1:
            raise ValueError("max_clients must be positive")
        if cleanup_interval <= 0:
            raise ValueError("cleanup_interval must be positive")
        self.app = app
        self._limits = limits or {
            "/api/v1/auth/login": (10, 60.0),
            "/api/v1/auth/setup": (5, 60.0),
        }
        self._max_clients = max_clients
        self._trusted_proxies = tuple(ipaddress.ip_network(value) for value in trusted_proxies)
        self._cleanup_interval = cleanup_interval
        self._next_cleanup = time.monotonic() + cleanup_interval
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = asyncio.Lock()

    @property
    def tracked_key_count(self) -> int:
        return len(self._hits)

    @property
    def tracked_hit_count(self) -> int:
        return sum(len(hits) for hits in self._hits.values())

    @staticmethod
    def _canonical_ip(value: str) -> str:
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            return value

    @staticmethod
    def _peer_ip(scope: Scope) -> str:
        client = scope.get("client")
        return client[0] if client else "unknown"

    @staticmethod
    def _header(scope: Scope, name: bytes) -> str | None:
        values = [value for key, value in scope.get("headers", []) if key.lower() == name]
        if len(values) != 1:
            return None
        return values[0].decode("latin-1")

    def _is_trusted(self, address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        return any(address in network for network in self._trusted_proxies)

    def _client_ip(self, scope: Scope) -> str:
        peer = self._peer_ip(scope)
        try:
            peer_address = ipaddress.ip_address(peer)
        except ValueError:
            return peer
        canonical_peer = str(peer_address)
        if not self._is_trusted(peer_address):
            return canonical_peer

        forwarded = self._header(scope, b"x-forwarded-for")
        if not forwarded:
            return canonical_peer
        chain = [part.strip() for part in forwarded.split(",") if part.strip()]
        chain.append(canonical_peer)
        for candidate in reversed(chain):
            try:
                address = ipaddress.ip_address(candidate)
            except ValueError:
                return canonical_peer
            if not self._is_trusted(address):
                return str(address)
        return canonical_peer

    def _prune_key(self, key: tuple[str, str], now: float) -> deque[float] | None:
        timestamps = self._hits.get(key)
        if timestamps is None:
            return None
        cutoff = now - self._limits[key[0]][1]
        while timestamps and timestamps[0] <= cutoff:
            timestamps.popleft()
        if not timestamps:
            del self._hits[key]
            return None
        return timestamps

    def _periodic_cleanup(self, now: float) -> None:
        if now < self._next_cleanup:
            return
        for key in list(self._hits):
            self._prune_key(key, now)
        self._next_cleanup = now + self._cleanup_interval

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path")
        if scope["type"] != "http" or scope.get("method") != "POST" or path not in self._limits:
            await self.app(scope, receive, send)
            return

        max_requests, window = self._limits[path]
        key = (path, self._client_ip(scope))
        now = time.monotonic()
        capacity_exhausted = False

        async with self._lock:
            self._periodic_cleanup(now)
            timestamps = self._prune_key(key, now)
            if timestamps is None:
                if len(self._hits) >= self._max_clients:
                    capacity_exhausted = True
                else:
                    timestamps = deque()
                    self._hits[key] = timestamps
            if capacity_exhausted:
                retry_after = max(1, math.ceil(self._cleanup_interval))
            elif len(timestamps) >= max_requests:
                retry_after = max(1, math.ceil(window - (now - timestamps[0])))
            else:
                timestamps.append(now)
                retry_after = 0

        if retry_after:
            await JSONResponse(
                status_code=429,
                content={
                    "detail": "Too many requests",
                    "error_type": "rate_limit_exceeded",
                },
                headers={"Retry-After": str(retry_after)},
            )(scope, receive, send)
            return
        await self.app(scope, receive, send)
