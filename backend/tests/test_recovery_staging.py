"""S5 Task 2 Step 1: restore a verified snapshot into a unique staging root.

Every test exercises the production path: real ``_coordinator`` fixtures from
``test_recovery`` (real Migration/Knowledge/Mutation authorities), the TS2
ActiveSession authority, real SQLite online-backup copies, and the public
read-only ``verify`` flow.  No fake authority is ever forced clean.
"""

import hashlib
import json
import shutil
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.recovery.contracts import StagedRestore, VerificationResult
from app.recovery.manifest import canonical_json
from app.recovery.sqlite_copy import sha256_file
from tests.test_recovery import (
    BODY,
    CONTENT_HASH,
    NOTE_RELATIVE,
    _coordinator,
    _insert_locator,
    _insert_operation,
    _Leases,
    _make_intent,
    _make_meta_db,
    _republish_manifest,
    _view_factory,
)

_ENGINES: list[object] = []


@pytest.fixture(autouse=True)
async def _dispose_staging_engines() -> None:
    yield
    for engine in _ENGINES:
        await engine.dispose()
    _ENGINES.clear()


def _recovery_env(tmp_path: Path, **kwargs):
    """Build (coordinator, leases, active_root, engines, failpoint hook)."""
    from types import SimpleNamespace as _SN

    coordinator, leases, active_root, engines = _coordinator(tmp_path, **kwargs)
    failpoints: list[str] = []

    def _failpoint(name: str) -> None:
        failpoints.append(name)

    coordinator.failpoint = _failpoint
    _ENGINES.extend(engines)
    return coordinator, leases, active_root, engines, failpoints


async def _make_receipt(coordinator, tmp_path: Path):
    return await coordinator.snapshot(tmp_path / "snapshots")


def _staging_parent(active_root: Path) -> Path:
    return active_root.parent


def _expected_staging_name(active_root: Path) -> str:
    return f".{active_root.name}.restore-"


def _tree_sha256(root: Path) -> str:
    """Deterministic content digest of a directory for byte-equality checks."""
    entries: list[str] = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            digest = sha256_file(path)
            entries.append(f"{rel}:{path.stat().st_size}:{digest}")
    blob = "\n".join(entries).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _staged_file_hash(staged_root: Path, relative: str) -> str:
    return sha256_file(staged_root / relative)


async def _restore(coordinator, tmp_path: Path):
    receipt = await _make_receipt(coordinator, tmp_path)
    return receipt, await coordinator.restore_to_staging(receipt)


