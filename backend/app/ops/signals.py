"""Concurrency-safe snapshot and readiness state for scheduled recovery.

Task 3 deliberately keeps this owner minimal: four snapshot fields, atomic
update methods, and a read-only readiness view.  Prometheus metrics, request
labels, credentials and Space metrics are Task 4 work and must not appear
here.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Mapping


class OperationalSignals:
    """Own the authoritative last-snapshot and readiness state.

    Every update is serialized through an asyncio lock so concurrent scheduler
    runs and future Task 4 readers observe a consistent snapshot.
    """

    _SNAPSHOT_FIELDS = (
        "last_snapshot_started",
        "last_snapshot_success",
        "last_snapshot_manifest_sha256",
        "snapshot_failure_code",
    )

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.last_snapshot_started: str | None = None
        self.last_snapshot_success: str | None = None
        self.last_snapshot_manifest_sha256: str | None = None
        self.snapshot_failure_code: str | None = None

    @classmethod
    def snapshot_field_names(cls) -> tuple[str, ...]:
        return cls._SNAPSHOT_FIELDS

    async def snapshot_started(self) -> None:
        async with self._lock:
            self.last_snapshot_started = datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            self.snapshot_failure_code = None

    async def snapshot_succeeded(self, manifest_sha256: str) -> None:
        async with self._lock:
            self.last_snapshot_success = datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            self.last_snapshot_manifest_sha256 = manifest_sha256
            self.snapshot_failure_code = None

    async def snapshot_failed(self, code: str) -> None:
        async with self._lock:
            self.snapshot_failure_code = code

    def snapshot_readiness(self) -> Mapping[str, str | None]:
        """Read-only view; callers never mutate the returned mapping."""
        return {
            "last_snapshot_started": self.last_snapshot_started,
            "last_snapshot_success": self.last_snapshot_success,
            "last_snapshot_manifest_sha256": self.last_snapshot_manifest_sha256,
            "snapshot_failure_code": self.snapshot_failure_code,
        }

    @property
    def readiness(self) -> bool:
        """Readiness requires at least one verified snapshot."""
        return self.last_snapshot_success is not None
