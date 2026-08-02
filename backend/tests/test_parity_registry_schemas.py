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
# Task Space entities have schemas in non-standard modules (task_space.py, etc.)
SCHEMA_EXCEPTIONS: dict[str, str] = {
    "schedule_quick_note": "Junction table, no independent schema",
    "work_item_label": "Junction table, no independent schema",
    "session_task_context": "FocusSession entity, schema managed via session module",
    "session_attribution_revision": "FocusSession entity, schema managed via session module",
    "session_work_item_plan": "FocusSession entity, schema managed via session module",
    "session_work_item_outcome": "FocusSession entity, schema managed via session module",
    "project": "Task Space entity, schema in app.schemas.task_space",
    "status_definition": "Task Space entity, schema in app.schemas.task_space",
    "type_definition": "Task Space entity, schema in app.schemas.task_space",
    "label": "Task Space entity, schema in app.schemas.task_space",
    "work_item": "Task Space entity, schema in app.schemas.task_space",
    "work_item_note": "Task Space entity, schema in app.schemas.work_item_note",
    "focus_session": "Task Space entity, schema in app.schemas.focus_session",
}

# Task Space entity -> (schema module, expected response class or None)
TASK_SPACE_SCHEMA_MAP: dict[str, tuple[str, str | None]] = {
    "project": ("app.schemas.task_space", "ProjectResponse"),
    "work_item": ("app.schemas.task_space", "WorkItemResponse"),
    "status_definition": ("app.schemas.task_space", "TaskSpaceDefinitionsResponse"),
    "type_definition": ("app.schemas.task_space", "TaskSpaceDefinitionsResponse"),
    "label": ("app.schemas.task_space", "TaskSpaceDefinitionsResponse"),
    "work_item_note": ("app.schemas.work_item_note", None),
    "focus_session": ("app.schemas.focus_session", "FocusSessionAggregateResponse"),
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


# --------------------------------------------------------------------------- #
# TS1 Task 7 — Task Space entity schema location parity
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("entity_name,expected_module,expected_class", [
    (name, mod, cls)
    for name, (mod, cls) in TASK_SPACE_SCHEMA_MAP.items()
])
def test_task_space_entity_schema_in_correct_module(
    entity_name: str, expected_module: str, expected_class: str | None,
) -> None:
    """Each Task Space entity must have its schema in the declared module."""
    module = importlib.import_module(expected_module)
    if expected_class is not None:
        assert hasattr(module, expected_class), (
            f"{expected_module} missing {expected_class} for entity '{entity_name}'"
        )
