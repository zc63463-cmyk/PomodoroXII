"""Parity gate: Alembic head 生成的表/列 vs ORM Base.metadata。

确保 Alembic 迁移链覆盖所有 ORM 模型声明的表，避免 schema 漂移。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from alembic import command


def _alembic_cfg() -> Config:
    """Build an Alembic Config pointing at the project's alembic.ini.

    复用 test_alembic.py:19-35 模式：读 ini 后清空 config_file_name
    以抑制 env.py 内的 fileConfig() 副作用。
    """
    backend_dir = Path(__file__).resolve().parent.parent
    ini_path = backend_dir / "alembic.ini"
    cfg = Config(str(ini_path))
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    cfg.config_file_name = None
    return cfg


def test_alembic_head_tables_match_metadata(tmp_path: Path):
    """Alembic upgrade head 生成的表必须等于 Base.metadata 表集合。"""
    import importlib

    # 触发所有 ORM 模型注册到 Base.metadata（_isolate_env 已 reload Base）
    importlib.import_module("app.db.base")
    importlib.import_module("app.models")
    importlib.import_module("app.db.models.meta")
    from app.db.base import Base

    cfg = _alembic_cfg()
    db_path = tmp_path / "parity_test.db"
    engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")

    alembic_tables = set(inspect(engine).get_table_names()) - {"alembic_version"}
    metadata_tables = set(Base.metadata.tables.keys())
    engine.dispose()

    missing = metadata_tables - alembic_tables
    extra = alembic_tables - metadata_tables
    assert not missing, f"In metadata but not Alembic: {missing}"
    assert not extra, f"In Alembic but not metadata: {extra}"
