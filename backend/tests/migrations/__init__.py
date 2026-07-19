"""Shared helpers for dual Alembic migration tests."""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from sqlalchemy import Engine, create_engine


def alembic_config(schema: str) -> Config:
    backend_dir = Path(__file__).resolve().parents[2]
    cfg = Config(str(backend_dir / "alembic.ini"), ini_section=f"alembic:{schema}")
    cfg.get_main_option("script_location")
    cfg.config_file_name = None
    return cfg


def migration_engine(tmp_path: Path, schema: str) -> Engine:
    db_path = tmp_path / f"{schema}.db"
    return create_engine(f"sqlite:///{db_path.as_posix()}")


def run_bound_command(
    schema: str,
    db_path: Path,
    operation,
    revision: str,
) -> Config:
    import asyncio

    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )

    db_path.touch(exist_ok=True)
    target = _bind_existing_target(db_path, create_authority=True)
    config = alembic_config(schema)
    try:
        with target.open_maintenance(
            MaintenanceOptions(read_only=False, create_if_missing=False)
        ) as maintenance:
            with _alembic_maintenance_adapter(
                maintenance,
                expected_identity=target.identity,
                require_write=True,
            ) as adapter:
                config.attributes["maintenance_adapter"] = adapter
                operation(config, revision)
    finally:
        asyncio.run(target.aclose())
    return config
