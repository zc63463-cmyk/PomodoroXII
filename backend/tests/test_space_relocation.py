"""Offline, explicit data-root relocation coverage."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from tests.test_recovery import _coordinator, _dispose


@pytest.mark.asyncio
async def test_relocation_rewrites_only_staged_registry_and_preserves_source(
    tmp_path: Path,
) -> None:
    from app.recovery import DataRootRelocator

    coordinator, leases, source_root, engines = _coordinator(tmp_path)
    target_root = tmp_path / "relocated"
    try:
        result = await DataRootRelocator(coordinator).relocate(target_root)

        assert result.success is True
        assert result.source_root == source_root.absolute()
        assert result.target_root == target_root.absolute()
        assert result.process_owner_fence == 11
        assert result.global_fence == 7
        assert result.rollback_snapshot_root.is_dir()
        with sqlite3.connect(target_root / "meta.db") as connection:
            row = connection.execute("SELECT db_path, notes_dir FROM spaces WHERE id='alpha'").fetchone()
        assert row == (
            str(target_root / "spaces" / "alpha" / "space.db"),
            str(target_root / "spaces" / "alpha" / "notes"),
        )
        with sqlite3.connect(source_root / "meta.db") as connection:
            source_row = connection.execute("SELECT db_path, notes_dir FROM spaces WHERE id='alpha'").fetchone()
        assert source_row == (
            str(source_root / "spaces" / "alpha" / "space.db"),
            str(source_root / "spaces" / "alpha" / "notes"),
        )
        assert leases.order[:2] == ["acquire_process_owner", "acquire_global"]
    finally:
        await _dispose(engines)


@pytest.mark.asyncio
@pytest.mark.parametrize("target_name", ("existing", "active/inside"))
async def test_relocation_rejects_existing_or_source_contained_target_without_snapshot(
    tmp_path: Path, target_name: str
) -> None:
    from app.recovery import DataRootRelocator, DomainFailure

    coordinator, leases, _source_root, engines = _coordinator(tmp_path)
    target = tmp_path / target_name
    if target_name == "existing":
        target.mkdir()
    try:
        with pytest.raises(DomainFailure) as captured:
            await DataRootRelocator(coordinator).relocate(target)
        assert captured.value.record.code == "relocation_target_invalid"
        assert leases.calls == []
    finally:
        await _dispose(engines)


@pytest.mark.asyncio
async def test_relocation_stale_owner_refuses_before_snapshot(tmp_path: Path) -> None:
    from app.recovery import DataRootRelocator, DomainFailure

    coordinator, leases, _source_root, engines = _coordinator(tmp_path)
    leases.owner_timeout = True
    try:
        with pytest.raises(DomainFailure) as captured:
            await DataRootRelocator(coordinator).relocate(tmp_path / "relocated")
        assert captured.value.record.code == "lease_timeout"
        assert not (tmp_path / "relocated").exists()
        assert len(leases.calls) == 1
    finally:
        await _dispose(engines)


@pytest.mark.asyncio
async def test_relocation_reverses_target_publication_when_post_publish_verify_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.recovery import DataRootRelocator, DomainFailure
    from app.recovery.coordinator import RecoveryCoordinator

    coordinator, _leases, source_root, engines = _coordinator(tmp_path)
    target = tmp_path / "relocated"
    original = RecoveryCoordinator._inspect_staged_root_read_only

    async def fail_only_after_publish(self, root, manifest, *, target_active_root):
        if Path(root) == target:
            raise DomainFailure("relocation_verification_failed", "injected published verification failure")
        return await original(self, root, manifest, target_active_root=target_active_root)

    monkeypatch.setattr(RecoveryCoordinator, "_inspect_staged_root_read_only", fail_only_after_publish)
    try:
        with pytest.raises(DomainFailure) as captured:
            await DataRootRelocator(coordinator).relocate(target)
        assert captured.value.record.code == "relocation_verification_failed"
        assert source_root.is_dir()
        assert not target.exists()
    finally:
        await _dispose(engines)
