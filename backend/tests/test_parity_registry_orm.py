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
