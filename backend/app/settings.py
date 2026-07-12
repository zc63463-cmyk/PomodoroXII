"""Application settings via pydantic-settings.

PomodoroXII uses a multi-space architecture:
- A single *meta* database holds space registry and global settings.
- Each space has its own SQLite database (under ``spaces_data_dir``) and
  its own notes directory on the filesystem.

The ``Settings`` class centralises configuration for both layers and
exposes helper methods to compute per-space paths deterministically.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from pydantic import PositiveInt, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Central configuration loaded from environment / .env file."""

    # --- Auth / JWT -------------------------------------------------------
    secret_key: str = "change-me"
    algorithm: str = "HS256"
    master_token_expire_days: PositiveInt = 7
    space_token_expire_hours: PositiveInt = 8

    # --- Meta database ----------------------------------------------------
    database_url: str = "sqlite+aiosqlite:///./data/meta.db"

    # --- Spaces layout ----------------------------------------------------
    spaces_data_dir: Path = Path("./data/spaces")
    engine_pool_max_size: PositiveInt = 5

    # --- HTTP / runtime ---------------------------------------------------
    cors_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:5173",
        "http://localhost:4173",
    ]
    trusted_proxy_cidrs: Annotated[list[str], NoDecode] = []
    request_body_max_bytes: PositiveInt = 10 * 1024 * 1024
    sync_event_payload_max_bytes: PositiveInt = 256 * 1024
    debug: bool = False
    environment: str = "development"
    backup_enabled: bool = True

    model_config = SettingsConfigDict(
        env_prefix="POMODOROXII_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ------------------------------------------------------------------ #
    # Validators
    # ------------------------------------------------------------------ #
    @field_validator("cors_origins", "trusted_proxy_cidrs", mode="before")
    @classmethod
    def parse_comma_separated_list(cls, v):
        """Accept comma-separated environment values or list literals."""
        if isinstance(v, list):
            return v
        if isinstance(v, str):
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @field_validator("secret_key")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        """Reject empty / default secret_key in production."""
        if not v or not v.strip():
            raise ValueError(
                "POMODOROXII_SECRET_KEY must be set to a non-empty value. "
                "Generate a strong key with: openssl rand -hex 32"
            )
        weak_keys = {"change-me", "change-me-in-production", "secret", "password"}
        if v.strip().lower() in weak_keys:
            # Only hard-fail in production; dev/test may keep the default.
            env = os.environ.get("POMODOROXII_ENVIRONMENT", "development")
            if env == "production":
                raise ValueError(
                    "POMODOROXII_SECRET_KEY is set to a known weak value. "
                    "Generate a strong key with: openssl rand -hex 32"
                )
        return v

    # ------------------------------------------------------------------ #
    # Per-space path helpers
    # ------------------------------------------------------------------ #
    def space_db_path(self, space_id: str) -> Path:
        """Return the absolute DB file path for a given space_id."""
        return self.spaces_data_dir / space_id / "space.db"

    def space_notes_dir(self, space_id: str) -> Path:
        """Return the notes directory for a given space_id."""
        return self.spaces_data_dir / space_id / "notes"


settings = Settings()
