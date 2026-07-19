import inspect

from app.registry import CATALOG


def test_trash_production_consumer_uses_frozen_catalog_models() -> None:
    from app.routes.v1 import trash

    source = inspect.getsource(trash)
    assert "REGISTRY" not in source
    assert "resolve_model" not in source
    assert trash._ENTITY_MAP == {
        spec.name: CATALOG.model_for(spec.name)
        for spec in CATALOG.list_soft_delete()
    }


def test_registry_resolver_never_imports_models_after_compile() -> None:
    from app.registry import resolve

    source = inspect.getsource(resolve)
    assert "importlib" not in source
    assert "REGISTRY.list" not in source
