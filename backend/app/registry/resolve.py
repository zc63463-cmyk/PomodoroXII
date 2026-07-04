"""Dynamic ORM model resolution from EntitySpec.model_path.

提供两个函数：
- resolve_model(spec_or_path): 从 model_path 字符串动态 import ORM 类
- import_all_models(): 遍历 REGISTRY 调用 resolve_model，确保所有模型注册到 Base.metadata
"""
from __future__ import annotations

import importlib
from typing import Union

from app.registry import REGISTRY, EntitySpec


def resolve_model(spec_or_path: Union[EntitySpec, str]) -> type:
    """从 EntitySpec.model_path 或字符串路径 import ORM 类。

    Args:
        spec_or_path: EntitySpec 实例或 "app.models.task.Task" 形式字符串

    Returns:
        ORM 类（如 Task）

    Raises:
        ImportError: 模块无法 import
        AttributeError: 模块中找不到指定类
        ValueError: model_path 格式无效（无模块路径）
    """
    path = spec_or_path.model_path if isinstance(spec_or_path, EntitySpec) else spec_or_path
    module_path, _, class_name = path.rpartition(".")
    if not module_path:
        raise ValueError(f"Invalid model_path: {path!r}")
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


def import_all_models() -> None:
    """遍历 REGISTRY 调用 resolve_model，确保所有 ORM 类被 import。

    用于 Alembic env.py 和 space_manager._init_schema() 前，
    确保 Base.metadata 包含所有表。
    """
    for spec in REGISTRY.list():
        resolve_model(spec)
