"""Fail-closed coverage for the retired legacy startup backup."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_disabled_backup_performs_no_backup_storage_io(
    _isolate_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.auth.authority as authority_module
    import app.db.meta_session as meta_session_module
    import app.main as main_module
    import app.settings as settings_module
    import app.space_manager as space_manager_module

    monkeypatch.setattr(main_module.settings, "backup_enabled", False)
    lifecycle: list[str] = []

    async def init_meta_db() -> None:
        lifecycle.append("init")

    async def bootstrap_credential_epoch() -> int:
        lifecycle.append("bootstrap")
        return 1

    async def dispose_space_engine_manager() -> None:
        lifecycle.append("dispose")

    async def close_meta_db() -> None:
        lifecycle.append("close")

    def forbidden_space_db_path(self, space_id: str) -> Path:
        raise AssertionError(f"legacy backup enumerated Space path {space_id}")

    monkeypatch.setattr(meta_session_module, "init_meta_db", init_meta_db)
    monkeypatch.setattr(meta_session_module, "close_meta_db", close_meta_db)
    monkeypatch.setattr(
        authority_module,
        "bootstrap_credential_epoch",
        bootstrap_credential_epoch,
    )
    monkeypatch.setattr(
        space_manager_module,
        "get_space_engine_manager",
        lambda: lifecycle.append("manager"),
    )
    monkeypatch.setattr(
        space_manager_module,
        "dispose_space_engine_manager",
        dispose_space_engine_manager,
    )
    monkeypatch.setattr(
        settings_module.Settings,
        "space_db_path",
        forbidden_space_db_path,
    )

    async with main_module.lifespan(main_module.app):
        lifecycle.append("ready")

    assert lifecycle == ["init", "bootstrap", "manager", "ready", "dispose", "close"]


@pytest.mark.asyncio
async def test_enabled_legacy_backup_fails_before_storage_initialization(
    _isolate_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.db.meta_session as meta_session_module
    import app.main as main_module
    from app.file_system.backup import LegacyBackupConfigurationError

    monkeypatch.setattr(main_module.settings, "backup_enabled", True)
    storage_calls: list[str] = []

    async def forbidden_init_meta_db() -> None:
        storage_calls.append("meta")
        raise AssertionError("Meta storage initialized before backup configuration rejection")

    monkeypatch.setattr(meta_session_module, "init_meta_db", forbidden_init_meta_db)

    with pytest.raises(LegacyBackupConfigurationError) as caught:
        async with main_module.lifespan(main_module.app):
            pass

    assert getattr(caught.value, "code", None) == "legacy_backup_unsupported"
    assert storage_calls == []


def test_backup_module_has_no_path_backed_sqlite_connector() -> None:
    import app.file_system.backup as backup_module

    source = inspect.getsource(backup_module)
    assert "sqlite3.connect" not in source
    assert not hasattr(backup_module, "BackupService")


def test_main_has_no_legacy_backup_path_enumeration() -> None:
    import app.main as main_module

    source = inspect.getsource(main_module)
    assert "BackupService" not in source
    assert "space_db_path" not in source
    assert '"backups"' not in source


def test_n_minus_one_fixture_explicitly_disables_legacy_backup() -> None:
    fixture = Path(__file__).parent / "fixtures" / "certification" / "populate_n_minus_one.py"
    source = fixture.read_text(encoding="utf-8")
    assert '"POMODOROXII_BACKUP_ENABLED": "false"' in source
