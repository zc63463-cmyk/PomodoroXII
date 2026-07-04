"""build_sync_registry() 派生测试（P2.3）。

验证从 REGISTRY.list_sync_enabled() 派生的 sync registry 与
原 SyncService.ENTITY_REGISTRY 硬编码 dict 完全一致。
"""
from __future__ import annotations


def test_build_sync_registry_returns_14_entries():
    """build_sync_registry 必须返回 14 个实体。"""
    from app.registry.sync_registry import build_sync_registry

    registry = build_sync_registry()
    assert len(registry) == 14


def test_build_sync_registry_uses_camelcase_keys():
    """build_sync_registry 的 key 必须是 camelCase。"""
    from app.registry.sync_registry import build_sync_registry

    registry = build_sync_registry()
    assert "quickNote" in registry
    assert "habitCheckIn" in registry
    assert "timeBlock" in registry
    assert "memoComment" in registry


def test_build_sync_registry_includes_model_and_pull_key():
    """每个 entry 必须含 model 和 pull_key。"""
    from app.registry.sync_registry import build_sync_registry

    registry = build_sync_registry()
    for entity_type, entry in registry.items():
        assert "model" in entry, f"{entity_type} missing 'model'"
        assert "pull_key" in entry, f"{entity_type} missing 'pull_key'"
        assert entry["model"] is not None
        assert isinstance(entry["pull_key"], str)


def test_build_sync_registry_pull_keys_match_legacy():
    """build_sync_registry 的 pull_key 必须与原 ENTITY_REGISTRY 一致。"""
    from app.registry.sync_registry import build_sync_registry
    from app.services.sync import ENTITY_REGISTRY

    registry = build_sync_registry()
    for key, entry in registry.items():
        assert entry["pull_key"] == ENTITY_REGISTRY[key]["pull_key"], (
            f"{key}: build_sync_registry pull_key={entry['pull_key']!r}, "
            f"legacy={ENTITY_REGISTRY[key]['pull_key']!r}"
        )


def test_build_sync_registry_models_match_legacy():
    """build_sync_registry 的 model 必须与原 ENTITY_REGISTRY 一致。"""
    from app.registry.sync_registry import build_sync_registry
    from app.services.sync import ENTITY_REGISTRY

    registry = build_sync_registry()
    for key, entry in registry.items():
        assert entry["model"] is ENTITY_REGISTRY[key]["model"], (
            f"{key}: model mismatch"
        )
