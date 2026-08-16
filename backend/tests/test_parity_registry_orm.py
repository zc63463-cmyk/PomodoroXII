"""Parity gate: REGISTRY.model_path vs actual ORM model classes.

确保每个 spec.model_path 都能 import 到一个 ORM 类，且该类的
__tablename__ 与 spec.table_name 一致。
"""
from __future__ import annotations

import pytest

from app.registry import REGISTRY
from app.registry.resolve import resolve_model


@pytest.mark.parametrize("spec_name", [s.name for s in REGISTRY.list()])
def test_model_path_resolves_to_valid_orm_class(spec_name):
    """每个 spec.model_path 必须 import 到有效的 ORM 类。"""
    spec = REGISTRY.get(spec_name)
    model = resolve_model(spec)
    assert model is not None, f"Cannot resolve model_path: {spec.model_path}"


@pytest.mark.parametrize("spec_name", [s.name for s in REGISTRY.list()])
def test_model_tablename_matches_spec(spec_name):
    """ORM __tablename__ 必须与 spec.table_name 一致。"""
    spec = REGISTRY.get(spec_name)
    model = resolve_model(spec)
    assert model.__tablename__ == spec.table_name, (
        f"{spec.name}: ORM __tablename__={model.__tablename__!r}, "
        f"spec.table_name={spec.table_name!r}"
    )


# --------------------------------------------------------------------------- #
# TS1 Task 7 — Definition-model ownership scan
# --------------------------------------------------------------------------- #

FORBIDDEN_DEFINITION_MODEL_PATHS = [
    "app.models.status_definition",
    "app.models.type_definition",
    "app.models.label",
    "app.models.work_item_label",
]

EXPECTED_DEFINITION_MODEL_PATH = "app.models.work_item_definition"


def test_definition_models_are_co_located_in_work_item_definition():
    """StatusDefinition, TypeDefinition, Label, WorkItemLabel must all live
    in app.models.work_item_definition — no per-entity model files.
    """
    import importlib
    from pathlib import Path

    # No forbidden module files may exist on disk.
    backend_root = Path(__file__).resolve().parents[1]
    for forbidden in FORBIDDEN_DEFINITION_MODEL_PATHS:
        rel = forbidden.replace(".", "/") + ".py"
        assert not (backend_root / rel).exists(), (
            f"Forbidden model file exists: {rel}. "
            f"Definition models must live in {EXPECTED_DEFINITION_MODEL_PATH}."
        )

    # All four classes must be importable from the expected module.
    module = importlib.import_module(EXPECTED_DEFINITION_MODEL_PATH)
    for class_name in ("StatusDefinition", "TypeDefinition", "Label", "WorkItemLabel"):
        assert hasattr(module, class_name), (
            f"{EXPECTED_DEFINITION_MODEL_PATH} missing class {class_name}"
        )