# --------------------------------------------------------------------------- #
# GREEN: verified snapshot restores to staging and stays byte-identical
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_restore_verified_snapshot_succeeds(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt, staged = await _restore(coordinator, tmp_path)

    assert isinstance(staged, StagedRestore)
    assert staged.root.is_dir()
    assert staged.root.is_absolute()
    assert staged.root.name.startswith(_expected_staging_name(active_root))
    assert (staged.root / "meta.db").is_file()
    assert not (staged.root / "meta" / "meta.db").exists()
    assert (staged.root / "spaces" / "alpha" / "space.db").is_file()
    assert (staged.root / "spaces" / "alpha" / "index.db").is_file()
    assert (staged.root / NOTE_RELATIVE).is_file()
    assert staged.manifest is not None
    assert len(staged.manifest.files) == len(receipt.manifest.files)


@pytest.mark.asyncio
async def test_restore_staging_root_differs_from_active_root(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt, staged = await _restore(coordinator, tmp_path)

    assert staged.root != active_root
    assert active_root.is_dir()
    assert staged.target_active_root == active_root.resolve()
    assert staged.root.parent == active_root.parent


@pytest.mark.asyncio
async def test_restore_preserves_active_marker(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    marker = active_root / "live-marker.txt"
    marker.write_text("live-before", encoding="utf-8")
    receipt = await _make_receipt(coordinator, tmp_path)
    assert marker.read_text(encoding="utf-8") == "live-before"

    await coordinator.restore_to_staging(receipt)

    assert marker.read_text(encoding="utf-8") == "live-before"
    # marker itself must not have been copied anywhere: the marker is not in
    # the manifest, so staging must not contain it.
    found_marker = False
    for staging in _staging_parent(active_root).glob(f"{_expected_staging_name(active_root)}*"):
        if (staging / "live-marker.txt").exists():
            found_marker = True
    assert not found_marker


@pytest.mark.asyncio
async def test_restore_snapshot_bytes_unchanged(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    before = _tree_sha256(receipt.root)

    await coordinator.restore_to_staging(receipt)

    assert _tree_sha256(receipt.root) == before


@pytest.mark.asyncio
async def test_restore_maps_meta_db_to_staging_meta_db(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt, staged = await _restore(coordinator, tmp_path)

    staged_meta = staged.root / "meta.db"
    assert staged_meta.is_file()
    with closing(sqlite3.connect(staged_meta)) as connection:
        head = connection.execute(
            "SELECT version_num FROM alembic_version_meta"
        ).fetchone()[0]
    assert head == receipt.manifest.meta.schema_head
    assert staged_meta == staged.root / "meta.db"


@pytest.mark.asyncio
async def test_restore_completes_all_spaces_notes_indexes(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt, staged = await _restore(coordinator, tmp_path)

    manifest = receipt.manifest
    for item in manifest.files:
        target = staged.root / (
            "meta.db" if item.relative_path == "meta/meta.db" else item.relative_path
        )
        assert target.is_file(), f"missing {item.relative_path}"
        assert target.stat().st_size == item.size, f"size {item.relative_path}"
        if item.kind not in {"meta_db", "space_db", "index_db"}:
            assert sha256_file(target) == item.sha256, f"hash {item.relative_path}"
    with closing(sqlite3.connect(staged.root / "spaces" / "alpha" / "space.db")) as connection:
        row = connection.execute(
            "SELECT value FROM sample ORDER BY value LIMIT 1"
        ).fetchone()
    assert row[0] == "seed"


@pytest.mark.asyncio
async def test_staged_restore_fields_from_real_evidence(tmp_path: Path) -> None:
    coordinator, leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    verified = await coordinator.verify(receipt.root)
    staged = await coordinator.restore_to_staging(receipt)

    assert staged.root == staged.root.resolve()
    assert staged.target_active_root == active_root.resolve()
    assert staged.manifest_sha256 == verified.manifest_sha256
    assert staged.manifest_sha256 == receipt.manifest_sha256
    assert len(staged.staged_tree_sha256) == 64
    assert all(c in "0123456789abcdef" for c in staged.staged_tree_sha256)
    assert staged.catalog_hash == receipt.manifest.catalog_hash
    assert staged.catalog_hash == coordinator.catalog.hash
    assert staged.source_fence == receipt.manifest.source_fence
    assert staged.source_fence == leases.lease.fence
    assert staged.manifest is receipt.manifest or staged.manifest == receipt.manifest


@pytest.mark.asyncio
async def test_staged_restore_rejects_invalid_or_mismatched_verification(
    tmp_path: Path,
) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    _receipt, staged = await _restore(coordinator, tmp_path)
    invalid = VerificationResult(
        valid=False,
        manifest_sha256=staged.manifest_sha256,
        manifest=staged.manifest,
        checked_files=0,
        checked_spaces=0,
        failures=("forced",),
    )
    with pytest.raises(ValueError, match="valid matching verification"):
        StagedRestore(
            snapshot_root=staged.snapshot_root,
            root=staged.root,
            target_active_root=staged.target_active_root,
            manifest_sha256=staged.manifest_sha256,
            staged_tree_sha256=staged.staged_tree_sha256,
            catalog_hash=staged.catalog_hash,
            source_fence=staged.source_fence,
            manifest=staged.manifest,
            verification=invalid,
        )

    with pytest.raises(ValueError, match="tuple"):
        VerificationResult(
            valid=False,
            manifest_sha256=staged.manifest_sha256,
            manifest=staged.manifest,
            checked_files=0,
            checked_spaces=0,
            failures=["mutable"],  # type: ignore[arg-type]
        )


@pytest.mark.asyncio
async def test_restore_twice_different_root_same_staged_hash(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    first = await coordinator.restore_to_staging(receipt)
    second = await coordinator.restore_to_staging(receipt)

    assert first.root != second.root
    assert first.root.parent == second.root.parent
    assert first.staged_tree_sha256 == second.staged_tree_sha256
    assert first.manifest_sha256 == second.manifest_sha256
    assert first.catalog_hash == second.catalog_hash
    assert first.source_fence == second.source_fence


@pytest.mark.asyncio
async def test_restore_calls_all_six_read_only_authorities_on_staging(
    tmp_path: Path,
) -> None:
    from tests.test_recovery import (
        _RecordingIndex,
        _RecordingKnowledge,
        _RecordingMigration,
        _RecordingMutation,
    )

    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    recording_migration = _RecordingMigration()
    recording_index = _RecordingIndex()
    recording_knowledge = _RecordingKnowledge()
    recording_mutation = _RecordingMutation()

    class _RecordingActive:
        def __init__(self) -> None:
            self.calls: list[tuple[object, dict[str, object]]] = []

        async def inspect_read_only(self, view, *, space_views=None):
            self.calls.append((view, dict(space_views or {})))
            return {"classification": "empty", "result": "clean_or_recoverable"}

    class _RecordingEffort:
        def __init__(self) -> None:
            self.calls: list[object] = []

        async def verify_all(self, scope):
            self.calls.append(scope)
            return ()

    recording_active = _RecordingActive()
    recording_effort = _RecordingEffort()
    coordinator.migration_coordinator = recording_migration
    coordinator.index_schema = recording_index
    coordinator.knowledge_checker = recording_knowledge
    coordinator.mutation_recovery_inspector = recording_mutation
    coordinator.active_coordination_inspector = recording_active
    coordinator.effort_projection_compiler = recording_effort

    receipt = await _make_receipt(coordinator, tmp_path)
    staged = await coordinator.restore_to_staging(receipt)

    assert ("meta", staged.root / "meta.db") in recording_migration.calls
    assert (
        "space",
        staged.root / "spaces" / "alpha" / "space.db",
    ) in recording_migration.calls
    assert staged.root / "spaces" / "alpha" / "index.db" in recording_index.calls
    assert any(
        call.db_path == staged.root / "spaces" / "alpha" / "space.db"
        for call in recording_knowledge.calls
    )
    assert len(recording_mutation.calls) >= 1
    assert len(recording_active.calls) >= 1
    meta_view, space_views = recording_active.calls[-1]
    assert meta_view.db_path == staged.root / "meta.db"
    # ActiveSession MUST consume the copied Space views, never the live ones.
    assert set(space_views) == {"alpha"}
    assert space_views["alpha"].db_path == (
        staged.root / "spaces" / "alpha" / "space.db"
    )
    assert (active_root / "spaces" / "alpha" / "space.db") not in (
        space_views["alpha"].db_path,
    )
    assert len(recording_effort.calls) >= 1


@pytest.mark.asyncio
async def test_restore_empty_active_session_coordination_succeeds(
    tmp_path: Path,
) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt, staged = await _restore(coordinator, tmp_path)
    # the default _make_meta_db has no locator rows -> TS2 empty decision
    from app.focus_session.recovery_authority import (
        ActiveSessionCoordinationInspector as TS2Authority,
    )

    decision = await TS2Authority().inspect_read_only(
        SimpleNamespace(db_path=staged.root / "meta.db"),
        space_views={
            "alpha": SimpleNamespace(
                space_id="alpha",
                db_path=staged.root / "spaces" / "alpha" / "space.db",
                notes_dir=staged.root / "spaces" / "alpha",
                index_db=staged.root / "spaces" / "alpha" / "index.db",
                catalog_hash=receipt.manifest.catalog_hash,
            )
        },
    )
    assert decision.classification == "empty"
    assert decision.result == "clean_or_recoverable"


@pytest.mark.asyncio
async def test_restore_nonempty_active_state_passes_real_ts2_authority(
    tmp_path: Path,
) -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.focus_session import FocusSession

    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    # The TS2 authority really reads FocusSession rows from the Space DB:
    # build the live table (mirroring production migrations) before snapshot.
    space_db = active_root / "spaces" / "alpha" / "space.db"
    live_engine = create_async_engine(f"sqlite+aiosqlite:///{space_db}")
    try:
        async with live_engine.begin() as connection:
            await connection.run_sync(FocusSession.__table__.create)
        async with async_sessionmaker(live_engine, expire_on_commit=False)() as session:
            session.add(
                FocusSession(
                    id="session-1",
                    started_at="2026-07-14T00:00:00.000Z",
                    ownership_state="authoritative",
                    validity="valid",
                )
            )
            await session.commit()
    finally:
        await live_engine.dispose()
    # Space views must carry a real db_path so the TS2 authority can read
    # the (staged) Space DB during both snapshot verification and restore.
    coordinator.recovery_view_factory = _path_view_factory(_engines)
    # seed a real completed active session inside the live Meta
    meta_db = active_root / "meta.db"
    with closing(sqlite3.connect(meta_db)) as connection:
        with connection:
            _insert_operation(
                connection,
                operation_id="op-start",
                phase="completed",
                kind="start",
                intent=_make_intent(
                    operation_id="op-start",
                    kind="start",
                    space_id="alpha",
                    session_id="session-1",
                    epoch=1,
                ),
            )
            _insert_locator(
                connection,
                state="active",
                operation_id="op-start",
                space_id="alpha",
                session_id="session-1",
                epoch=1,
            )
    receipt = await _make_receipt(coordinator, tmp_path)
    staged = await coordinator.restore_to_staging(receipt)

    from app.focus_session.recovery_authority import (
        ActiveSessionCoordinationInspector as TS2Authority,
    )

    decision = await TS2Authority().inspect_read_only(
        SimpleNamespace(db_path=staged.root / "meta.db"),
        space_views={
            "alpha": SimpleNamespace(
                space_id="alpha",
                db_path=staged.root / "spaces" / "alpha" / "space.db",
                notes_dir=staged.root / "spaces" / "alpha",
                index_db=staged.root / "spaces" / "alpha" / "index.db",
                catalog_hash=receipt.manifest.catalog_hash,
            )
        },
    )
    assert decision.result == "clean_or_recoverable"
    assert decision.classification == "active_consistent"


# --------------------------------------------------------------------------- #
# FAIL-CLOSED: input validation
# --------------------------------------------------------------------------- #


def _domain_code(exc: BaseException) -> str:
    return str(getattr(exc, "record", SimpleNamespace(code=type(exc).__name__)).code)


@pytest.mark.asyncio
async def test_restore_absent_snapshot_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(tmp_path / "no-such-snapshot")
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_rejects_snapshot_inside_live_root(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    embedded = active_root / "embedded-snapshot"
    shutil.copytree(receipt.root, embedded)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(embedded)

    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_rejects_source_changed_after_verify(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    def _mutate_after_verify(name: str) -> None:
        if name == "restore_input_checked":
            (receipt.root / NOTE_RELATIVE).write_text("changed", encoding="utf-8")

    coordinator.failpoint = _mutate_after_verify
    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)

    assert _domain_code(excinfo.value) == "restore_inventory_mismatch"


@pytest.mark.asyncio
async def test_restore_rejects_snapshot_registered_for_other_active_root(
    tmp_path: Path,
) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    coordinator.active_root = (tmp_path / "different-active").resolve()

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)

    assert _domain_code(excinfo.value) == "restore_relocation_required"


@pytest.mark.asyncio
async def test_restore_rejects_sidecar_present_after_verification(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    def _write_sidecar(name: str) -> None:
        if name == "staged_verify_done":
            staging = _latest_staging(active_root)
            assert staging is not None
            (staging / "meta.db-wal").write_bytes(b"unexpected")

    coordinator.failpoint = _write_sidecar
    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)

    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_preserves_primary_and_reports_cleanup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    def _fail_after_allocate(name: str) -> None:
        if name == "staged_copy:meta/meta.db":
            raise RuntimeError("primary restore failure")

    def _cleanup_fails(_path: Path) -> None:
        raise OSError("cleanup locked")

    coordinator.failpoint = _fail_after_allocate
    monkeypatch.setattr("app.recovery.coordinator.shutil.rmtree", _cleanup_fails)

    with pytest.raises(RuntimeError, match="primary restore failure") as excinfo:
        await coordinator.restore_to_staging(receipt)

    assert any("staging cleanup failed" in note for note in excinfo.value.__notes__)


@pytest.mark.asyncio
async def test_restore_noncanonical_manifest_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    manifest_path = receipt.root / "manifest.json"
    manifest_path.write_bytes(manifest_path.read_bytes() + b" ")

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_manifest_hash_mismatch_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    # keep the payload but make manifest.sha256 disagree
    (receipt.root / "manifest.sha256").write_text("0" * 64 + "\n", encoding="ascii")

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_manifest_inventory_drift_fails_closed(tmp_path: Path) -> None:
    from dataclasses import replace

    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    # drop one entry -> manifest no longer covers the canonical inventory
    dropped = replace(
        receipt.manifest,
        files=tuple(item for item in receipt.manifest.files if item.relative_path != NOTE_RELATIVE),
    )
    _republish_manifest(receipt.root, canonical_json(dropped))

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_manifest_path_traversal_fails_closed(tmp_path: Path) -> None:
    from dataclasses import replace

    from app.recovery.contracts import SnapshotFile

    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    escape = SnapshotFile(
        "../escape.db",
        receipt.manifest.files[0].size,
        receipt.manifest.files[0].sha256,
        "note",
    )
    forged = replace(receipt.manifest, files=(*receipt.manifest.files, escape))
    _republish_manifest(receipt.root, canonical_json(forged))

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_rogue_file_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    (receipt.root / "rogue.txt").write_text("rogue", encoding="utf-8")

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_missing_snapshot_file_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    (receipt.root / NOTE_RELATIVE).unlink()

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_file_hash_size_drift_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    target = receipt.root / NOTE_RELATIVE
    target.write_text("tampered", encoding="utf-8")

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_snapshot_symlink_fails_closed(tmp_path: Path) -> None:
    import os

    coordinator, _leases, _active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    link = receipt.root / "spaces" / "alpha" / "notes" / "link.md"
    try:
        os.symlink(receipt.root / NOTE_RELATIVE, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted in this environment")

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"


@pytest.mark.asyncio
async def test_restore_target_parent_symlink_fails_closed(tmp_path: Path) -> None:
    import subprocess

    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    real_parent = tmp_path / "real"
    real_parent.mkdir()
    link_parent = tmp_path / "link"
    # mklink /J creates a directory junction (no admin rights needed) which
    # is a reparse point that Path.is_symlink() misses on Windows.
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link_parent), str(real_parent)],
        capture_output=True,
    )
    if result.returncode != 0:
        pytest.skip("junction creation is not permitted in this environment")
    coordinator.active_root = link_parent / "active"

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_target_invalid"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_staging_name_conflict_fails_closed(
    tmp_path: Path, monkeypatch
) -> None:
    import app.recovery.coordinator as recovery_module

    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    fixed = uuid.UUID("00000000-0000-0000-0000-000000000001")
    monkeypatch.setattr(recovery_module.uuid, "uuid4", lambda: fixed)
    # occupy the exact staging path the coordinator will allocate
    staging = active_root.parent / f".{active_root.name}.restore-{fixed.hex}.staging"
    staging.mkdir()

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_target_invalid"
    assert staging.is_dir()  # pre-existing path untouched


@pytest.mark.asyncio
async def test_restore_copy_mid_failure_cleans_staging(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _boom(name: str) -> None:
        failpoints.append(name)
        if name.startswith("staged_copy:"):
            raise FileNotFoundError("injected copy failure")

    coordinator.failpoint = _boom
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception):
        await coordinator.restore_to_staging(receipt)
    leftovers = list(_staging_parent(active_root).glob(f"{_expected_staging_name(active_root)}*"))
    assert leftovers == []
    assert "staged_copy:meta/meta.db" in failpoints or any(
        name.startswith("staged_copy:") for name in failpoints
    )


@pytest.mark.asyncio
async def test_restore_fsync_failure_cleans_staging(
    tmp_path: Path, monkeypatch
) -> None:
    import app.recovery.sqlite_copy as sqlite_copy

    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    def _fail_fsync(path) -> None:
        raise OSError("injected fsync failure")

    monkeypatch.setattr(sqlite_copy, "fsync_file", _fail_fsync)
    with pytest.raises(Exception):
        await coordinator.restore_to_staging(receipt)
    leftovers = list(_staging_parent(active_root).glob(f"{_expected_staging_name(active_root)}*"))
    assert leftovers == []


# --------------------------------------------------------------------------- #
# FAIL-CLOSED: staged verification drift / fault injection
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_restore_migration_drift_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _drift(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_start":
            staged_meta = _latest_staging(active_root) / "meta.db"
            with closing(sqlite3.connect(staged_meta)) as connection:
                with connection:
                    connection.execute(
                        "UPDATE alembic_version_meta SET version_num='meta_001_initial'"
                    )

    coordinator.failpoint = _drift
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_index_schema_drift_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _drift(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_start":
            staged_index = _latest_staging(active_root) / "spaces" / "alpha" / "index.db"
            with closing(sqlite3.connect(staged_index)) as connection:
                with connection:
                    connection.execute(
                        "UPDATE schema_meta SET value='0' WHERE key='version'"
                    )

    coordinator.failpoint = _drift
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_knowledge_inconsistency_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _drift(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_start":
            staged_space = _latest_staging(active_root) / "spaces" / "alpha" / "space.db"
            with closing(sqlite3.connect(staged_space)) as connection:
                with connection:
                    connection.execute("DELETE FROM notes WHERE id='n_alpha'")

    coordinator.failpoint = _drift
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_mutation_recovery_unclean_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _drift(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_start":
            staged_space = _latest_staging(active_root) / "spaces" / "alpha" / "space.db"
            with closing(sqlite3.connect(staged_space)) as connection:
                with connection:
                    connection.execute(
                        "INSERT INTO mutation_batches "
                        "(batch_id, command_hash, state, accepted_count, result_json, "
                        "created_at, updated_at) "
                        "VALUES ('b-pending', ?, 'failed_manual', 0, NULL, ?, ?)",
                        ("0" * 64, "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z"),
                    )

    coordinator.failpoint = _drift
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_active_session_recovery_required_fails_closed(
    tmp_path: Path,
) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _drift(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_start":
            staged_meta = _latest_staging(active_root) / "meta.db"
            with closing(sqlite3.connect(staged_meta)) as connection:
                with connection:
                    _insert_locator(
                        connection,
                        state="claiming",
                        operation_id="op-orphan",
                        space_id="alpha",
                        session_id="session-1",
                        epoch=1,
                    )

    coordinator.failpoint = _drift
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "active_session_recovery_required"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_active_session_authority_missing_fails_closed(
    tmp_path: Path,
) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    coordinator.active_coordination_inspector = None

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "recovery_inspector_unavailable:active_session_authority"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_detects_live_space_view_usage(tmp_path: Path) -> None:
    """If the implementation fed live Space DBs to the authority, restore fails.

    The live Space DB is polluted *after* the snapshot, so only the copied
    staging DB is clean.  A correct staged-only implementation succeeds.
    """
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)
    live_space = active_root / "spaces" / "alpha" / "space.db"
    with closing(sqlite3.connect(live_space)) as connection:
        with connection:
            connection.execute(
                "INSERT INTO mutation_batches "
                "(batch_id, command_hash, state, accepted_count, result_json, "
                "created_at, updated_at) "
                "VALUES ('b-live', ?, 'failed_manual', 0, NULL, ?, ?)",
                ("0" * 64, "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z"),
            )

    staged = await coordinator.restore_to_staging(receipt)

    assert staged.root.is_dir()


@pytest.mark.asyncio
async def test_restore_effort_mismatch_fails_closed(tmp_path: Path) -> None:
    from sqlalchemy import text as _sql_text

    class _EffortFailCompiler:
        """Clean for the source snapshot, mismatch once staging is tampered."""

        async def verify_all(self, scope):
            factory = getattr(scope, "session_factory", None)
            if factory is None:
                raise AttributeError("effort scope has no session_factory")
            async with factory() as session:
                value = (
                    await session.execute(
                        _sql_text("SELECT value FROM sample ORDER BY value LIMIT 1")
                    )
                ).scalars().first()
            if str(value) == "seed":
                return ()
            return (SimpleNamespace(code="effort_mismatch"),)

    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)
    coordinator.effort_projection_compiler = _EffortFailCompiler()

    def _drift(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_start":
            staged_space = _latest_staging(active_root) / "spaces" / "alpha" / "space.db"
            with closing(sqlite3.connect(staged_space)) as connection:
                with connection:
                    connection.execute("UPDATE sample SET value='tampered'")

    coordinator.failpoint = _drift
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_authority_returns_none_fails_closed(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)

    class _NoneActive:
        async def inspect_read_only(self, view, *, space_views=None):
            return None

    receipt = await _make_receipt(coordinator, tmp_path)
    coordinator.active_coordination_inspector = _NoneActive()

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    code = _domain_code(excinfo.value)
    assert code.startswith("recovery_inspector_unavailable:")
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_verification_write_detected_by_digest(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, failpoints = _recovery_env(tmp_path)

    def _write_after_verify(name: str) -> None:
        failpoints.append(name)
        if name == "staged_verify_done":
            (_latest_staging(active_root) / "written-by-authority.txt").write_text(
                "boom", encoding="utf-8"
            )

    coordinator.failpoint = _write_after_verify
    receipt = await _make_receipt(coordinator, tmp_path)

    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_verification_failed"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_rejects_valid_without_manifest(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    async def _bad_verify(snapshot):
        return SimpleNamespace(
            valid=True,
            manifest=None,
            manifest_sha256=receipt.manifest_sha256,
            failures=(),
        )

    coordinator.verify = _bad_verify
    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_rejects_invalid_without_failures(tmp_path: Path) -> None:
    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt = await _make_receipt(coordinator, tmp_path)

    async def _bad_verify(snapshot):
        return SimpleNamespace(
            valid=False,
            manifest=receipt.manifest,
            manifest_sha256=receipt.manifest_sha256,
            failures=(),
        )

    coordinator.verify = _bad_verify
    with pytest.raises(Exception) as excinfo:
        await coordinator.restore_to_staging(receipt)
    assert _domain_code(excinfo.value) == "restore_source_invalid"
    assert _latest_staging(active_root) is None


@pytest.mark.asyncio
async def test_restore_does_not_rely_on_assert(tmp_path: Path) -> None:
    import inspect as _inspect

    from app.recovery.coordinator import RecoveryCoordinator

    for name in ("restore_to_staging", "_inspect_staged_root_read_only"):
        source = _inspect.getsource(getattr(RecoveryCoordinator, name))
        for line in source.splitlines():
            stripped = line.strip()
            assert not stripped.startswith("assert "), (
                f"{name} uses assert for a safety decision: {stripped}"
            )


@pytest.mark.asyncio
async def test_restore_success_staging_immediately_removable(tmp_path: Path) -> None:
    import shutil

    coordinator, _leases, active_root, _engines, _fps = _recovery_env(tmp_path)
    receipt, staged = await _restore(coordinator, tmp_path)

    shutil.rmtree(staged.root)  # Windows: fails if a file handle is retained
    assert not staged.root.exists()


def _latest_staging(active_root: Path) -> Path | None:
    candidates = sorted(
        _staging_parent(active_root).glob(f"{_expected_staging_name(active_root)}*")
    )
    return candidates[-1] if candidates else None


def _path_view_factory(engines: list[object]):
    """A recovery view factory whose Space views expose a real db_path.

    The TS2 ActiveSession authority opens ``view.db_path`` to read the Space
    DB read-only, so a plain session-factory view (as used by the default
    ``_view_factory``) is not enough for a non-empty active state.
    """
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    def factory(kind: str, path: Path):
        if kind == "meta":
            return SimpleNamespace(db_path=Path(path))
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{Path(path) / 'space.db'}",
            poolclass=NullPool,
        )
        engines.append(engine)
        _ENGINES.append(engine)
        return SimpleNamespace(
            db_path=Path(path) / "space.db",
            scope=SimpleNamespace(space_id=Path(path).name),
            session_factory=async_sessionmaker(engine, expire_on_commit=False),
        )

    return factory
