"""Parity gate: REGISTRY.list_sync_enabled() vs SyncService.ENTITY_REGISTRY.

确保两个事实源在实体数量、entity_type、pull_key 上完全一致。
新增 sync 实体时必须同时更新两处（或 Phase 2 后只更新 REGISTRY）。
"""
from __future__ import annotations

from app.registry import REGISTRY
from app.services.sync import ENTITY_REGISTRY


def test_sync_registry_count_matches_registry_sync_enabled():
    """ENTITY_REGISTRY 数量必须等于 REGISTRY.list_sync_enabled() 数量。"""
    expected = len(REGISTRY.list_sync_enabled())
    actual = len(ENTITY_REGISTRY)
    assert actual == expected, (
        f"Sync ENTITY_REGISTRY has {actual} entries, "
        f"but REGISTRY.list_sync_enabled() returns {expected}. "
        "New sync entity must be added to both."
    )


def test_sync_registry_entity_types_match():
    """每个 ENTITY_REGISTRY key 必须对应一个 REGISTRY spec 的 sync_entity_type/name。"""
    sync_names_in_registry = {
        spec.sync_entity_type or spec.name
        for spec in REGISTRY.list_sync_enabled()
    }
    entity_registry_keys = set(ENTITY_REGISTRY.keys())
    missing = entity_registry_keys - sync_names_in_registry
    extra = sync_names_in_registry - entity_registry_keys
    assert not missing, f"In ENTITY_REGISTRY but not REGISTRY: {missing}"
    assert not extra, f"In REGISTRY but not ENTITY_REGISTRY: {extra}"


def test_sync_registry_pull_keys_match():
    """每个 ENTITY_REGISTRY pull_key 必须与 REGISTRY spec 的 pull_key 一致。

    P2.6: Phase 2 EntitySpec 已扩展 pull_key 字段,此测试现已启用。
    比对 SyncService.ENTITY_REGISTRY 的 pull_key 与 REGISTRY spec 的
    effective_pull_key,确保两个事实源在协议层一致。
    """
    sync_specs_by_type = {
        spec.effective_sync_entity_type: spec
        for spec in REGISTRY.list_sync_enabled()
    }
    for entity_type, entry in ENTITY_REGISTRY.items():
        spec = sync_specs_by_type.get(entity_type)
        assert spec is not None, (
            f"ENTITY_REGISTRY key {entity_type!r} not in REGISTRY.list_sync_enabled()"
        )
        assert entry["pull_key"] == spec.effective_pull_key, (
            f"{entity_type}: ENTITY_REGISTRY pull_key={entry['pull_key']!r}, "
            f"REGISTRY effective_pull_key={spec.effective_pull_key!r}"
        )
