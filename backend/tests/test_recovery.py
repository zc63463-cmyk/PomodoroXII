from pathlib import Path

import pytest


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
