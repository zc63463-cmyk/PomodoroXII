import asyncio
import hashlib
import json
import sqlite3
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.recovery.manifest import canonical_json

BODY = "note body"
CONTENT_HASH = hashlib.sha256(BODY.encode("utf-8")).hexdigest()
NOTE_RELATIVE = "spaces/alpha/notes/n_alpha-note-a.md"

_EXPECTED_INDEX_TABLES = frozenset(
    {"notes", "folders", "note_paths", "note_versions", "note_links", "schema_meta", "sync_audit_log"}
)
_EXPECTED_INDEX_FTS = frozenset(
    {"notes_fts", "notes_fts_insert", "notes_fts_update", "notes_fts_delete"}
)

# Every SQLAlchemy engine opened by the read-only view factory is registered
# here so the autouse fixture can dispose them after each test.  NullPool also
# closes every connection immediately, so no SQLite file handle is retained.
_ALL_ENGINES: list[object] = []


@pytest.fixture(autouse=True)
async def _dispose_all_engines() -> None:
    yield
    for engine in _ALL_ENGINES:
        await engine.dispose()
    _ALL_ENGINES.clear()


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


class _EffortCompiler:
    """Signature-true stand-in for EffortProjectionCompiler.verify_all(scope).

    Uses the real ``scope.session_factory`` contract and proves the view really
    points at the copied database by reading its ``sample`` table.
    """

    def __init__(self, mismatches: tuple[object, ...] = ()) -> None:
        self.mismatches = mismatches
        self.seen_samples: list[str] = []

    async def verify_all(self, scope):
        factory = getattr(scope, "session_factory", None)
        if factory is None:
            raise AttributeError("effort scope has no session_factory")
        async with factory() as session:
            value = (
                await session.execute(text("SELECT value FROM sample ORDER BY value LIMIT 1"))
            ).scalars().first()
        self.seen_samples.append(str(value))
        return self.mismatches


class _PublicIndexVerifier:
    """Public read-only ``verify(path)`` adapter over a copied ``index.db``.

    RecoveryCoordinator only consumes the S5-locked public
    ``verify(path) -> IndexSchemaStatus`` interface.  This adapter performs a
    real structural check with a read-only sqlite3 connection and never touches
    runtime VFS internals, so it stands in for the production adapter that an
    operator would inject (mirroring ``IndexStoreSchema``'s contract).
    """

    def __init__(self, version: int = 2) -> None:
        self.version = version
        self.calls: list[Path] = []

    async def verify(self, path: Path):
        self.calls.append(Path(path))
        uri = f"{Path(path).resolve().as_uri()}?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            objects = {
                name: kind for name, kind in connection.execute("SELECT name, type FROM sqlite_master")
            }
            version_row = (
                connection.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()
                if "schema_meta" in objects
                else None
            )
        version = int(version_row[0]) if version_row else 0
        missing_tables = tuple(sorted(_EXPECTED_INDEX_TABLES - set(objects)))
        missing_fts = tuple(sorted(_EXPECTED_INDEX_FTS - set(objects)))
        valid = version == self.version and not missing_tables and not missing_fts
        return SimpleNamespace(
            version=version,
            valid=valid,
            missing_tables=missing_tables,
            missing_indexes=(),
            missing_fts_objects=missing_fts,
            failure_code=None if valid else "index_schema_invalid",
        )


class _RecordingMigration:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Path]] = []

    async def verify(self, kind: str, path: Path):
        self.calls.append((kind, Path(path)))
        table = "alembic_version_meta" if kind == "meta" else "alembic_version_space"
        with closing(sqlite3.connect(path)) as connection:
            head = connection.execute(f'SELECT version_num FROM "{table}"').fetchone()[0]
        return SimpleNamespace(
            kind=kind, revision=head, head=head, at_head=True, integrity_ok=True
        )


class _RecordingIndex:
    def __init__(self) -> None:
        self.calls: list[Path] = []

    async def verify(self, path: Path):
        self.calls.append(Path(path))
        return SimpleNamespace(version=2, valid=True)


class _RecordingKnowledge:
    def __init__(self) -> None:
        self.calls: list[object] = []

    async def verify(self, view):
        self.calls.append(view)
        return SimpleNamespace(valid=True, issues=())


class _RecordingMutation:
    def __init__(self) -> None:
        self.calls: list[object] = []

    async def inspect_recovery(self, view):
        self.calls.append(view)
        return SimpleNamespace(clean=True, reasons=())


def _sqlite(path: Path, value: str = "seed") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            connection.execute("CREATE TABLE sample(value TEXT NOT NULL)")
            connection.execute("INSERT INTO sample VALUES (?)", (value,))


