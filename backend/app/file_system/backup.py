"""Fail-closed boundary for the retired path-backed startup backup."""

from __future__ import annotations

LEGACY_BACKUP_UNSUPPORTED_CODE = "legacy_backup_unsupported"


class LegacyBackupConfigurationError(RuntimeError):
    """Raised when the retired startup backup is explicitly enabled."""

    code = LEGACY_BACKUP_UNSUPPORTED_CODE

    def __init__(self) -> None:
        super().__init__(
            "Legacy startup backup is unsupported; use the S5 snapshot/restore capability"
        )


def require_legacy_backup_disabled(*, enabled: bool) -> None:
    """Reject the legacy setting before any storage authority is opened."""
    if enabled:
        raise LegacyBackupConfigurationError
