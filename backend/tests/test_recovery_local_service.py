"""Windows-local recovery service composition tests."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from tests.test_recovery import _coordinator


async def _add_effort_projection_tables(space_db: Path) -> None:
    """Add the production tables queried by the real read-only verifier.

    The general recovery fixture intentionally keeps its SQLite schema small.
    This local-service integration test needs the complete table set used by
    ``EffortProjectionCompiler.verify_all`` even though it has no rows.
    """
    from app.db.base import Base
    from app.models.focus_session import FocusSession
    from app.models.session_revision import SessionAttributionRevision
    from app.models.work_item import WorkItem

    engine = create_async_engine(f"sqlite+aiosqlite:///{space_db.as_posix()}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                lambda sync: Base.metadata.create_all(
                    sync,
                    tables=(
                        WorkItem.__table__,
                        FocusSession.__table__,
                        SessionAttributionRevision.__table__,
                    ),
                )
            )
    finally:
        await engine.dispose()


def _operator_module():
    path = Path(__file__).parents[1] / "scripts" / "rehearse_recovery.py"
    spec = importlib.util.spec_from_file_location("rehearse_recovery_for_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
async def test_local_recovery_service_snapshots_and_verifies_disposable_root(
    tmp_path: Path,
) -> None:
    """The offline factory uses real authorities and closes its read-only views."""
    from app.recovery.local_service import LocalRecoveryService

    _test_coordinator, _test_leases, active_root, engines = _coordinator(tmp_path)
    await _add_effort_projection_tables(active_root / "spaces" / "alpha" / "space.db")
    service = LocalRecoveryService(active_root)
    try:
        snapshot = await service.coordinator.snapshot(tmp_path / "snapshots")
        verification = await service.coordinator.verify(snapshot)
        assert verification.valid is True
    finally:
        await service.aclose()
        for engine in engines:
            await engine.dispose()


@pytest.mark.parametrize(
    ("confirmation", "cutover_flag", "expected"),
    (
        ("other-root", False, "exactly match"),
        ("same-root", False, "requires --confirm-cutover"),
    ),
)
def test_rehearsal_cli_rejects_missing_confirmation_before_constructing_service(
    confirmation: str,
    cutover_flag: bool,
    expected: str,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    operator = _operator_module()
    constructed = False

    class UnexpectedService:
        def __init__(self, _root: Path) -> None:
            nonlocal constructed
            constructed = True

    monkeypatch.setattr(operator, "LocalRecoveryService", UnexpectedService)

    data_root = tmp_path / "disposable"
    args = [
        "rehearse",
        "--data-root",
        str(data_root),
        "--snapshot-dir",
        str(tmp_path / "snapshots"),
        "--confirm-disposable-root",
        str(data_root if confirmation == "same-root" else tmp_path / confirmation),
    ]
    if cutover_flag:
        args.append("--confirm-cutover")
    result = operator.main(args)

    assert result == 2
    assert constructed is False
    assert expected in capsys.readouterr().err


def test_rehearsal_cli_emits_receipt_after_explicit_confirmations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    operator = _operator_module()
    data_root = tmp_path / "disposable"
    snapshot_root = tmp_path / "snapshots" / "published"
    staging_root = tmp_path / ".disposable.staging"
    rollback_root = tmp_path / ".disposable.rollback"
    rollback_snapshot_root = tmp_path / "snapshots" / "rollback"
    for directory in (data_root, snapshot_root, staging_root, rollback_root, rollback_snapshot_root):
        directory.mkdir(parents=True)

    class Coordinator:
        async def snapshot(self, _target: Path):
            return SimpleNamespace(root=snapshot_root)

        async def restore_to_staging(self, _snapshot):
            return SimpleNamespace(root=staging_root)

        async def cutover(self, _staged):
            return SimpleNamespace(
                rollback_root=rollback_root,
                rollback_snapshot_root=rollback_snapshot_root,
                active_root=data_root,
                source_manifest_sha256="a" * 64,
                rollback_manifest_sha256="b" * 64,
            )

    class Service:
        def __init__(self, root: Path) -> None:
            assert root == data_root.absolute()
            self.coordinator = Coordinator()
            self.closed = False

        async def aclose(self) -> None:
            self.closed = True

    monkeypatch.setattr(operator, "LocalRecoveryService", Service)
    result = operator.main(
        [
            "rehearse",
            "--data-root",
            str(data_root),
            "--snapshot-dir",
            str(tmp_path / "snapshots"),
            "--confirm-disposable-root",
            str(data_root),
            "--confirm-cutover",
        ]
    )

    assert result == 0
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["status"] == "cutover_complete"
    assert receipt["rollback_root"] == str(rollback_root)


def test_relocation_cli_requires_both_root_confirmations_before_service_construction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    operator = _operator_module()
    constructed = False

    class UnexpectedService:
        def __init__(self, _root: Path) -> None:
            nonlocal constructed
            constructed = True

    monkeypatch.setattr(operator, "LocalRecoveryService", UnexpectedService)
    source = tmp_path / "disposable-source"
    target = tmp_path / "disposable-target"
    result = operator.main(
        [
            "relocate",
            "--data-root", str(source),
            "--target-root", str(target),
            "--confirm-disposable-root", str(source),
            "--confirm-relocation-target", str(tmp_path / "other-target"),
            "--confirm-relocate",
        ]
    )

    assert result == 2
    assert constructed is False
    assert "--confirm-relocation-target" in capsys.readouterr().err


def test_relocation_cli_emits_target_and_rollback_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    operator = _operator_module()
    source = tmp_path / "disposable-source"
    target = tmp_path / "disposable-target"
    rollback_snapshot = tmp_path / "snapshots" / "rollback"
    for directory in (source, target, rollback_snapshot):
        directory.mkdir(parents=True)

    class Service:
        def __init__(self, root: Path) -> None:
            assert root == source.absolute()

        async def relocate(self, target_root: Path):
            assert target_root == target.absolute()
            return SimpleNamespace(
                source_root=source,
                target_root=target,
                rollback_snapshot_root=rollback_snapshot,
                rollback_manifest_sha256="a" * 64,
                staged_tree_sha256="b" * 64,
            )

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(operator, "LocalRecoveryService", Service)
    result = operator.main(
        [
            "relocate",
            "--data-root", str(source),
            "--target-root", str(target),
            "--confirm-disposable-root", str(source),
            "--confirm-relocation-target", str(target),
            "--confirm-relocate",
        ]
    )

    assert result == 0
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["status"] == "relocation_complete"
    assert receipt["target_root"] == str(target)
