import sqlite3
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest


class _Lease:
    fence = 7

    def __init__(self) -> None:
        self.owner_checks = 0
        self.fence_checks = 0

    def assert_active_owner(self, **_kwargs) -> None:
        self.owner_checks += 1

    def assert_fence(self, *_args) -> None:
        self.fence_checks += 1

    async def release(self) -> None:
        return None


class _Leases:
    def __init__(self) -> None:
        self.calls: list[tuple[object, str, float]] = []
        self.lease = _Lease()

    async def acquire_global(self, mode, purpose: str, timeout_seconds: float):
        self.calls.append((mode, purpose, timeout_seconds))
        return self.lease


class _Catalog:
    hash = "a" * 64

    def list(self):
        return [
            SimpleNamespace(name=f"entity_{index}", effective_sync_entity_type=f"entity_{index}")
            for index in range(31)
        ]


def _sqlite(path: Path, value: str = "seed") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            connection.execute("CREATE TABLE sample(value TEXT NOT NULL)")
            connection.execute("INSERT INTO sample VALUES (?)", (value,))


def _coordinator(tmp_path: Path):
    from app.recovery import RecoveryCoordinator

    active_root = tmp_path / "active"
    space_root = active_root / "spaces" / "alpha"
    _sqlite(active_root / "meta.db")
    _sqlite(space_root / "space.db")
    _sqlite(space_root / "index.db")
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            connection.execute("CREATE TABLE alembic_version_meta(version_num TEXT NOT NULL)")
            connection.execute(
                "INSERT INTO alembic_version_meta VALUES ('meta_002_active_session_locator')"
            )
            connection.execute(
                "CREATE TABLE spaces(id TEXT PRIMARY KEY, db_path TEXT NOT NULL, notes_dir TEXT NOT NULL)"
            )
            connection.execute(
                "INSERT INTO spaces VALUES (?, ?, ?)",
                ("alpha", str(space_root / "space.db"), str(space_root / "notes")),
            )
    with closing(sqlite3.connect(space_root / "space.db")) as connection:
        with connection:
            connection.execute("CREATE TABLE alembic_version_space(version_num TEXT NOT NULL)")
            connection.execute(
                "INSERT INTO alembic_version_space VALUES ('space_011_sync_clients_streaming')"
            )
            connection.execute("ALTER TABLE sample ADD COLUMN updated_at TEXT")
            connection.execute("UPDATE sample SET updated_at='2026-07-14T00:00:00.000Z'")
    with closing(sqlite3.connect(space_root / "index.db")) as connection:
        with connection:
            connection.execute(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO schema_meta VALUES ('version', '2')")
    (space_root / "notes").mkdir()
    (space_root / "index").mkdir()
    (space_root / "notes" / "note-a.md").write_text("note", encoding="utf-8")
    leases = _Leases()
    meta = SimpleNamespace(
        db_path=active_root / "meta.db",
        schema_head="meta_002_active_session_locator",
        active_session_coordination={
            "classification": "empty",
            "result": "clean_or_recoverable",
        },
        effort_projection={"result": "verified"},
    )
    space = SimpleNamespace(
        space_id="alpha",
        root=space_root,
        db_path=space_root / "space.db",
        index_db_path=space_root / "index.db",
    )
    return (
        RecoveryCoordinator(
            lease_coordinator=leases,
            active_root=active_root,
            catalog=_Catalog(),
            meta=meta,
            spaces=[space],
        ),
        leases,
        active_root,
    )


def test_verification_result_requires_manifest_when_valid() -> None:
    from app.recovery.contracts import VerificationResult

    with pytest.raises(ValueError):
        VerificationResult(True, "a" * 64, None, 0, 0, ())


def test_verification_result_requires_failures_when_invalid() -> None:
    from app.recovery.contracts import VerificationResult

    with pytest.raises(ValueError):
        VerificationResult(False, "a" * 64, None, 0, 0, ())


def test_manifest_rejects_traversal_path() -> None:
    from app.recovery.manifest import validate_relative_path

    with pytest.raises(ValueError):
        validate_relative_path(Path("../escape"))


@pytest.mark.asyncio
async def test_snapshot_requires_global_exclusive_lease(tmp_path: Path) -> None:
    from app.recovery import RecoveryCoordinator

    coordinator = RecoveryCoordinator(source_root=tmp_path, active_root=tmp_path / "active")
    with pytest.raises(Exception, match="global exclusive lease"):
        await coordinator.snapshot(tmp_path / "external")


def test_verification_rejects_noncanonical_manifest(tmp_path: Path) -> None:
    from app.recovery.contracts import VerificationResult

    result = VerificationResult(False, "a" * 64, None, 0, 0, ("manifest_noncanonical",))
    assert result.valid is False


@pytest.mark.asyncio
async def test_snapshot_covers_complete_inventory_and_uses_one_fence(tmp_path: Path) -> None:
    coordinator, leases, _active_root = _coordinator(tmp_path)

    receipt = await coordinator.snapshot(tmp_path / "snapshots")

    assert {item.relative_path for item in receipt.manifest.files} == {
        "meta/meta.db",
        "spaces/alpha/index.db",
        "spaces/alpha/notes/note-a.md",
        "spaces/alpha/space.db",
    }
    assert receipt.manifest.catalog_entry_count == 31
    assert receipt.manifest.spaces[0].space_head == "space_011_sync_clients_streaming"
    assert receipt.manifest.spaces[0].index_schema_version == 2
    assert receipt.manifest.spaces[0].sync_waterline == "2026-07-14T00:00:00.000Z"
    assert (await coordinator.verify(receipt)).valid
    assert len(leases.calls) == 1
    assert leases.calls[0][2] == 60.0
    assert leases.lease.owner_checks == 1
    assert leases.lease.fence_checks == 1


@pytest.mark.asyncio
async def test_snapshot_rejects_target_inside_active_root_without_creating_it(
    tmp_path: Path,
) -> None:
    coordinator, _leases, active_root = _coordinator(tmp_path)
    target = active_root / "backups"

    with pytest.raises(Exception, match="inside active root"):
        await coordinator.snapshot(target)

    assert not target.exists()


@pytest.mark.asyncio
async def test_snapshot_rejects_noncanonical_catalog(tmp_path: Path) -> None:
    coordinator, _leases, _active_root = _coordinator(tmp_path)
    coordinator.catalog = SimpleNamespace(hash="a" * 64, list=lambda: ())

    with pytest.raises(Exception, match="catalog"):
        await coordinator.snapshot(tmp_path / "snapshots")


@pytest.mark.asyncio
async def test_snapshot_includes_committed_wal_rows(tmp_path: Path) -> None:
    coordinator, _leases, active_root = _coordinator(tmp_path)
    source = active_root / "spaces" / "alpha" / "space.db"
    connection = sqlite3.connect(source)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        "INSERT INTO sample(value, updated_at) VALUES ('wal-only', '2026-07-15T00:00:00.000Z')"
    )
    connection.commit()
    try:
        receipt = await coordinator.snapshot(tmp_path / "snapshots")
    finally:
        connection.close()

    with sqlite3.connect(receipt.root / "spaces" / "alpha" / "space.db") as copied:
        assert copied.execute(
            "SELECT value FROM sample ORDER BY rowid DESC LIMIT 1"
        ).fetchone() == ("wal-only",)