def _make_meta_db(path: Path, space_root: Path) -> None:
    """Build a Meta database with the exact production DDL.

    Mirrors alembic_meta/versions/001_meta_schema.py and
    002_active_session_locator.py (columns, CHECK constraints, PKs, indexes)
    without going through the Alembic/VFS machinery, which is not usable from
    inside an async test event loop.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    timestamp = "2026-07-14T00:00:00.000Z"
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            connection.execute("CREATE TABLE alembic_version_meta(version_num TEXT NOT NULL)")
            connection.execute(
                "INSERT INTO alembic_version_meta VALUES ('meta_002_active_session_locator')"
            )
            connection.execute(
                """
                CREATE TABLE spaces (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    db_path VARCHAR(500) NOT NULL,
                    notes_dir VARCHAR(500) NOT NULL,
                    is_default BOOLEAN NOT NULL DEFAULT 0,
                    created_at VARCHAR(32) NOT NULL,
                    updated_at VARCHAR(32) NOT NULL
                )
                """
            )
            connection.execute(
                "INSERT INTO spaces (id, name, db_path, notes_dir, is_default, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 0, ?, ?)",
                ("alpha", "alpha", str(space_root / "space.db"), str(space_root / "notes"), timestamp, timestamp),
            )
            connection.execute(
                """
                CREATE TABLE meta_settings (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    key VARCHAR(100) NOT NULL UNIQUE,
                    value VARCHAR(2000),
                    created_at VARCHAR(32) NOT NULL,
                    updated_at VARCHAR(32) NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE active_session_locator (
                    singleton_key VARCHAR(16) NOT NULL PRIMARY KEY DEFAULT 'active',
                    space_id VARCHAR(36) NOT NULL,
                    session_id VARCHAR(36) NOT NULL,
                    operation_id VARCHAR(128) NOT NULL,
                    state VARCHAR(20) NOT NULL,
                    owner_device_id VARCHAR(64) NOT NULL,
                    owner_tab_id VARCHAR(64) NOT NULL,
                    ownership_epoch INTEGER NOT NULL,
                    lease_expires_at VARCHAR(32) NOT NULL,
                    updated_at VARCHAR(32) NOT NULL,
                    CONSTRAINT single_active_slot CHECK (singleton_key = 'active'),
                    CONSTRAINT state CHECK (state IN ('claiming','active','releasing')),
                    CONSTRAINT ownership_epoch_positive CHECK (ownership_epoch > 0)
                )
                """
            )
            for column in ("space_id", "session_id", "operation_id", "lease_expires_at"):
                connection.execute(
                    f"CREATE INDEX ix_active_session_locator_{column} "
                    f"ON active_session_locator ({column})"
                )
            connection.execute(
                """
                CREATE TABLE active_session_operations (
                    operation_id VARCHAR(128) NOT NULL PRIMARY KEY,
                    kind VARCHAR(40) NOT NULL,
                    payload_hash VARCHAR(64) NOT NULL,
                    intent_json TEXT NOT NULL,
                    phase VARCHAR(32) NOT NULL,
                    result_descriptor_json TEXT,
                    related_operation_id VARCHAR(128),
                    created_at VARCHAR(32) NOT NULL,
                    updated_at VARCHAR(32) NOT NULL,
                    CONSTRAINT active_session_operation_kind CHECK (
                        kind IN ('start','heartbeat','pause','resume','end','takeover',
                        'update_note','set_current_plan_item','set_completion_draft',
                        'add_plan_item','remove_plan_item','activate_provisional',
                        'resolve_activation_conflict')
                    ),
                    CONSTRAINT active_session_operation_phase CHECK (
                        phase IN ('prepared','claimed','space_committed',
                        'awaiting_resolution','transferred','completed','rejected',
                        'manual_intervention')
                    ),
                    CONSTRAINT active_session_operation_hash CHECK (
                        payload_hash NOT GLOB '*[^0-9a-f]*' AND length(payload_hash) = 64
                    ),
                    CONSTRAINT active_session_operation_result_descriptor_size CHECK (
                        result_descriptor_json IS NULL OR
                        length(CAST(result_descriptor_json AS BLOB)) <= 8192
                    )
                )
                """
            )
            for column in ("kind", "phase", "related_operation_id"):
                connection.execute(
                    f"CREATE INDEX ix_active_session_operations_{column} "
                    f"ON active_session_operations ({column})"
                )
            connection.execute("CREATE TABLE sample(value TEXT NOT NULL)")
            connection.execute("INSERT INTO sample VALUES ('seed')")


def _make_space_db(
    path: Path, *, waterline: str = "2026-07-14T00:00:00.000Z", with_note: bool = True
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            connection.execute("CREATE TABLE alembic_version_space(version_num TEXT NOT NULL)")
            connection.execute(
                "INSERT INTO alembic_version_space VALUES ('space_011_sync_clients_streaming')"
            )
            connection.execute(
                """
                CREATE TABLE folders (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', parent_id TEXT,
                    icon TEXT, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
                    is_system INTEGER NOT NULL DEFAULT 0, trashed_at TEXT,
                    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE notes (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
                    content_hash TEXT NOT NULL DEFAULT '', word_count INTEGER NOT NULL DEFAULT 0,
                    summary TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                    category TEXT, folder_id TEXT, status TEXT NOT NULL DEFAULT 'active',
                    trashed_at TEXT, created_at TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT '', is_deleted INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE mutation_batches (
                    batch_id TEXT PRIMARY KEY, command_hash TEXT NOT NULL,
                    state TEXT NOT NULL, accepted_count INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            if with_note:
                connection.execute(
                    """
                    INSERT INTO notes (id, title, content_hash, word_count, summary, tags,
                        category, folder_id, status, trashed_at, created_at, updated_at, is_deleted)
                    VALUES ('n_alpha', 'note-a', ?, 1, '', '[]', NULL, NULL, 'active', NULL,
                        '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 0)
                    """,
                    (CONTENT_HASH,),
                )
            connection.execute("CREATE TABLE sample(value TEXT NOT NULL, updated_at TEXT)")
            connection.execute("INSERT INTO sample VALUES (?, ?)", ("seed", waterline))


def _make_index_db(path: Path, *, with_note: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    from app.file_system.index_schema import INDEX_SCHEMA_VERSION, _ordinary_index_sql
    from app.file_system.schema import init_database

    init_database(path)
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            connection.execute(
                "UPDATE schema_meta SET value=? WHERE key='version'",
                (str(INDEX_SCHEMA_VERSION),),
            )
            for sql in _ordinary_index_sql().values():
                connection.execute(sql)
            if with_note:
                connection.execute(
                    """
                    INSERT INTO notes (note_id, title, current_path, content_hash, folder_id,
                        level, status, tags, word_count, is_deleted, summary, category,
                        trashed_at, created_at, updated_at)
                    VALUES ('n_alpha', 'note-a', 'notes/n_alpha-note-a.md', ?, NULL,
                        'L1', 'active', '[]', 1, 0, '', NULL,
                        NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
                    """,
                    (CONTENT_HASH,),
                )
                connection.execute(
                    "UPDATE notes_fts SET content=? WHERE rowid=last_insert_rowid()", (BODY,)
                )


def _write_note(notes_dir: Path) -> None:
    notes_dir.mkdir(parents=True, exist_ok=True)
    frontmatter = (
        "---\n"
        "id: n_alpha\n"
        "title: note-a\n"
        "tags: []\n"
        "folder_id: null\n"
        f"content_hash: sha256:{CONTENT_HASH}\n"
        "created_at: 2026-07-14T00:00:00.000Z\n"
        "updated_at: 2026-07-14T00:00:00.000Z\n"
        "---\n"
    )
    (notes_dir / "n_alpha-note-a.md").write_text(frontmatter + BODY, encoding="utf-8")


def _make_alpha_space(active_root: Path) -> Path:
    space_root = active_root / "spaces" / "alpha"
    _make_space_db(space_root / "space.db")
    _make_index_db(space_root / "index.db")
    _write_note(space_root / "notes")
    return space_root


def _view_factory(engines: list[object]):
    def factory(kind: str, path: Path):
        if kind == "meta":
            return SimpleNamespace(db_path=Path(path))
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{Path(path) / 'space.db'}",
            poolclass=NullPool,
        )
        engines.append(engine)
        _ALL_ENGINES.append(engine)
        return SimpleNamespace(
            scope=SimpleNamespace(space_id=Path(path).name),
            session_factory=async_sessionmaker(engine, expire_on_commit=False),
        )

    return factory


def _coordinator(tmp_path: Path, *, real_authorities: bool = True):
    from app.db.migrations import MigrationCoordinator
    from app.knowledge.consistency import KnowledgeConsistencyChecker
    from app.mutation.recovery import MutationRecovery
    from app.recovery import RecoveryCoordinator
    from app.registry import CATALOG

    active_root = tmp_path / "active"
    space_root = _make_alpha_space(active_root)
    _make_meta_db(active_root / "meta.db", space_root)
    leases = _Leases()
    engines: list[object] = []
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
    coordinator = RecoveryCoordinator(
        lease_coordinator=leases,
        active_root=active_root,
        catalog=CATALOG,
        meta=meta,
        spaces=[space],
        effort_projection_compiler=_EffortCompiler(),
        recovery_view_factory=_view_factory(engines),
        migration_coordinator=MigrationCoordinator() if real_authorities else None,
        index_schema=_PublicIndexVerifier() if real_authorities else None,
        knowledge_checker=KnowledgeConsistencyChecker() if real_authorities else None,
        mutation_recovery_inspector=(
            MutationRecovery(catalog=None, interpreter=None, projection_executor=None)
            if real_authorities
            else None
        ),
    )
    return coordinator, leases, active_root, engines


async def _dispose(engines: list[object]) -> None:
    for engine in engines:
        await engine.dispose()


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
    coordinator, leases, _active_root, engines = _coordinator(tmp_path)

    receipt = await coordinator.snapshot(tmp_path / "snapshots")

    assert {item.relative_path for item in receipt.manifest.files} == {
        "meta/meta.db",
        "spaces/alpha/index.db",
        NOTE_RELATIVE,
        "spaces/alpha/space.db",
    }
    assert receipt.manifest.catalog_entry_count == 31
    assert receipt.manifest.catalog_hash == coordinator.catalog.hash
    assert receipt.manifest.spaces[0].space_head == "space_011_sync_clients_streaming"
    assert receipt.manifest.spaces[0].index_schema_version == 2
    assert receipt.manifest.spaces[0].sync_waterline == "2026-07-14T00:00:00.000Z"
    verified = await coordinator.verify(receipt)
    assert verified.valid, verified.failures
    assert len(leases.calls) == 1
    assert leases.calls[0][2] == 60.0
    assert leases.lease.owner_checks == 1
    assert leases.lease.fence_checks == 1
    await _dispose(engines)


@pytest.mark.asyncio
async def test_snapshot_rejects_target_inside_active_root_without_creating_it(
    tmp_path: Path,
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    target = active_root / "backups"

    with pytest.raises(Exception, match="inside active root"):
        await coordinator.snapshot(target)

    assert not target.exists()


@pytest.mark.asyncio
async def test_snapshot_rejects_noncanonical_catalog(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    coordinator.catalog = SimpleNamespace(hash="a" * 64, list=lambda: ())

    with pytest.raises(Exception, match="catalog"):
        await coordinator.snapshot(tmp_path / "snapshots")


@pytest.mark.asyncio
async def test_snapshot_includes_committed_wal_rows(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
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

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
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
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    (receipt.root / "spaces" / "alpha" / "notes" / "n_alpha-note-a.md").write_text(
        "tampered", encoding="utf-8"
    )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "file:spaces/alpha/notes/n_alpha-note-a.md" in verified.failures


@pytest.mark.asyncio
async def test_snapshot_enumerates_every_space_from_meta_registry(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    beta_root = active_root / "spaces" / "beta"
    _make_space_db(beta_root / "space.db", waterline="", with_note=False)
    _make_index_db(beta_root / "index.db", with_note=False)
    (beta_root / "notes").mkdir()
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            connection.execute(
                "INSERT INTO spaces (id, name, db_path, notes_dir, is_default, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 0, ?, ?)",
                (
                    "beta",
                    "beta",
                    str(beta_root / "space.db"),
                    str(beta_root / "notes"),
                    "2026-07-14T00:00:00.000Z",
                    "2026-07-14T00:00:00.000Z",
                ),
            )
    coordinator.spaces = [*coordinator.spaces, SimpleNamespace(space_id="beta")]

    receipt = await coordinator.snapshot(tmp_path / "snapshots")

    assert tuple(space.space_id for space in receipt.manifest.spaces) == ("alpha", "beta")
    assert "spaces/beta/space.db" in {item.relative_path for item in receipt.manifest.files}
    verified = await coordinator.verify(receipt)
    assert verified.valid, verified.failures


@pytest.mark.asyncio
async def test_snapshot_rejects_missing_notes_directory(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    notes = active_root / "spaces" / "alpha" / "notes"
    (notes / "n_alpha-note-a.md").unlink()
    notes.rmdir()

    with pytest.raises(Exception, match="invalid asset directory"):
        await coordinator.snapshot(tmp_path / "snapshots")


@pytest.mark.asyncio
async def test_snapshot_under_lease_rejects_missing_fence(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    target = tmp_path / "snapshots"
    target.mkdir()

    with pytest.raises(Exception, match="global exclusive lease"):
        await coordinator._snapshot_under_lease(target, None)

    assert not list(target.iterdir())


@pytest.mark.asyncio
async def test_snapshot_rejects_unrecoverable_coordination(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            connection.execute(
                "INSERT INTO active_session_locator VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "active",
                    "alpha",
                    "session-1",
                    "op-manual",
                    "claiming",
                    "device-1",
                    "tab-1",
                    1,
                    "2099-01-01T00:00:00.000Z",
                    "2026-07-14T00:00:00.000Z",
                ),
            )
            connection.execute(
                "INSERT INTO active_session_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "op-manual",
                    "start",
                    "a" * 64,
                    "{}",
                    "manual_intervention",
                    None,
                    None,
                    "2026-07-14T00:00:00.000Z",
                    "2026-07-14T00:00:00.000Z",
                ),
            )

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(tmp_path / "snapshots")

    assert raised.value.record.code == "active_session_recovery_required"


@pytest.mark.asyncio
async def test_active_session_inspector_classifies_real_meta_state(tmp_path: Path) -> None:
    from app.recovery import ActiveSessionCoordinationInspector

    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    inspector = coordinator.active_coordination_inspector
    assert isinstance(inspector, ActiveSessionCoordinationInspector)
    empty = await inspector.inspect_read_only(SimpleNamespace(db_path=active_root / "meta.db"))
    assert empty["classification"] == "empty"
    assert empty["result"] == "clean_or_recoverable"

    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-active")
            _insert_operation(connection, operation_id="op-active", phase="completed")
    with pytest.raises(Exception) as raised:
        await inspector.inspect_read_only(SimpleNamespace(db_path=active_root / "meta.db"))
    assert raised.value.record.code == "recovery_inspector_unavailable:active_session_authority"


def _insert_locator(
    connection,
    *,
    state: str,
    operation_id: str,
    lease: str = "2099-01-01T00:00:00.000Z",
    space_id: str = "alpha",
    session_id: str = "session-1",
    epoch: int = 1,
    updated_at: str = "2026-07-14T00:00:00.000Z",
) -> None:
    connection.execute(
        "INSERT INTO active_session_locator VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "active",
            space_id,
            session_id,
            operation_id,
            state,
            "device-1",
            "tab-1",
            epoch,
            lease,
            updated_at,
        ),
    )


def _make_intent(
    *,
    operation_id: str,
    kind: str = "start",
    space_id: str = "alpha",
    session_id: str = "session-1",
    epoch: int = 1,
    business: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build a TS2-model intent whose business subset is really hashed."""
    from app.mutation.types import canonical_payload_hash

    business = dict(business or {"planned_seconds": 1500, "owner_device_id": "device-1"})
    intent = {
        "command_id": operation_id,
        "space_id": space_id,
        "session_id": session_id,
        "ownership_epoch": epoch,
        "payload_hash": canonical_payload_hash(business),
        "kind": kind,
        **business,
    }
    return intent


def _insert_operation(
    connection,
    *,
    operation_id: str,
    phase: str,
    kind: str = "start",
    intent: dict[str, object] | None = None,
    related_operation_id: str | None = None,
    result_descriptor_json: str | None = None,
    created_at: str = "2026-07-14T00:00:00.000Z",
    updated_at: str = "2026-07-14T00:00:00.000Z",
) -> None:
    if intent is None:
        intent = _make_intent(operation_id=operation_id, kind=kind)
    connection.execute(
        "INSERT INTO active_session_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            operation_id,
            intent["kind"],
            intent["payload_hash"],
            json.dumps(intent, sort_keys=True),
            phase,
            result_descriptor_json,
            related_operation_id,
            created_at,
            updated_at,
        ),
    )


async def _inspect_meta(active_root: Path) -> dict[str, str]:
    from datetime import datetime, timezone

    from app.recovery import ActiveSessionCoordinationInspector

    inspector = ActiveSessionCoordinationInspector(
        now=datetime(2026, 8, 1, tzinfo=timezone.utc)
    )
    return await inspector.inspect_read_only(SimpleNamespace(db_path=active_root / "meta.db"))


@pytest.mark.asyncio
async def test_inspector_rejects_missing_locator_table(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        connection.execute("DROP TABLE active_session_locator")
        connection.commit()

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "locator" in str(raised.value)


@pytest.mark.asyncio
async def test_inspector_rejects_missing_operations_table(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        connection.execute("DROP TABLE active_session_operations")
        connection.commit()

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "operations" in str(raised.value)


@pytest.mark.asyncio
async def test_snapshot_rejects_missing_operations_table(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        connection.execute("DROP TABLE active_session_operations")
        connection.commit()

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(tmp_path / "snapshots")

    assert raised.value.record.code == "active_session_recovery_required"


@pytest.mark.asyncio
async def test_inspector_rejects_missing_operation_row(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-missing")

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "operation" in str(raised.value) and "missing" in str(raised.value)


@pytest.mark.parametrize(
    "state,operation_id,lease,phase",
    (
        ("active", "", "2099-01-01T00:00:00.000Z", "completed"),
        ("active", "op-1", "not-a-date", "completed"),
        ("claiming", "op-1", "2099-01-01T00:00:00.000Z", "manual_intervention"),
        ("active", "op-1", "2020-01-01T00:00:00.000Z", "completed"),
        ("active", "op-1", "2099-01-01T00:00:00.000Z", "prepared"),
        ("claiming", "op-1", "2099-01-01T00:00:00.000Z", "prepared"),
        ("claiming", "op-1", "2099-01-01T00:00:00.000Z", "space_committed"),
        ("releasing", "op-1", "2099-01-01T00:00:00.000Z", "claimed"),
        ("releasing", "op-1", "2099-01-01T00:00:00.000Z", "transferred"),
        ("active", "op-1", "2099-01-01T00:00:00.000Z", "rejected"),
    ),
)
@pytest.mark.asyncio
async def test_inspector_fails_closed_on_damaged_state(
    tmp_path: Path, state: str, operation_id: str, lease: str, phase: str
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state=state, operation_id=operation_id, lease=lease)
            _insert_operation(connection, operation_id=operation_id, phase=phase)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.parametrize(
    "state,phase",
    (
        ("bogus", "completed"),
        ("claiming", "bogus_phase"),
        ("active", "bogus_phase"),
    ),
)
@pytest.mark.asyncio
async def test_inspector_rejects_check_covered_enum_damage(
    tmp_path: Path, state: str, phase: str
) -> None:
    """The production CHECK constraints already reject these rows; simulate a
    tampered schema (unchecked rebuild) and prove the inspector still fails
    closed instead of trusting the enum-looking values."""
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _rebuild_locator_unchecked(connection)
            _rebuild_operations_unchecked(connection)
            _insert_locator(connection, state=state, operation_id="op-1")
            _insert_operation(connection, operation_id="op-1", phase=phase)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


def _rebuild_locator_unchecked(connection) -> None:
    connection.execute("DROP TABLE active_session_locator")
    connection.execute(
        """
        CREATE TABLE active_session_locator (
            singleton_key VARCHAR(16) NOT NULL DEFAULT 'active',
            space_id VARCHAR(36) NOT NULL, session_id VARCHAR(36) NOT NULL,
            operation_id VARCHAR(128) NOT NULL, state VARCHAR(20) NOT NULL,
            owner_device_id VARCHAR(64) NOT NULL, owner_tab_id VARCHAR(64) NOT NULL,
            ownership_epoch INTEGER NOT NULL, lease_expires_at VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL
        )
        """
    )


def _rebuild_operations_unchecked(connection) -> None:
    connection.execute("DROP TABLE active_session_operations")
    connection.execute(
        """
        CREATE TABLE active_session_operations (
            operation_id VARCHAR(128) NOT NULL PRIMARY KEY,
            kind VARCHAR(40) NOT NULL, payload_hash VARCHAR(64) NOT NULL,
            intent_json TEXT NOT NULL, phase VARCHAR(32) NOT NULL,
            result_descriptor_json TEXT, related_operation_id VARCHAR(128),
            created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL
        )
        """
    )


@pytest.mark.parametrize(
    "state,phase",
    (
        ("active", "completed"),
        ("claiming", "claimed"),
        ("claiming", "awaiting_resolution"),
        ("releasing", "space_committed"),
    ),
)
@pytest.mark.asyncio
async def test_inspector_requires_space_child_authority(
    tmp_path: Path, state: str, phase: str
) -> None:
    """The TS2 recovery decision table needs Space child/Session facts for
    every non-empty classification.  S5 has no callable TS2 authority, so a
    structurally complete non-empty coordination must fail closed instead of
    being declared recoverable from Meta state/phase alone."""
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state=state, operation_id="op-flow")
            _insert_operation(connection, operation_id="op-flow", phase=phase)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "recovery_inspector_unavailable:active_session_authority"


@pytest.mark.asyncio
async def test_snapshot_rejects_effort_projection_drift(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    coordinator.effort_projection_compiler.mismatches = ("drift",)

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(tmp_path / "snapshots")

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_snapshot_rejects_missing_recovery_inspectors(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    coordinator.effort_projection_compiler = None

    with pytest.raises(Exception, match="unavailable"):
        await coordinator.snapshot(tmp_path / "snapshots")


@pytest.mark.parametrize(
    "stage",
    (
        "database_copy:meta/meta.db",
        "asset_copy:spaces/alpha/notes/n_alpha-note-a.md",
        "manifest_write",
        "fsync",
        "atomic_publish",
    ),
)
@pytest.mark.asyncio
async def test_publication_failure_leaves_no_complete_snapshot(tmp_path: Path, stage: str) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)

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

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
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


@pytest.mark.asyncio
async def test_verify_requires_snapshot_recovery_views(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    coordinator.recovery_view_factory = None

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "recovery_inspector_unavailable" in verified.failures


def _republish_manifest(root: Path, payload: bytes) -> None:
    from app.recovery.sqlite_copy import sha256_file

    manifest_path = root / "manifest.json"
    manifest_path.write_bytes(payload)
    (root / "manifest.sha256").write_text(sha256_file(manifest_path) + "\n", encoding="ascii")


@pytest.mark.asyncio
async def test_verify_reruns_all_read_only_authorities(tmp_path: Path) -> None:
    from app.recovery import RecoveryCoordinator

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    recording_migration = _RecordingMigration()
    recording_index = _RecordingIndex()
    recording_knowledge = _RecordingKnowledge()
    recording_mutation = _RecordingMutation()
    coordinator.migration_coordinator = recording_migration
    coordinator.index_schema = recording_index
    coordinator.knowledge_checker = recording_knowledge
    coordinator.mutation_recovery_inspector = recording_mutation

    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    verified = await coordinator.verify(receipt.root)

    assert verified.valid, verified.failures
    assert ("meta", receipt.root / "meta" / "meta.db") in recording_migration.calls
    assert ("space", receipt.root / "spaces" / "alpha" / "space.db") in recording_migration.calls
    assert receipt.root / "spaces" / "alpha" / "index.db" in recording_index.calls
    assert len(recording_knowledge.calls) == 1
    assert recording_knowledge.calls[0].space_id == "alpha"
    assert recording_knowledge.calls[0].catalog_hash == coordinator.catalog.hash
    assert len(recording_mutation.calls) == 1


@pytest.mark.parametrize(
    "attribute",
    (
        "migration_coordinator",
        "index_schema",
        "knowledge_checker",
        "mutation_recovery_inspector",
        "active_coordination_inspector",
        "effort_projection_compiler",
    ),
)
@pytest.mark.asyncio
async def test_verify_fails_closed_when_authority_missing(
    tmp_path: Path, attribute: str
) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    setattr(coordinator, attribute, None)

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert any(
        failure.startswith("recovery_inspector_unavailable:") for failure in verified.failures
    )
    assert attribute in verified.failures[0]


@pytest.mark.asyncio
async def test_verify_rejects_manifest_extra_inventory(tmp_path: Path) -> None:
    from dataclasses import replace

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    # A forged file outside every registered Space cannot be covered by the
    # canonical inventory derived from the copied Meta registry.
    forged = receipt.root / "rogue.txt"
    forged.write_text("forged", encoding="utf-8")
    from app.recovery.contracts import SnapshotFile

    forged_file = SnapshotFile(
        "rogue.txt",
        forged.stat().st_size,
        hashlib.sha256(forged.read_bytes()).hexdigest(),
        "note",
    )
    _republish_manifest(
        receipt.root,
        canonical_json(replace(receipt.manifest, files=(*receipt.manifest.files, forged_file))),
    )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "manifest_inventory" in verified.failures
    assert "inventory_extra:rogue.txt" in verified.failures


@pytest.mark.asyncio
async def test_verify_rejects_forged_note_outside_authority(tmp_path: Path) -> None:
    from dataclasses import replace

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    forged = receipt.root / "spaces" / "alpha" / "notes" / "forged.md"
    forged.write_text("forged", encoding="utf-8")
    from app.recovery.contracts import SnapshotFile

    forged_file = SnapshotFile(
        "spaces/alpha/notes/forged.md",
        forged.stat().st_size,
        hashlib.sha256(forged.read_bytes()).hexdigest(),
        "note",
    )
    _republish_manifest(
        receipt.root,
        canonical_json(replace(receipt.manifest, files=(*receipt.manifest.files, forged_file))),
    )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert (
        "space_manifest" in verified.failures or "knowledge_consistency:alpha" in verified.failures
    )


@pytest.mark.asyncio
async def test_verify_rejects_manifest_inventory_missing(tmp_path: Path) -> None:
    from dataclasses import replace

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    removed = receipt.root / "spaces" / "alpha" / "index.db"
    removed.unlink()
    _republish_manifest(
        receipt.root,
        canonical_json(
            replace(
                receipt.manifest,
                files=tuple(
                    item
                    for item in receipt.manifest.files
                    if item.relative_path != "spaces/alpha/index.db"
                ),
            )
        ),
    )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "manifest_inventory" in verified.failures
    assert "inventory_missing:spaces/alpha/index.db" in verified.failures


@pytest.mark.asyncio
async def test_verify_rejects_unlisted_symlink(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    link = receipt.root / "spaces" / "alpha" / "notes" / "link.md"
    try:
        link.symlink_to("n_alpha-note-a.md")
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted in this environment")
    if not link.is_symlink():
        pytest.skip("symlink creation is not supported in this environment")

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert any(failure.startswith("symlink:") for failure in verified.failures)


@pytest.mark.asyncio
async def test_snapshot_rejects_symlinked_asset(tmp_path: Path, monkeypatch) -> None:
    """The asset scanner must reject any symlinked source, even when the host
    cannot actually create a symlink (Windows without Developer Mode)."""
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    original_is_symlink = Path.is_symlink

    def fake_is_symlink(self: Path) -> bool:
        if self.name == "n_alpha-note-a.md":
            return True
        return original_is_symlink(self)

    monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)

    with pytest.raises(Exception, match="invalid asset"):
        await coordinator.snapshot(tmp_path / "snapshots")


@pytest.mark.asyncio
async def test_verify_rejects_migration_head_drift(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    with closing(
        sqlite3.connect(receipt.root / "spaces" / "alpha" / "space.db")
    ) as connection:
        with connection:
            connection.execute(
                "UPDATE alembic_version_space SET version_num='space_010_task_space_focus_session'"
            )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "migration_space:alpha" in verified.failures


@pytest.mark.asyncio
async def test_verify_interface_mismatch_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    coordinator.recovery_view_factory = lambda _kind, path: Path(path)

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert any(
        failure in verified.failures
        for failure in ("snapshot_invalid", "effort_projection", "AttributeError")
    )


def test_snapshot_contracts_deep_frozen() -> None:
    from app.recovery.manifest import canonical_json_from_raw, parse_manifest

    raw = {
        "schema_version": 1,
        "created_at": "2026-07-14T00:00:00.000Z",
        "source_fence": 1,
        "catalog_hash": "a" * 64,
        "catalog_entry_count": 31,
        "catalog_entity_types": ["a"],
        "meta": {
            "schema_head": "meta_002_active_session_locator",
            "active_session_coordination": {
                "nested": {"deep": [1, 2]},
                "result": "clean_or_recoverable",
            },
            "effort_projection": {"result": "verified"},
        },
        "spaces": [],
        "files": [],
    }
    manifest = parse_manifest(canonical_json_from_raw(raw))
    coordination = manifest.meta.active_session_coordination
    with pytest.raises(TypeError):
        coordination["result"] = "mutated"
    with pytest.raises((TypeError, AttributeError)):
        coordination["nested"]["deep"].append(3)
    with pytest.raises(TypeError):
        manifest.meta.effort_projection["result"] = "mutated"


def test_parse_manifest_rejects_str_payload() -> None:
    from app.recovery.manifest import parse_manifest

    with pytest.raises(ValueError, match="must be bytes"):
        parse_manifest('{"schema_version":1}')


def test_parse_manifest_rejects_noncanonical_bytes() -> None:
    from app.recovery.manifest import parse_manifest

    raw = {
        "schema_version": 1,
        "created_at": "2026-07-14T00:00:00.000Z",
        "source_fence": 1,
        "catalog_hash": "a" * 64,
        "catalog_entry_count": 31,
        "catalog_entity_types": ["a"],
        "meta": {
            "schema_head": "meta_002_active_session_locator",
            "active_session_coordination": {"result": "clean_or_recoverable"},
            "effort_projection": {"result": "verified"},
        },
        "spaces": [],
        "files": [],
    }
    import json

    with pytest.raises(ValueError, match="not canonical"):
        parse_manifest(json.dumps(raw).encode())


@pytest.mark.parametrize(
    "relative_path,kind",
    (
        ("meta/meta.db", "note"),
        ("spaces/alpha/space.db", "meta_db"),
        ("spaces/alpha/index.db", "index_asset"),
        ("spaces/alpha/notes/x.md", "index_db"),
        ("spaces/alpha/index/x.bin", "note"),
    ),
)
def test_parse_manifest_rejects_path_kind_drift(relative_path: str, kind: str) -> None:
    from app.recovery.manifest import parse_manifest

    file_entry = (
        '{"relative_path":"'
        + relative_path
        + '","size":1,"sha256":"'
        + "a" * 64
        + '","kind":"'
        + kind
        + '"}'
    )
    with pytest.raises(ValueError, match="does not match"):
        parse_manifest(_manifest_with_file("[" + file_entry + "]"))


@pytest.mark.asyncio
async def test_verify_rejects_manifest_kind_drift(tmp_path: Path) -> None:
    import json

    from app.recovery.manifest import canonical_json_from_raw

    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    raw = json.loads(canonical_json(receipt.manifest).decode())
    for entry in raw["files"]:
        if entry["relative_path"] == "meta/meta.db":
            entry["kind"] = "note"
    _republish_manifest(receipt.root, canonical_json_from_raw(raw))

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "manifest_invalid" in verified.failures


@pytest.mark.parametrize(
    "payload_fragment,error",
    (
        ('"schema_version":2', ValueError),
        ('"schema_version":"1"', ValueError),
        ('"source_fence":"1"', ValueError),
        ('"source_fence":-1', ValueError),
        ('"catalog_entry_count":30', ValueError),
        ('"created_at":""', ValueError),
        ('"catalog_entity_types":[""]', ValueError),
        ('"catalog_entity_types":["a",1]', ValueError),
    ),
)
def test_parse_manifest_rejects_invalid_top_level(payload_fragment: str, error) -> None:
    from app.recovery.manifest import parse_manifest

    payload = _manifest_with(payload_fragment)
    with pytest.raises(error):
        parse_manifest(payload)


def test_parse_manifest_rejects_invalid_file_entries() -> None:
    from app.recovery.manifest import parse_manifest

    base = '{"relative_path":"spaces/a/space.db","size":1,"sha256":"' + "a" * 64 + '","kind":"space_db"}'
    for bad in (
        base.replace('"size":1', '"size":true'),
        base.replace('"size":1', '"size":-1'),
        base.replace('"kind":"space_db"', '"kind":"weird"'),
        base.replace('"relative_path":"spaces/a/space.db"', '"relative_path":"../escape"'),
        base.replace('"sha256":"' + "a" * 64 + '"', '"sha256":"xyz"'),
    ):
        with pytest.raises(ValueError):
            parse_manifest(_manifest_with_file("[" + bad + "]"))


def test_parse_manifest_rejects_duplicate_paths() -> None:
    from app.recovery.manifest import parse_manifest

    file_a = '{"relative_path":"spaces/a/space.db","size":1,"sha256":"' + "a" * 64 + '","kind":"space_db"}'
    payload = _manifest_with_file(f"[{file_a},{file_a}]")
    with pytest.raises(ValueError):
        parse_manifest(payload)


def _manifest_with(replacement: str) -> bytes:
    from app.recovery.manifest import canonical_json_from_raw

    raw = {
        "schema_version": 1,
        "created_at": "2026-07-14T00:00:00.000Z",
        "source_fence": 1,
        "catalog_hash": "a" * 64,
        "catalog_entry_count": 31,
        "catalog_entity_types": ["a"],
        "meta": {
            "schema_head": "meta_002_active_session_locator",
            "active_session_coordination": {"result": "clean_or_recoverable"},
            "effort_projection": {"result": "verified"},
        },
        "spaces": [],
        "files": [],
    }
    import json

    raw.update(json.loads("{" + replacement + "}"))
    return canonical_json_from_raw(raw)


def _manifest_with_file(files_json: str) -> bytes:
    raw = {
        "schema_version": 1,
        "created_at": "2026-07-14T00:00:00.000Z",
        "source_fence": 1,
        "catalog_hash": "a" * 64,
        "catalog_entry_count": 31,
        "catalog_entity_types": ["a"],
        "meta": {
            "schema_head": "meta_002_active_session_locator",
            "active_session_coordination": {"result": "clean_or_recoverable"},
            "effort_projection": {"result": "verified"},
        },
        "spaces": [],
        "files": [],
    }
    import json

    raw["files"] = json.loads(files_json)
    from app.recovery.manifest import canonical_json_from_raw

    return canonical_json_from_raw(raw)


@pytest.mark.asyncio
async def test_inspector_rejects_multiple_locator_authorities(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _rebuild_locator_unchecked(connection)
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_locator(connection, state="claiming", operation_id="op-2")
            _insert_operation(connection, operation_id="op-1", phase="completed")

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "multiple" in str(raised.value)


@pytest.mark.asyncio
async def test_inspector_rejects_missing_locator_column(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        connection.execute(
            "DROP INDEX IF EXISTS ix_active_session_locator_lease_expires_at"
        )
        connection.execute("ALTER TABLE active_session_locator DROP COLUMN lease_expires_at")
        connection.commit()

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "columns" in str(raised.value)


@pytest.mark.asyncio
async def test_inspector_rejects_missing_operations_column(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        connection.execute("ALTER TABLE active_session_operations DROP COLUMN intent_json")
        connection.commit()

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "columns" in str(raised.value)


@pytest.mark.parametrize(
    "locator_kwargs",
    (
        {"space_id": "", "operation_id": "op-1"},
        {"session_id": "", "operation_id": "op-1"},
        {"operation_id": "   "},
    ),
)
@pytest.mark.asyncio
async def test_inspector_rejects_empty_identity_fields(
    tmp_path: Path, locator_kwargs: dict[str, object]
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", **locator_kwargs)
            _insert_operation(connection, operation_id="op-1", phase="completed")

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.parametrize("epoch", (0, -1))
@pytest.mark.asyncio
async def test_inspector_rejects_invalid_ownership_epoch(tmp_path: Path, epoch: int) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _rebuild_locator_unchecked(connection)
            _insert_locator(connection, state="active", operation_id="op-1", epoch=epoch)
            _insert_operation(connection, operation_id="op-1", phase="completed")

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_inspector_rejects_noncanonical_locator_updated_at(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(
                connection, state="active", operation_id="op-1", updated_at="not-a-date"
            )
            _insert_operation(connection, operation_id="op-1", phase="completed")

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.parametrize(
    "phase,row_kind,intent_kind",
    (
        ("completed", "pause", "start"),
        ("claimed", "end", "start"),
    ),
)
@pytest.mark.asyncio
async def test_inspector_rejects_kind_phase_mismatch(
    tmp_path: Path, phase: str, row_kind: str, intent_kind: str
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    intent = _make_intent(operation_id="op-1", kind=intent_kind)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            connection.execute(
                "INSERT INTO active_session_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "op-1",
                    row_kind,
                    intent["payload_hash"],
                    json.dumps(intent, sort_keys=True),
                    phase,
                    None,
                    None,
                    "2026-07-14T00:00:00.000Z",
                    "2026-07-14T00:00:00.000Z",
                ),
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.parametrize(
    "intent_json",
    (
        "not-json",
        "[1, 2]",
        '"scalar"',
    ),
)
@pytest.mark.asyncio
async def test_inspector_rejects_malformed_intent_json(
    tmp_path: Path, intent_json: str
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            connection.execute(
                "INSERT INTO active_session_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "op-1",
                    "start",
                    "a" * 64,
                    intent_json,
                    "completed",
                    None,
                    None,
                    "2026-07-14T00:00:00.000Z",
                    "2026-07-14T00:00:00.000Z",
                ),
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_inspector_rejects_intent_missing_identity_key(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    intent = _make_intent(operation_id="op-1")
    del intent["space_id"]
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(connection, operation_id="op-1", phase="completed", intent=intent)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "intent" in str(raised.value)


@pytest.mark.asyncio
async def test_inspector_rejects_intent_field_type_error(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    intent = _make_intent(operation_id="op-1")
    intent["ownership_epoch"] = "not-an-int"
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(connection, operation_id="op-1", phase="completed", intent=intent)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_inspector_rejects_intent_extra_key_hash_drift(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    intent = _make_intent(operation_id="op-1")
    intent["extra_business_field"] = "unhashed"
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(connection, operation_id="op-1", phase="completed", intent=intent)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "hash" in str(raised.value)


@pytest.mark.asyncio
async def test_inspector_rejects_intent_hash_mismatch(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    intent = _make_intent(operation_id="op-1")
    intent["planned_seconds"] = 9999  # business value changed without re-hashing
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(connection, operation_id="op-1", phase="completed", intent=intent)

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "hash" in str(raised.value)


@pytest.mark.asyncio
async def test_inspector_rejects_invalid_payload_hash(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _rebuild_operations_unchecked(connection)
            _insert_locator(connection, state="active", operation_id="op-1")
            intent = _make_intent(operation_id="op-1")
            connection.execute(
                "INSERT INTO active_session_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "op-1",
                    "start",
                    "z" * 64,
                    json.dumps(intent, sort_keys=True),
                    "completed",
                    None,
                    None,
                    "2026-07-14T00:00:00.000Z",
                    "2026-07-14T00:00:00.000Z",
                ),
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_inspector_rejects_reversed_operation_timestamps(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(
                connection,
                operation_id="op-1",
                phase="completed",
                created_at="2026-07-15T00:00:00.000Z",
                updated_at="2026-07-14T00:00:00.000Z",
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_inspector_rejects_malformed_result_descriptor(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(
                connection,
                operation_id="op-1",
                phase="completed",
                result_descriptor_json="not-json",
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.parametrize(
    "related,expected_fragment",
    (
        ("op-missing", "missing"),
        ("op-1", "cycle"),
    ),
)
@pytest.mark.asyncio
async def test_inspector_rejects_unknown_child_and_self_reference(
    tmp_path: Path, related: str, expected_fragment: str
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(
                connection,
                operation_id="op-1",
                phase="completed",
                related_operation_id=related,
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert expected_fragment in str(raised.value)


@pytest.mark.parametrize(
    "child_kwargs,expected_fragment",
    (
        ({"space_id": "other-space"}, "space_id"),
        ({"session_id": "other-session"}, "session_id"),
    ),
)
@pytest.mark.asyncio
async def test_inspector_rejects_bad_parent_child_pair(
    tmp_path: Path, child_kwargs: dict[str, object], expected_fragment: str
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    child_intent = _make_intent(operation_id="op-child", **child_kwargs)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-1")
            _insert_operation(
                connection,
                operation_id="op-1",
                phase="completed",
                related_operation_id="op-child",
            )
            _insert_operation(
                connection,
                operation_id="op-child",
                phase="completed",
                intent=child_intent,
            )

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"


@pytest.mark.asyncio
async def test_inspector_rejects_relation_chain_beyond_depth(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-0")
            for index in range(9):
                _insert_operation(
                    connection,
                    operation_id=f"op-{index}",
                    phase="completed",
                    related_operation_id=f"op-{index + 1}",
                )
            _insert_operation(connection, operation_id="op-9", phase="completed")

    with pytest.raises(Exception) as raised:
        await _inspect_meta(active_root)

    assert raised.value.record.code == "snapshot_invalid"
    assert "relation" in str(raised.value)


# --------------------------------------------------------------------------- #
# Snapshot / verify integration for coordination damage
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_snapshot_rejects_damaged_coordination_without_publication(
    tmp_path: Path,
) -> None:
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="claiming", operation_id="op-broken")
            _insert_operation(
                connection,
                operation_id="op-broken",
                phase="claimed",
                intent=_make_intent(operation_id="op-broken", kind="start"),
            )
            connection.execute(
                "UPDATE active_session_operations SET intent_json=? WHERE operation_id=?",
                (json.dumps(_make_intent(operation_id="op-broken", kind="pause")), "op-broken"),
            )
    target = tmp_path / "snapshots"

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(target)

    assert raised.value.record.code == "active_session_recovery_required"
    assert not target.exists() or not list(target.glob("*"))


@pytest.mark.asyncio
async def test_verify_rejects_damaged_coordination_copy(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    with closing(sqlite3.connect(receipt.root / "meta" / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="active", operation_id="op-broken")
            _insert_operation(
                connection,
                operation_id="op-broken",
                phase="completed",
                intent=_make_intent(operation_id="op-broken", kind="start"),
            )
            connection.execute(
                "UPDATE active_session_operations SET intent_json=? WHERE operation_id=?",
                (json.dumps(_make_intent(operation_id="op-broken", kind="pause")), "op-broken"),
            )

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "snapshot_invalid" in verified.failures



@pytest.mark.asyncio
async def test_snapshot_fails_closed_without_space_child_authority(tmp_path: Path) -> None:
    """A structurally complete non-empty coordination cannot be proven
    recoverable without the missing TS2 Space child/Session authority."""
    coordinator, _leases, active_root, _engines = _coordinator(tmp_path)
    with closing(sqlite3.connect(active_root / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="claiming", operation_id="op-claim")
            _insert_operation(connection, operation_id="op-claim", phase="claimed")
    target = tmp_path / "snapshots"

    with pytest.raises(Exception) as raised:
        await coordinator.snapshot(target)

    assert raised.value.record.code == "active_session_recovery_required"
    assert not target.exists() or not list(target.glob("*"))


@pytest.mark.asyncio
async def test_verify_fails_closed_without_space_child_authority(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines = _coordinator(tmp_path)
    receipt = await coordinator.snapshot(tmp_path / "snapshots")
    with closing(sqlite3.connect(receipt.root / "meta" / "meta.db")) as connection:
        with connection:
            _insert_locator(connection, state="claiming", operation_id="op-claim")
            _insert_operation(connection, operation_id="op-claim", phase="claimed")

    verified = await coordinator.verify(receipt.root)

    assert not verified.valid
    assert "active_session_recovery_required" in verified.failures
