"""S5 Task 3: required scheduled full recovery snapshots.

Covers the production startup gate (initial snapshot must succeed before
readiness), the cancellable scheduler loop, retention policy (keep the newest
N verified snapshots, never auto-delete unverifiable content or paths outside
the configured target), and the concurrency-safe OperationalSignals snapshot
state.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.test_recovery import _coordinator
from tests.test_recovery_local_service import _add_effort_projection_tables


def _manifest_payload(coordinator, *, created_at: str) -> dict[str, object]:
    types = tuple(
        sorted(
            getattr(spec, "effective_sync_entity_type", getattr(spec, "name", ""))
            for spec in (coordinator.catalog.list() or ())
        )
    )
    assert len(types) == 31
    return {
        "schema_version": 1,
        "created_at": created_at,
        "source_fence": 3,
        "catalog_hash": coordinator.catalog.hash,
        "catalog_entry_count": 31,
        "catalog_entity_types": list(types),
        "meta": {
            "schema_head": "meta_002_active_session_locator",
            "active_session_coordination": {
                "classification": "empty",
                "result": "clean_or_recoverable",
            },
            "effort_projection": {"result": "verified"},
        },
        "spaces": [],
        "files": [],
    }


def _publish_snapshot_dir(
    target: Path, name: str, coordinator, *, created_at: str
) -> Path:
    snapshot = target / name
    snapshot.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        _manifest_payload(coordinator, created_at=created_at),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    (snapshot / "manifest.json").write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (snapshot / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
    return snapshot


def _broken_snapshot_dir(target: Path, name: str) -> Path:
    snapshot = target / name
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "manifest.json").write_bytes(b"not-json")
    (snapshot / "manifest.sha256").write_text("0" * 64 + "\n", encoding="ascii")
    return snapshot


# --------------------------------------------------------------------------- #
# OperationalSignals contract
# --------------------------------------------------------------------------- #


def test_operational_signals_snapshot_field_names_are_exact() -> None:
    from app.ops.signals import OperationalSignals

    assert tuple(OperationalSignals.snapshot_field_names()) == (
        "last_snapshot_started",
        "last_snapshot_success",
        "last_snapshot_manifest_sha256",
        "snapshot_failure_code",
    )


@pytest.mark.asyncio
async def test_operational_signals_track_snapshot_lifecycle() -> None:
    from app.ops.signals import OperationalSignals

    signals = OperationalSignals()
    assert signals.snapshot_readiness() == {
        "last_snapshot_started": None,
        "last_snapshot_success": None,
        "last_snapshot_manifest_sha256": None,
        "snapshot_failure_code": None,
    }

    await signals.snapshot_started()
    assert signals.last_snapshot_started is not None
    assert signals.last_snapshot_success is None

    await signals.snapshot_succeeded("a" * 64)
    assert signals.last_snapshot_success is not None
    assert signals.last_snapshot_manifest_sha256 == "a" * 64
    assert signals.snapshot_failure_code is None

    await signals.snapshot_failed("snapshot_invalid")
    assert signals.snapshot_failure_code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_operational_signals_are_concurrency_safe() -> None:
    from app.ops.signals import OperationalSignals

    signals = OperationalSignals()

    async def _writer(index: int) -> None:
        await signals.snapshot_started()
        if index % 2 == 0:
            await signals.snapshot_succeeded(f"{index:064x}")
        else:
            await signals.snapshot_failed("boom")

    await asyncio.gather(*(_writer(index) for index in range(20)))
    snapshot = signals.snapshot_readiness()
    assert isinstance(snapshot, dict)
    assert "last_snapshot_success" in snapshot
    assert "snapshot_failure_code" in snapshot


# --------------------------------------------------------------------------- #
# Settings / backup target validation
# --------------------------------------------------------------------------- #


def _settings_kwargs(tmp_path: Path, **overrides) -> dict[str, object]:
    meta_db = tmp_path / "meta.db"
    kwargs: dict[str, object] = {
        "environment": "production",
        "secret_key": "test-production-secret-key-0123456789abcdef0123456789abcdef",
        "sync_cursor_secret": "test-production-cursor-secret-0123456789abcdef0123456789abcdef",
        "database_url": f"sqlite+aiosqlite:///{meta_db.as_posix()}",
        "spaces_data_dir": tmp_path / "spaces",
        "data_root": tmp_path,
    }
    kwargs.update(overrides)
    return kwargs


def test_backup_target_inside_active_root_is_rejected(tmp_path: Path) -> None:
    from app.settings import Settings

    with pytest.raises(ValueError, match="outside the active data root"):
        Settings(
            **_settings_kwargs(
                tmp_path,
                backup_enabled=True,
                backup_target_dir=tmp_path / "backups",
            )
        )


def test_production_backup_enabled_requires_external_target(tmp_path: Path) -> None:
    from app.settings import Settings

    with pytest.raises(ValueError, match="BACKUP_TARGET_DIR is required"):
        Settings(
            **_settings_kwargs(
                tmp_path,
                backup_enabled=True,
                backup_target_dir=None,
            )
        )


def test_development_can_explicitly_disable_backup(tmp_path: Path) -> None:
    from app.settings import Settings

    # The autouse ``_isolate_env`` fixture points the environment at a sandbox
    # meta DB; mirror that canonical layout so Settings construction succeeds.
    meta_db = tmp_path / "meta.db"
    spaces_dir = tmp_path / "spaces"
    settings = Settings(
        environment="development",
        backup_enabled=False,
        backup_target_dir=None,
        database_url=f"sqlite+aiosqlite:///{meta_db.as_posix()}",
        spaces_data_dir=spaces_dir,
        data_root=tmp_path,
    )
    assert settings.backup_enabled is False


# --------------------------------------------------------------------------- #
# Scheduler startup gate and loop lifecycle
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_scheduler_initial_snapshot_required_before_readiness(
    tmp_path: Path,
) -> None:
    from app.ops.signals import OperationalSignals
    from app.recovery.local_service import LocalRecoveryService
    from app.recovery.scheduler import RecoveryScheduler

    coordinator, _leases, active_root, engines = _coordinator(tmp_path)
    await _add_effort_projection_tables(active_root / "spaces" / "alpha" / "space.db")
    service = LocalRecoveryService(active_root)
    signals = OperationalSignals()
    target = tmp_path / "backup-target"
    scheduler = RecoveryScheduler(service, target=target, signals=signals)
    try:
        await scheduler.start()
        assert signals.last_snapshot_success is not None
        assert signals.last_snapshot_manifest_sha256 is not None
        assert signals.snapshot_readiness()["last_snapshot_success"] is not None
        assert scheduler.readiness is True
        assert scheduler.task is not None and not scheduler.task.done()
    finally:
        await scheduler.close()
        await service.aclose()
        for engine in engines:
            await engine.dispose()


@pytest.mark.asyncio
async def test_scheduler_initial_snapshot_failure_aborts_startup(
    tmp_path: Path,
) -> None:
    from app.recovery import DomainFailure
    from app.ops.signals import OperationalSignals
    from app.recovery.local_service import LocalRecoveryService
    from app.recovery.scheduler import RecoveryScheduler

    coordinator, _leases, active_root, engines = _coordinator(tmp_path)
    service = LocalRecoveryService(active_root)
    signals = OperationalSignals()

    async def _failing_snapshot(_target):
        raise DomainFailure("snapshot_invalid", "injected initial snapshot failure")

    original = service.coordinator.snapshot
    service.coordinator.snapshot = _failing_snapshot  # type: ignore[method-assign]
    target = tmp_path / "backup-target"
    scheduler = RecoveryScheduler(service, target=target, signals=signals)
    try:
        with pytest.raises(DomainFailure) as raised:
            await scheduler.start()
        assert raised.value.record.code == "snapshot_invalid"
        assert signals.snapshot_failure_code == "snapshot_invalid"
        assert signals.last_snapshot_success is None
        assert scheduler.readiness is False
        assert scheduler.task is None
    finally:
        await scheduler.close()
        service.coordinator.snapshot = original  # type: ignore[method-assign]
        await service.aclose()
        for engine in engines:
            await engine.dispose()


@pytest.mark.asyncio
async def test_scheduler_close_cancels_and_awaits_task(tmp_path: Path) -> None:
    from app.ops.signals import OperationalSignals
    from app.recovery.local_service import LocalRecoveryService
    from app.recovery.scheduler import RecoveryScheduler

    coordinator, _leases, active_root, engines = _coordinator(tmp_path)
    await _add_effort_projection_tables(active_root / "spaces" / "alpha" / "space.db")
    service = LocalRecoveryService(active_root)
    signals = OperationalSignals()
    scheduler = RecoveryScheduler(service, target=tmp_path / "backup-target", signals=signals)
    await scheduler.start()
    task = scheduler.task
    assert task is not None and not task.done()

    await scheduler.close()

    assert task.done()
    assert scheduler.task is None
    assert signals.last_snapshot_success is not None
    await service.aclose()
    for engine in engines:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# Retention policy
# --------------------------------------------------------------------------- #


def _scheduler_for_retention(
    tmp_path: Path,
    *,
    interval_hours: int = 24,
    retention_count: int = 30,
):
    from app.ops.signals import OperationalSignals
    from app.recovery.scheduler import RecoveryScheduler

    coordinator, _leases, active_root, engines = _coordinator(tmp_path)
    service = SimpleNamespace(coordinator=coordinator)
    signals = OperationalSignals()
    scheduler = RecoveryScheduler(
        service,
        target=tmp_path / "backup-target",
        signals=signals,
        interval_hours=interval_hours,
        retention_count=retention_count,
    )
    return scheduler, coordinator


@pytest.mark.asyncio
async def test_retention_keeps_newest_n_verified_snapshots(tmp_path: Path) -> None:
    scheduler, coordinator = _scheduler_for_retention(tmp_path, retention_count=3)
    target = tmp_path / "backup-target"
    for index in range(10):
        _publish_snapshot_dir(
            target,
            f"snap-{index:02d}",
            coordinator,
            created_at=f"2026-08-{index + 1:02d}T00:00:00.000Z",
        )

    removed = await scheduler._retain()

    remaining = sorted(item.name for item in target.iterdir())
    assert remaining == [f"snap-{index:02d}" for index in range(7, 10)]
    assert len(removed) == 7


@pytest.mark.asyncio
async def test_retention_never_deletes_invalid_or_unreadable_snapshot(
    tmp_path: Path,
) -> None:
    scheduler, coordinator = _scheduler_for_retention(tmp_path, retention_count=2)
    target = tmp_path / "backup-target"
    for index in range(5):
        _publish_snapshot_dir(
            target,
            f"valid-{index:02d}",
            coordinator,
            created_at=f"2026-08-{index + 1:02d}T00:00:00.000Z",
        )
    _broken_snapshot_dir(target, "broken-01")
    _broken_snapshot_dir(target, "broken-02")

    removed = await scheduler._retain()

    assert "broken-01" in {item.name for item in target.iterdir()}
    assert "broken-02" in {item.name for item in target.iterdir()}
    assert all("broken" not in item.name for item in removed)


@pytest.mark.asyncio
async def test_retention_never_deletes_paths_outside_target(tmp_path: Path) -> None:
    scheduler, coordinator = _scheduler_for_retention(tmp_path, retention_count=1)
    target = tmp_path / "backup-target"
    outside = tmp_path / "outside-target"
    outside.mkdir()
    _publish_snapshot_dir(
        target,
        "snap-00",
        coordinator,
        created_at="2026-08-01T00:00:00.000Z",
    )
    _publish_snapshot_dir(
        outside,
        "snap-outside",
        coordinator,
        created_at="2026-08-02T00:00:00.000Z",
    )

    removed = await scheduler._retain()

    assert (outside / "snap-outside").is_dir()
    assert all("outside" not in str(path) for path in removed)
