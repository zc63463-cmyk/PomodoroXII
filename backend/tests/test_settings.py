"""Tests for app.settings — validation logic and path helpers."""

from __future__ import annotations

import pytest

from app.settings import Settings


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _make_settings(**env_overrides: str | None) -> Settings:
    """Create a Settings instance with temporary env overrides."""
    if env_overrides.get("environment") == "production":
        env_overrides.setdefault(
            "sync_cursor_secret",
            "test-sync-cursor-secret-0123456789abcdef",
        )
    old_values: dict[str, str | None] = {}
    for key, value in env_overrides.items():
        env_key = f"POMODOROXII_{key.upper()}"
        old_values[env_key] = __import__("os").environ.get(env_key)
        if value is None:
            __import__("os").environ.pop(env_key, None)
        else:
            __import__("os").environ[env_key] = value
    try:
        return Settings()
    finally:
        import os
        for env_key, old_value in old_values.items():
            if old_value is None:
                os.environ.pop(env_key, None)
            else:
                os.environ[env_key] = old_value


# --------------------------------------------------------------------------- #
# secret_key validation
# --------------------------------------------------------------------------- #
class TestSecretKeyValidation:
    def test_rejects_empty_in_production(self):
        """Empty secret_key should raise ValueError in production."""
        with pytest.raises(ValueError, match="non-empty"):
            _make_settings(secret_key="", environment="production")

    def test_rejects_whitespace_only_in_production(self):
        """Whitespace-only secret_key should raise ValueError in production."""
        with pytest.raises(ValueError, match="non-empty"):
            _make_settings(secret_key="   ", environment="production")

    def test_rejects_weak_in_production(self):
        """Known weak secret_key should raise ValueError in production."""
        with pytest.raises(ValueError, match="weak"):
            _make_settings(secret_key="change-me", environment="production")

    def test_allows_weak_in_development(self):
        """Weak secret_key should be allowed in development."""
        s = _make_settings(secret_key="change-me", environment="development")
        assert s.secret_key == "change-me"

    def test_allows_strong_in_production(self):
        """A strong secret_key should be accepted in production."""
        s = _make_settings(
            secret_key="a-very-secure-random-key-1234567890",
            environment="production",
        )
        assert s.secret_key == "a-very-secure-random-key-1234567890"

    @pytest.mark.parametrize("secret", ["x" * 31, "密" * 10])
    def test_rejects_production_secret_below_32_utf8_bytes(self, secret: str):
        with pytest.raises(ValueError, match="at least 32 UTF-8 bytes"):
            _make_settings(secret_key=secret, environment="production")

    @pytest.mark.parametrize("secret", ["x" * 32, "密" * 11])
    def test_accepts_production_secret_at_or_above_32_utf8_bytes(self, secret: str):
        assert _make_settings(
            secret_key=secret,
            environment="production",
        ).secret_key == secret

    def test_rejects_weak_cursor_secret_in_production(self):
        with pytest.raises(ValueError, match="SYNC_CURSOR_SECRET.*weak"):
            _make_settings(
                secret_key="a-very-secure-random-key-1234567890",
                sync_cursor_secret="change-me-sync-cursor-secret-change-me",
                environment="production",
            )

    def test_rejects_cursor_secret_reuse_in_production(self):
        with pytest.raises(ValueError, match="distinct"):
            _make_settings(
                secret_key="a-very-secure-random-key-1234567890",
                sync_cursor_secret="a-very-secure-random-key-1234567890",
                environment="production",
            )


# --------------------------------------------------------------------------- #
# cors_origins parsing
# --------------------------------------------------------------------------- #
class TestCorsOrigins:
    def test_parses_comma_separated(self):
        """Comma-separated env var should produce a list."""
        s = _make_settings(cors_origins="http://a.com,http://b.com, http://c.com")
        assert s.cors_origins == ["http://a.com", "http://b.com", "http://c.com"]

    def test_accepts_list_default(self):
        """Default cors_origins should be a list."""
        s = Settings()
        assert isinstance(s.cors_origins, list)
        assert len(s.cors_origins) >= 1


def test_backup_enabled_defaults_false():
    assert _make_settings(backup_enabled=None).backup_enabled is False


def test_data_root_drives_canonical_meta_and_spaces_layout(tmp_path):
    root = tmp_path / "runtime-data"
    configured = _make_settings(
        data_root=str(root),
        database_url=f"sqlite+aiosqlite:///{root / 'meta.db'}",
        spaces_data_dir=str(root / "spaces"),
    )
    assert configured.meta_db_path == root.resolve() / "meta.db"
    assert configured.canonical_spaces_root == root.resolve() / "spaces"
    assert configured.spaces_data_dir.resolve() == configured.canonical_spaces_root


def test_explicit_split_runtime_layout_is_rejected(tmp_path):
    root = tmp_path / "runtime-data"
    with pytest.raises(ValueError, match="data_root"):
        _make_settings(
            data_root=str(root),
            spaces_data_dir=str(tmp_path / "other-spaces"),
        )


# --------------------------------------------------------------------------- #
# Path helpers
# --------------------------------------------------------------------------- #
class TestPathHelpers:
    def test_space_db_path(self):
        """space_db_path should return spaces_data_dir / space_id / 'space.db'."""
        s = Settings()
        path = s.space_db_path("spc_123")
        assert path == s.spaces_data_dir / "spc_123" / "space.db"

    def test_space_notes_dir(self):
        """space_notes_dir should return spaces_data_dir / space_id / 'notes'."""
        s = Settings()
        path = s.space_notes_dir("spc_456")
        assert path == s.spaces_data_dir / "spc_456" / "notes"
