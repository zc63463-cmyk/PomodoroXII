import sqlite3
from contextlib import closing
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
    (space_root / "notes").mkdir()
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
        space_head="space_011_sync_clients_streaming",
        index_schema_version=1,
        sync_waterline="waterline-a",
        entity_counts={"workItem": 1},
        note_hashes={"note-a": "b" * 64},
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
    assert receipt.manifest.spaces[0].sync_waterline == "waterline-a"
    assert coordinator.verify(receipt).valid
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
    connection.execute("INSERT INTO sample VALUES ('wal-only')")
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

    verified = coordinator.verify(receipt.root)

    assert not verified.valid
    assert "file:spaces/alpha/notes/note-a.md" in verified.failures
