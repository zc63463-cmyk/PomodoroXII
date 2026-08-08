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
