"""Parity gate: REGISTRY vs Pydantic schemas.

确保每个 BUSINESS 实体在 app.schemas 中有对应的 Create/Update/Response schema。
特殊实体（Junction tables）在例外表中声明。
"""
from __future__ import annotations

import importlib

import pytest

from app.registry import REGISTRY
from app.registry.entities import EntityCategory


# 例外表：实体 -> 例外原因
# Junction tables 没有独立 schema（通过父实体管理）
SCHEMA_EXCEPTIONS: dict[str, str] = {
    "session_quick_note": "Junction table, no independent schema",
    "schedule_quick_note": "Junction table, no independent schema",
    "task_quick_note": "Junction table, no independent schema",
}


@pytest.mark.parametrize("spec_name", [
    s.name for s in REGISTRY.list_by_category(EntityCategory.BUSINESS)
    if s.name not in SCHEMA_EXCEPTIONS
])
def test_business_entity_has_schema_module(spec_name):
    """每个 BUSINESS 实体（非 junction）必须有 app.schemas.<name> 模块。"""
    module_path = f"app.schemas.{spec_name}"
    try:
        module = importlib.import_module(module_path)
    except ImportError as exc:
        pytest.fail(f"Missing schema module {module_path}: {exc}")
    assert module is not None


@pytest.mark.parametrize("spec_name", [
    s.name for s in REGISTRY.list_by_category(EntityCategory.BUSINESS)
    if s.name not in SCHEMA_EXCEPTIONS
])
def test_business_entity_has_response_schema(spec_name):
    """每个 BUSINESS 实体（非 junction）必须有 <Name>Response schema 类。"""
    module = importlib.import_module(f"app.schemas.{spec_name}")
    # Convert snake_case to PascalCase: quick_note -> QuickNote
    class_name = "".join(p.capitalize() for p in spec_name.split("_")) + "Response"
    assert hasattr(module, class_name), (
        f"{module.__name__} missing {class_name}"
    )
