"""SyncService registry derived from REGISTRY.

替代 services/sync.py 中手工维护的 ENTITY_REGISTRY dict，
让 sync 协议的事实源唯一化为 REGISTRY + EntitySpec。

构建结果:
    dict[entity_type_camelCase, {"model": ORMClass, "pull_key": str, "spec": EntitySpec}]

保证:
- key 用 spec.effective_sync_entity_type（camelCase 兼容历史协议）
- model 用 resolve_model(spec) 动态 import
- pull_key 用 spec.effective_pull_key
"""
from __future__ import annotations

from typing import Any

from app.registry import REGISTRY
from app.registry.resolve import resolve_model


def build_sync_registry() -> dict[str, dict[str, Any]]:
    """从 REGISTRY.list_sync_enabled() 派生 sync registry。

    Returns:
        dict[entity_type, {"model": ORMClass, "pull_key": str, "spec": EntitySpec}]

    Raises:
        ImportError: 某个 spec.model_path 无法 import
        AttributeError: 模块中找不到指定类
    """
    result: dict[str, dict[str, Any]] = {}
    for spec in REGISTRY.list_sync_enabled():
        entity_type = spec.effective_sync_entity_type
        model = resolve_model(spec)
        pull_key = spec.effective_pull_key
        result[entity_type] = {
            "model": model,
            "pull_key": pull_key,
            "spec": spec,
        }
    return result
