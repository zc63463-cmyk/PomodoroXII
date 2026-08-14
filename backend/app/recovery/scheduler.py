"""Required scheduled full recovery snapshots.

``RecoveryScheduler`` owns the production startup gate: a verified full
snapshot must complete before readiness, and a cancellable periodic loop keeps
taking verified snapshots.  Retention keeps the newest N verified snapshots and
never auto-deletes unverifiable content or paths outside the configured
backup target.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from app.ops.signals import OperationalSignals

if TYPE_CHECKING:
    from .local_service import LocalRecoveryService

logger = logging.getLogger("pomodoroxi.recovery.scheduler")


@dataclass(frozen=True, slots=True)
class _VerifiedSnapshot:
    path: Path
    created_at: str
    manifest_sha256: str


class RecoveryScheduler:
    """Run one verified snapshot at startup and keep a periodic schedule.

    ``start()`` performs and verifies an initial snapshot before returning;
    a failure raises and leaves readiness false.  On success a cancellable
    asyncio task is started.  ``close()`` cancels and awaits the task, then
    releases nothing else (the owning service is closed by the caller).
    """

    def __init__(
        self,
        service: "LocalRecoveryService",
        target: Path,
        signals: OperationalSignals,
        *,
        interval_hours: int = 24,
        retention_count: int = 30,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self.service = service
        self.target = Path(target).expanduser().absolute()
        self.signals = signals
        self.interval_hours = int(interval_hours)
        self.retention_count = int(retention_count)
        self.failpoint = failpoint or (lambda _name: None)
        self.task: asyncio.Task | None = None
        self.readiness = False

    async def start(self) -> None:
        """Run the required initial snapshot; raise on failure."""
        snapshot = await self._take_snapshot()
        await self._verify_snapshot(snapshot)
        self.failpoint("scheduler_initial_verified")
        self.readiness = True
        self.task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval_hours * 3600)
            try:
                snapshot = await self._take_snapshot()
                await self._verify_snapshot(snapshot)
                await self._retain()
            except asyncio.CancelledError:
                raise
            except BaseException as exc:  # noqa: BLE001 - operator-visible failure
                logger.error("scheduled snapshot failed: %s", exc)
                await self.signals.snapshot_failed(
                    getattr(exc, "record", None).code
                    if getattr(exc, "record", None) is not None
                    else type(exc).__name__
                )

    async def close(self) -> None:
        """Cancel the periodic task and wait for it to finish."""
        task = self.task
        self.task = None
        if task is None:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except BaseException as exc:  # noqa: BLE001
            logger.error("scheduler task exited with error: %s", exc)

    async def _take_snapshot(self):
        await self.signals.snapshot_started()
        try:
            receipt = await self.service.coordinator.snapshot(self.target)
        except BaseException as exc:
            await self.signals.snapshot_failed(
                getattr(exc, "record", None).code
                if getattr(exc, "record", None) is not None
                else type(exc).__name__
            )
            raise
        return receipt

    async def _verify_snapshot(self, receipt) -> None:
        verification = await self.service.coordinator.verify(receipt)
        if (
            verification.valid is not True
            or verification.failures
            or verification.manifest is None
            or verification.manifest_sha256 != getattr(
                receipt, "manifest_sha256", verification.manifest_sha256
            )
        ):
            code = (
                verification.failures[0]
                if verification.failures
                else "snapshot_verification_failed"
            )
            await self.signals.snapshot_failed(code)
            from .coordinator import DomainFailure

            raise DomainFailure(code, "required initial snapshot verification failed")
        await self.signals.snapshot_succeeded(verification.manifest_sha256)

    # ------------------------------------------------------------------ #
    # Retention
    # ------------------------------------------------------------------ #

    async def _retain(self) -> list[Path]:
        """Delete expired verified snapshots; return the removed paths.

        Only manifests under ``self.target`` that parse canonically, carry a
        valid ``manifest.sha256``, and sort below the newest
        ``retention_count`` entries are removed.  Invalid/unreadable entries
        are logged for operator review and never deleted; nothing outside
        ``self.target`` is ever touched.
        """
        verified: list[_VerifiedSnapshot] = []
        invalid: list[Path] = []
        for path in sorted(self.target.iterdir()) if self.target.is_dir() else ():
            if not path.is_dir():
                continue
            manifest = self._read_verified_manifest(path)
            if manifest is None:
                invalid.append(path)
                continue
            verified.append(manifest)
        if invalid:
            logger.warning(
                "retention skipped %d unverifiable snapshot(s): %s",
                len(invalid),
                ", ".join(str(item) for item in invalid),
            )
        verified.sort(key=lambda item: item.created_at)
        expired = verified[: max(0, len(verified) - self.retention_count)]
        removed: list[Path] = []
        for item in expired:
            try:
                self._remove_snapshot_dir(item.path)
            except OSError as exc:
                logger.error("retention could not remove %s: %s", item.path, exc)
                continue
            removed.append(item.path)
        return removed

    def _read_verified_manifest(self, path: Path) -> _VerifiedSnapshot | None:
        """Read one snapshot manifest defensively; ``None`` means unverifiable.

        Retention only needs the canonical manifest digest and creation time.
        Full read-only re-verification is the coordinator's job and already ran
        when the snapshot was taken; here any unreadable, non-canonical or
        digest-mismatched manifest is treated as invalid and preserved for
        operator review.
        """
        manifest_file = path / "manifest.json"
        digest_file = path / "manifest.sha256"
        try:
            payload = manifest_file.read_bytes()
            recorded = digest_file.read_text(encoding="ascii").strip()
            if hashlib.sha256(payload).hexdigest() != recorded:
                return None
            raw = json.loads(payload)
            if not isinstance(raw, dict):
                return None
            created_at = raw.get("created_at")
            if not isinstance(created_at, str) or not created_at:
                return None
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        return _VerifiedSnapshot(path, created_at, recorded)

    @staticmethod
    def _remove_snapshot_dir(path: Path) -> None:
        import shutil

        shutil.rmtree(path)
