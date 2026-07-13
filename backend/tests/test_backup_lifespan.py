"""Tests for BackupService integration into app lifespan (PR-18).

Validates that:
1. Startup triggers BackupService.create_backup for each registered space.
2. backup_enabled=False skips backup entirely.
3. Backup failure logs error but does not block startup.
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest


def _fresh_create_app():
    """Import create_app after purging cached app.main so it rebinds to the
    current settings singleton established by _isolate_env."""
    for key in list(sys.modules.keys()):
        if key == "app.main" or key.startswith("app.routes."):
            del sys.modules[key]
    from app.main import create_app

    return create_app


def test_create_backup_same_timestamp_preserves_both_database_states(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.file_system import backup as backup_module

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 7, 13, 12, 34, 56, 123000, tzinfo=timezone.utc)

    monkeypatch.setattr(backup_module, "datetime", FrozenDateTime)
    source_path = tmp_path / "source.db"
    backup_dir = tmp_path / "backups"
    with sqlite3.connect(source_path) as connection:
        connection.execute("CREATE TABLE marker (value TEXT NOT NULL)")
        connection.execute("INSERT INTO marker VALUES ('old')")

    first_name = backup_module.BackupService.create_backup(source_path, backup_dir)
    assert first_name is not None

    with sqlite3.connect(source_path) as connection:
        connection.execute("UPDATE marker SET value = 'new'")

    second_name = backup_module.BackupService.create_backup(source_path, backup_dir)
    assert second_name is not None
    assert first_name != second_name
    assert len(list(backup_dir.glob("index_*.db"))) == 2

    with sqlite3.connect(first_name) as connection:
        assert connection.execute("SELECT value FROM marker").fetchone() == ("old",)
    with sqlite3.connect(second_name) as connection:
        assert connection.execute("SELECT value FROM marker").fetchone() == ("new",)


def test_create_backup_rejects_failed_integrity_check_and_closes_connections(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.file_system import backup as backup_module

    connections: list[FakeConnection] = []
    source_path = tmp_path / "source.db"
    source_path.write_bytes(b"source exists")

    class FakeCursor:
        @staticmethod
        def fetchone() -> tuple[str]:
            return ("database disk image is malformed",)

    class FakeConnection:
        def __init__(self, path: Path) -> None:
            self.path = path
            self.closed = False

        def backup(self, destination: FakeConnection) -> None:
            destination.path.write_bytes(b"corrupt backup")

        @staticmethod
        def execute(_sql: str) -> FakeCursor:
            return FakeCursor()

        def close(self) -> None:
            self.closed = True

    def fake_connect(path: str, **_kwargs) -> FakeConnection:
        connection = FakeConnection(
            source_path if path.startswith("file:") else Path(path)
        )
        connections.append(connection)
        return connection

    monkeypatch.setattr(backup_module.sqlite3, "connect", fake_connect)

    backup_dir = tmp_path / "backups"
    result = backup_module.BackupService.create_backup(source_path, backup_dir)

    assert result is None
    assert connections and all(connection.closed for connection in connections)
    assert not list(backup_dir.glob(".index_*.tmp"))
    assert not list(backup_dir.glob("index_*.db"))


def test_create_backup_missing_source_fails_without_creating_database(
    tmp_path: Path,
) -> None:
    from app.file_system.backup import BackupService

    source_path = tmp_path / "missing.db"
    backup_dir = tmp_path / "backups"

    assert BackupService.create_backup(source_path, backup_dir) is None
    assert not source_path.exists()
    assert not list(backup_dir.glob("index_*.db"))
    assert not list(backup_dir.glob(".index_*.tmp"))


def test_create_backup_cleanup_failure_does_not_hide_published_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.file_system.backup import BackupService

    source_path = tmp_path / "source.db"
    backup_dir = tmp_path / "backups"
    with sqlite3.connect(source_path) as connection:
        connection.execute("CREATE TABLE marker (value TEXT NOT NULL)")
        connection.execute("INSERT INTO marker VALUES ('preserved')")

    def fail_cleanup(_cls, _backup_dir: Path) -> None:
        raise PermissionError("injected cleanup failure")

    monkeypatch.setattr(
        BackupService,
        "_cleanup_old_backups",
        classmethod(fail_cleanup),
    )

    backup_name = BackupService.create_backup(source_path, backup_dir)

    assert backup_name is not None
    backup_path = Path(backup_name)
    assert backup_path.is_file()
    with sqlite3.connect(backup_path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("SELECT value FROM marker").fetchone() == (
            "preserved",
        )


@pytest.mark.asyncio
async def test_lifespan_triggers_backup_on_startup(_isolate_env, monkeypatch):
    """Startup with backup_enabled=True should call create_backup per space."""
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", True)

    calls: list[tuple[Path, Path]] = []

    from app.file_system import backup as backup_module

    def _fake_create_backup(db_path: Path, backup_dir: Path) -> str | None:
        calls.append((db_path, backup_dir))
        return None

    monkeypatch.setattr(
        backup_module.BackupService,
        "create_backup",
        classmethod(lambda cls, db_path, backup_dir: _fake_create_backup(db_path, backup_dir)),
    )

    from app.db.meta_session import close_meta_db, init_meta_db
    from app.db.models.meta import Space
    from app.db.session import create_session_factory

    await init_meta_db()
    from app.db.meta_session import get_meta_engine
    factory = create_session_factory(get_meta_engine())
    async with factory() as session:
        session.add(Space(
            id="spc_backup_test",
            name="Backup Test Space",
            db_path=str(Path("./data/spaces/spc_backup_test/space.db")),
            notes_dir=str(Path("./data/spaces/spc_backup_test/notes")),
            is_default=False,
        ))
        await session.commit()
    space_db = settings_module.settings.space_db_path("spc_backup_test")
    space_db.parent.mkdir(parents=True, exist_ok=True)
    space_db.write_bytes(b"sqlite3")

    create_app = _fresh_create_app()
    app = create_app()
    async with app.router.lifespan_context(app):
        pass

    await close_meta_db()

    assert len(calls) == 1, f"expected 1 backup call, got {len(calls)}"
    db_path, backup_dir = calls[0]
    assert "spc_backup_test" in str(db_path)


@pytest.mark.asyncio
async def test_lifespan_skips_backup_when_disabled(_isolate_env, monkeypatch):
    """Startup with backup_enabled=False should not call create_backup."""
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", False)

    calls: list[tuple] = []

    from app.file_system import backup as backup_module

    monkeypatch.setattr(
        backup_module.BackupService,
        "create_backup",
        classmethod(lambda cls, db_path, backup_dir: calls.append((db_path, backup_dir)) or None),
    )

    from app.db.meta_session import close_meta_db, init_meta_db
    await init_meta_db()

    create_app = _fresh_create_app()
    app = create_app()
    async with app.router.lifespan_context(app):
        pass

    await close_meta_db()

    assert calls == [], f"backup should be skipped when disabled, got {calls}"


@pytest.mark.asyncio
async def test_lifespan_backup_failure_does_not_block_startup(_isolate_env, monkeypatch):
    """If create_backup raises, startup should continue and /api/health work."""
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", True)

    from app.file_system import backup as backup_module

    def _boom(cls, db_path, backup_dir):
        raise RuntimeError("backup explosion")

    monkeypatch.setattr(backup_module.BackupService, "create_backup", classmethod(_boom))

    from app.db.meta_session import close_meta_db, get_meta_engine, init_meta_db
    from app.db.models.meta import Space
    from app.db.session import create_session_factory

    await init_meta_db()
    factory = create_session_factory(get_meta_engine())
    async with factory() as session:
        session.add(Space(
            id="spc_fail_test",
            name="Fail Test Space",
            db_path=str(Path("./data/spaces/spc_fail_test/space.db")),
            notes_dir=str(Path("./data/spaces/spc_fail_test/notes")),
            is_default=False,
        ))
        await session.commit()
    space_db = settings_module.settings.space_db_path("spc_fail_test")
    space_db.parent.mkdir(parents=True, exist_ok=True)
    space_db.write_bytes(b"sqlite3")

    create_app = _fresh_create_app()
    app = create_app()
    # Lifespan should not raise despite backup failure.
    async with app.router.lifespan_context(app):
        from httpx import ASGITransport, AsyncClient
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            resp = await ac.get("/api/health")
            assert resp.status_code == 200

    await close_meta_db()
