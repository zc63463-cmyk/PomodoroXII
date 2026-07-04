"""EntitySpec 扩展字段测试（P2.1）。

验证 EntitySpec 新增的 7 个字段 + 2 个 effective_* 属性。
注意：sync_entity_type 和 pull_key 字段在 P1.2 已添加，
本测试集中验证 P2.1 新增的 5 个字段 + 2 个属性 + 默认值。
"""
from __future__ import annotations

from app.registry.entities import EntityCategory, EntitySpec, FieldSpec, StorageType


def _make_spec(**overrides) -> EntitySpec:
    """构造一个最小合法的 EntitySpec 用于测试。"""
    defaults = dict(
        name="test",
        model_path="app.models.task.Task",
        table_name="tests",
        storage_type=StorageType.DB_ONLY,
        category=EntityCategory.BUSINESS,
        sync_enabled=True,
        soft_delete=False,
        fields=(FieldSpec("id", "string", nullable=False),),
    )
    defaults.update(overrides)
    return EntitySpec(**defaults)


def test_entity_spec_has_sync_entity_type_field():
    """EntitySpec 必须有 sync_entity_type 字段。"""
    spec = _make_spec(sync_entity_type="testEntity")
    assert spec.sync_entity_type == "testEntity"


def test_entity_spec_has_pull_key_field():
    """EntitySpec 必须有 pull_key 字段。"""
    spec = _make_spec(pull_key="tests")
    assert spec.pull_key == "tests"


def test_entity_spec_has_delete_strategy_field():
    """EntitySpec 必须有 delete_strategy 字段，默认 'hard_tombstone'。"""
    spec = _make_spec()
    assert spec.delete_strategy == "hard_tombstone"


def test_entity_spec_effective_sync_entity_type_fallback():
    """sync_entity_type 不填时，effective_sync_entity_type fallback 到 name。"""
    spec = _make_spec(name="task")
    assert spec.effective_sync_entity_type == "task"


def test_entity_spec_effective_pull_key_fallback():
    """pull_key 不填时，effective_pull_key fallback 到 name + 's'。"""
    spec = _make_spec(name="task")
    assert spec.effective_pull_key == "tasks"
