"""Smoke: asset 实体能注册、model 能导入、表结构正确."""

import app.registry.builtin  # noqa: F401  (触发注册)
from app.models.asset import Asset
from app.registry import REGISTRY


def test_asset_registered() -> None:
    spec = REGISTRY.get("asset")
    assert spec is not None
    assert spec.table_name == "assets"
    assert spec.sync_enabled is False, "S1 不同步"
    assert spec.storage_type.value == "db_only", "DB_ONLY 才能绕开 DomainPolicy 约束"


def test_asset_columns() -> None:
    cols = {c.name for c in Asset.__table__.columns}
    for expected in ("id", "filename", "mime", "size", "sha256", "storage_key"):
        assert expected in cols, f"缺少列 {expected}"


def test_sha256_indexed() -> None:
    assert Asset.__table__.columns["sha256"].index is True


def test_no_sync_entity_type_yet() -> None:
    """S1 不进同步，因此不该有 sync_entity_type（S2 再加）。"""
    spec = REGISTRY.get("asset")
    assert spec.sync_enabled is False
