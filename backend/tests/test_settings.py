"""Tests for app.settings — validation logic and path helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.settings import Settings


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _make_settings(**env_overrides: str | None) -> Settings:
    """Create a Settings instance with temporary env overrides."""
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
