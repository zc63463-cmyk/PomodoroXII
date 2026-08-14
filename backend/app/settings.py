"""Application settings via pydantic-settings.

PomodoroXII uses a multi-space architecture:
- A single *meta* database holds space registry and global settings.
- Each space has its own SQLite database (under ``spaces_data_dir``) and
  its own notes directory on the filesystem.

The ``Settings`` class centralises configuration for both layers and
exposes helper methods to compute per-space paths deterministically.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Self

from pydantic import PositiveInt, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

SYNC_RAW_ENVELOPE_FRAMING_HEADROOM_BYTES = 1024 * 1024


class Settings(BaseSettings):
    """Central configuration loaded from environment / .env file."""

    # --- Auth / JWT -------------------------------------------------------
    secret_key: str = "change-me"
    sync_cursor_secret: str = "change-me-sync-cursor-secret-change-me"
    algorithm: str = "HS256"
    master_token_expire_days: PositiveInt = 7
    space_token_expire_hours: PositiveInt = 8

    # --- Meta database ----------------------------------------------------
    data_root: Path = Path("./data")
    database_url: str = "sqlite+aiosqlite:///./data/meta.db"

    # --- Spaces layout ----------------------------------------------------
    spaces_data_dir: Path = Path("./data/spaces")
    engine_pool_max_size: PositiveInt = 5
    sync_client_ttl_days: PositiveInt = 30

    # --- HTTP / runtime ---------------------------------------------------
    cors_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:5173",
        "http://localhost:4173",
    ]
    trusted_proxy_cidrs: Annotated[list[str], NoDecode] = []
    request_body_max_bytes: PositiveInt = 11 * 1024 * 1024
    sync_event_payload_max_bytes: PositiveInt = 256 * 1024
    sync_canonical_batch_max_bytes: PositiveInt = 10 * 1024 * 1024
    debug: bool = False
    environment: str = "development"
    # --- Required scheduled full recovery --------------------------------
    # A production start must complete and verify one full snapshot before
    # readiness.  The backup target must be an explicit external directory;
    # the scheduler never infers a second Meta/Space root and never creates a
    # target inside the active data root.
    backup_enabled: bool = True
    backup_target_dir: Path | None = None
    backup_interval_hours: PositiveInt = 24
    backup_retention_count: PositiveInt = 30

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

    @model_validator(mode="before")
    @classmethod
    def derive_unspecified_canonical_root(cls, values):
        if not isinstance(values, dict) or "data_root" in values:
            return values
        database_url = values.get("database_url")
        spaces_dir = values.get("spaces_data_dir")
        if isinstance(database_url, str) and database_url.startswith(
            "sqlite+aiosqlite:///"
        ):
            inferred = Path(database_url.removeprefix("sqlite+aiosqlite:///"))
            if spaces_dir is None or Path(spaces_dir).resolve() == (
                inferred.parent / "spaces"
            ).resolve():
                values["data_root"] = inferred.parent
        return values

    @model_validator(mode="after")
    def validate_production_secret_key(self) -> Self:
        """Enforce the production secret policy after environment parsing."""
        if self.environment != "production":
            return self
        if not self.secret_key or not self.secret_key.strip():
            raise ValueError(
                "POMODOROXII_SECRET_KEY must be set to a non-empty value. "
                "Generate a strong key with: openssl rand -hex 32"
            )
        weak_keys = {"change-me", "change-me-in-production", "secret", "password"}
        if self.secret_key.strip().lower() in weak_keys:
            raise ValueError(
                "POMODOROXII_SECRET_KEY is set to a known weak value. "
                "Generate a strong key with: openssl rand -hex 32"
            )
        if len(self.secret_key.encode("utf-8")) < 32:
            raise ValueError(
                "POMODOROXII_SECRET_KEY must be at least 32 UTF-8 bytes in production. "
                "Generate a strong key with: openssl rand -hex 32"
            )
        cursor_secret = self.sync_cursor_secret.strip()
        if len(cursor_secret.encode("utf-8")) < 32:
            raise ValueError(
                "POMODOROXII_SYNC_CURSOR_SECRET must be at least 32 UTF-8 bytes in production."
            )
        if cursor_secret == self.secret_key:
            raise ValueError(
                "POMODOROXII_SYNC_CURSOR_SECRET must be distinct from POMODOROXII_SECRET_KEY."
            )
        if cursor_secret.lower() in {
            "change-me-sync-cursor-secret-change-me",
            "change-me",
            "secret",
            "password",
        }:
            raise ValueError(
                "POMODOROXII_SYNC_CURSOR_SECRET is set to a known weak value."
            )
        return self

    @model_validator(mode="after")
    def validate_sync_payload_budgets(self) -> Self:
        if self.sync_event_payload_max_bytes > self.sync_canonical_batch_max_bytes:
            raise ValueError(
                "sync_event_payload_max_bytes must not exceed sync_canonical_batch_max_bytes"
            )
        required_raw = (
            self.sync_canonical_batch_max_bytes
            + SYNC_RAW_ENVELOPE_FRAMING_HEADROOM_BYTES
        )
        if self.request_body_max_bytes < required_raw:
            raise ValueError(
                "request_body_max_bytes must cover canonical batch plus fixed framing headroom"
            )
        return self

    @model_validator(mode="after")
    def validate_backup_target(self) -> Self:
        """Fail closed unless backup configuration is unambiguous.

        Production with scheduled recovery enabled must name an explicit
        external backup target.  Any configured target must resolve outside
        the active data root so retention can never reach live data.
        """
        if self.environment == "production" and self.backup_enabled:
            if self.backup_target_dir is None:
                raise ValueError(
                    "POMODOROXII_BACKUP_TARGET_DIR is required in production "
                    "when POMODOROXII_BACKUP_ENABLED is true"
                )
        if self.backup_target_dir is not None:
            target = self.backup_target_dir.expanduser().resolve()
            root = self.data_root.expanduser().resolve()
            if target == root or root in target.parents:
                raise ValueError(
                    "POMODOROXII_BACKUP_TARGET_DIR must be outside the active data root"
                )
            if target in root.parents:
                raise ValueError(
                    "POMODOROXII_BACKUP_TARGET_DIR must not contain the active data root"
                )
        return self

    @property
    def meta_db_path(self) -> Path:
        return self.data_root.expanduser().resolve() / "meta.db"

    @property
    def canonical_spaces_root(self) -> Path:
        return self.data_root.expanduser().resolve() / "spaces"

    @staticmethod
    def _sqlite_path(url: str) -> Path:
        prefix = "sqlite+aiosqlite:///"
        if not url.startswith(prefix):
            raise ValueError("database_url must be a sqlite+aiosqlite URL")
        return Path(url.removeprefix(prefix)).expanduser().resolve()

    @model_validator(mode="after")
    def require_canonical_runtime_layout(self) -> Self:
        if self._sqlite_path(self.database_url) != self.meta_db_path:
            raise ValueError("database_url must equal data_root/meta.db")
        if self.spaces_data_dir.expanduser().resolve() != self.canonical_spaces_root:
            raise ValueError("spaces_data_dir must equal data_root/spaces")
        return self

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
