"""Shared helpers for dual Alembic migration tests."""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from sqlalchemy import Engine, create_engine


def alembic_config(schema: str) -> Config:
    backend_dir = Path(__file__).resolve().parents[2]
    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / f"alembic_{schema}"))
    cfg.config_file_name = None
    return cfg


def migration_engine(tmp_path: Path, schema: str) -> Engine:
    db_path = tmp_path / f"{schema}.db"
    return create_engine(f"sqlite:///{db_path.as_posix()}")