@pytest.mark.asyncio
async def test_copy_failure_leaves_no_complete_snapshot(tmp_path: Path, monkeypatch) -> None:
    import app.recovery.coordinator as recovery_coordinator

    coordinator, _leases, _active_root = _coordinator(tmp_path)
    original = recovery_coordinator.backup_sqlite
    calls = 0

    def fail_after_first(source: Path, destination: Path):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected copy failure")
        return original(source, destination)

    monkeypatch.setattr(recovery_coordinator, "backup_sqlite", fail_after_first)
    target = tmp_path / "snapshots"

    with pytest.raises(OSError, match="injected copy failure"):
        await coordinator.snapshot(target)

    assert not list(target.glob("*"))


@pytest.mark.asyncio
async def test_verify_rejects_file_tampering(tmp_path: Path) -> None:
    coordinator, _leases, _active_root = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    (receipt.root / "spaces" / "alpha" / "notes" / "note-a.md").write_text(
        "tampered", encoding="utf-8"
    )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "file:spaces/alpha/notes/note-a.md" in verified.failures


@pytest.mark.asyncio
async def test_snapshot_enumerates_every_space_from_meta_registry(tmp_path: Path) -> None:
    coordinator, _leases, active_root = _coordinator(tmp_path)
    beta_root = active_root / "spaces" / "beta"
    _sqlite(beta_root / "space.db")
    _sqlite(beta_root / "index.db")
    (beta_root / "notes").mkdir()
    (beta_root / "index").mkdir()
    with closing(sqlite3.connect(beta_root / "space.db")) as connection:
        with connection:
            connection.execute("CREATE TABLE alembic_version_space(version_num TEXT NOT NULL)")
            connection.execute(
                "INSERT INTO alembic_version_space VALUES ('space_011_sync_clients_streaming')"
            )
    with closing(sqlite3.connect(beta_root / "index.db")) as connection:
        with connection:
            connection.execute(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO schema_meta VALUES ('version', '2')")
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            connection.execute(
                "INSERT INTO spaces VALUES (?, ?, ?)",
                ("beta", str(beta_root / "space.db"), str(beta_root / "notes")),
            )
    coordinator.spaces = None

    receipt = await coordinator.snapshot(tmp_path / "snapshots")

    assert tuple(space.space_id for space in receipt.manifest.spaces) == ("alpha", "beta")
    assert "spaces/beta/space.db" in {item.relative_path for item in receipt.manifest.files}


@pytest.mark.asyncio
async def test_snapshot_rejects_missing_notes_directory(tmp_path: Path) -> None:
    coordinator, _leases, active_root = _coordinator(tmp_path)
    notes = active_root / "spaces" / "alpha" / "notes"
    (notes / "note-a.md").unlink()
    notes.rmdir()

    with pytest.raises(Exception, match="invalid asset directory"):
        await coordinator.snapshot(tmp_path / "snapshots")


@pytest.mark.asyncio
async def test_snapshot_under_lease_rejects_missing_fence(tmp_path: Path) -> None:
    coordinator, _leases, _active_root = _coordinator(tmp_path)
    target = tmp_path / "snapshots"
    target.mkdir()

    with pytest.raises(Exception, match="global exclusive lease"):
        await coordinator._snapshot_under_lease(target, None)

    assert not list(target.iterdir())


@pytest.mark.asyncio
async def test_snapshot_rejects_unrecoverable_coordination(tmp_path: Path) -> None:
    coordinator, _leases, _active_root = _coordinator(tmp_path)
    coordinator.meta.active_session_coordination = {
        "classification": "manual_intervention",
        "result": "invalid",
    }

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(tmp_path / "snapshots")

    assert raised.value.record.code == "active_session_recovery_required"


@pytest.mark.asyncio
async def test_snapshot_rejects_effort_projection_drift(tmp_path: Path) -> None:
    coordinator, _leases, _active_root = _coordinator(tmp_path)
    coordinator.meta.effort_projection = {"result": "drift"}

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(tmp_path / "snapshots")

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.parametrize(
    "stage",
    (
        "database_copy:meta/meta.db",
        "asset_copy:spaces/alpha/notes/note-a.md",
        "manifest_write",
        "fsync",
        "atomic_publish",
    ),
)
@pytest.mark.asyncio
async def test_publication_failure_leaves_no_complete_snapshot(tmp_path: Path, stage: str) -> None:
    coordinator, _leases, _active_root = _coordinator(tmp_path)

    def failpoint(name: str) -> None:
        if name == stage:
            raise OSError(f"injected {stage}")

    coordinator.failpoint = failpoint
    target = tmp_path / "snapshots"

    with pytest.raises(OSError, match="injected"):
        await coordinator.snapshot(target)

    assert not list(target.iterdir())


@pytest.mark.asyncio
async def test_verify_recomputes_space_manifest_facts(tmp_path: Path) -> None:
    from app.recovery.manifest import canonical_json
    from app.recovery.sqlite_copy import sha256_file

    coordinator, _leases, _active_root = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    altered_space = replace(receipt.manifest.spaces[0], entity_counts={"sample": 999})
    altered = replace(receipt.manifest, spaces=(altered_space,))
    manifest_path = receipt.root / "manifest.json"
    manifest_path.write_bytes(canonical_json(altered))
    (receipt.root / "manifest.sha256").write_text(
        sha256_file(manifest_path) + "\n", encoding="ascii"
    )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "space_manifest" in verified.failures
