"""Lifespan coverage for the required scheduled full recovery startup gate."""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_disabled_backup_performs_no_backup_storage_io(
    _isolate_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.main as main_module
    import app.runtime.bootstrap as bootstrap_module
    import app.settings as settings_module

    monkeypatch.setattr(main_module.settings, "backup_enabled", False)
    lifecycle: list[str] = []

    class Ready:
        def assert_ready(self) -> None:
            lifecycle.append("ready-check")

    @asynccontextmanager
    async def bootstrap_runtime(_purpose: str):
        lifecycle.append("bootstrap")
        ready = Ready()
        try:
            yield SimpleNamespace(
                runtime=ready,
                executor=SimpleNamespace(gate=ready),
            )
        finally:
            lifecycle.append("shutdown")

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)
    scheduler_calls: list[str] = []
    monkeypatch.setattr(
        main_module,
        "RecoveryScheduler",
        lambda *args, **kwargs: (
            scheduler_calls.append("constructed") or SimpleNamespace(start=None, close=None)
        ),
    )

    async with main_module.lifespan(main_module.app):
        lifecycle.append("ready")

    assert lifecycle == [
        "bootstrap",
        "ready-check",
        "ready-check",
        "ready",
        "shutdown",
    ]
    assert scheduler_calls == []


@pytest.mark.asyncio
async def test_enabled_backup_requires_target_before_initialization(
    _isolate_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.main as main_module
    import app.runtime.bootstrap as bootstrap_module

    monkeypatch.setattr(main_module.settings, "backup_enabled", True)
    monkeypatch.setattr(main_module.settings, "backup_target_dir", None)
    initialized: list[str] = []

    @asynccontextmanager
    async def bootstrap_runtime(_purpose: str):
        initialized.append("bootstrap")
        yield SimpleNamespace(
            runtime=SimpleNamespace(assert_ready=lambda: None),
            executor=SimpleNamespace(gate=SimpleNamespace(assert_ready=lambda: None)),
        )

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)

    with pytest.raises(RuntimeError, match="BACKUP_TARGET_DIR"):
        async with main_module.lifespan(main_module.app):
            pass


@pytest.mark.asyncio
async def test_initial_snapshot_failure_aborts_startup(
    _isolate_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.main as main_module
    import app.runtime.bootstrap as bootstrap_module

    monkeypatch.setattr(main_module.settings, "backup_enabled", True)
    monkeypatch.setattr(
        main_module.settings,
        "backup_target_dir",
        Path("E:/DevTemp/pomodoroxii-backup-target"),
    )
    monkeypatch.setattr(main_module.settings, "backup_interval_hours", 24)
    monkeypatch.setattr(main_module.settings, "backup_retention_count", 30)
    bootstrap_entered: list[str] = []

    @asynccontextmanager
    async def bootstrap_runtime(_purpose: str):
        bootstrap_entered.append("bootstrap")
        yield SimpleNamespace(
            runtime=SimpleNamespace(assert_ready=lambda: None),
            executor=SimpleNamespace(gate=SimpleNamespace(assert_ready=lambda: None)),
        )

    class FailingSignals:
        def __init__(self) -> None:
            self.last_snapshot_success = None
            self.snapshot_failure_code = None

        async def snapshot_started(self) -> None:
            return None

        async def snapshot_succeeded(self, _manifest_sha256: str) -> None:
            raise AssertionError("initial snapshot must not succeed")

        async def snapshot_failed(self, code: str) -> None:
            self.snapshot_failure_code = code

    class FailingCoordinator:
        async def snapshot(self, _target):
            raise RuntimeError("injected initial snapshot failure")

        async def verify(self, _snapshot):
            raise AssertionError("verify must not run after snapshot failure")

    class FailingRecoveryService:
        def __init__(self, _root: Path) -> None:
            self.coordinator = FailingCoordinator()

        async def aclose(self) -> None:
            return None

    class FailingScheduler:
        def __init__(self, service, target, signals, *, interval_hours, retention_count) -> None:
            self.signals = signals
            self.started = False

        async def start(self) -> None:
            self.started = True
            await self.signals.snapshot_started()
            try:
                await FailingCoordinator().snapshot(None)
            except BaseException as exc:
                await self.signals.snapshot_failed(type(exc).__name__)
                raise

        async def close(self) -> None:
            return None

    monkeypatch.setattr(bootstrap_module, "bootstrap_runtime", bootstrap_runtime)
    monkeypatch.setattr(main_module, "LocalRecoveryService", FailingRecoveryService)
    monkeypatch.setattr(main_module, "RecoveryScheduler", FailingScheduler)

    with pytest.raises(RuntimeError, match="injected initial snapshot failure"):
        async with main_module.lifespan(main_module.app):
            pass

    assert bootstrap_entered == ["bootstrap"]


def test_main_has_no_legacy_backup_path_enumeration() -> None:
    import app.main as main_module

    source = inspect.getsource(main_module)
    assert "BackupService" not in source
    assert "require_legacy_backup_disabled" not in source
    assert "space_db_path" not in source
    assert '"backups"' not in source


def test_n_minus_one_fixture_explicitly_disables_legacy_backup() -> None:
    fixture = Path(__file__).parent / "fixtures" / "certification" / "populate_n_minus_one.py"
    source = fixture.read_text(encoding="utf-8")
    assert '"POMODOROXII_BACKUP_ENABLED": "false"' in source
