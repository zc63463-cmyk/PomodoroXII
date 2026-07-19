from dataclasses import replace

import pytest

from app.registry import REGISTRY
from app.registry.catalog import CatalogCompilationError, CompiledEntityCatalog


def test_builtin_catalog_is_immutable_and_resolves_effective_sync_key() -> None:
    catalog = CompiledEntityCatalog.compile(REGISTRY.list(), version="1")

    assert catalog.version == "1"
    assert len(catalog.hash) == 64
    assert catalog.get("quick_note").effective_sync_entity_type == "quickNote"
    assert catalog.get_by_sync_key("quickNote").name == "quick_note"
    assert tuple(spec.name for spec in catalog.list_sync_enabled()) == tuple(
        spec.name for spec in catalog.list_sync_enabled()
    )
    with pytest.raises(TypeError):
        catalog._by_name["new"] = catalog.get("note")


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("table_name", "notes", "table"),
        ("route_prefix", "/notes", "route"),
        ("sync_entity_type", "note", "sync"),
        ("primary_key", "missing", "primary key"),
        ("delete_strategy", "unknown", "delete strategy"),
    ],
)
def test_compile_rejects_every_effective_key_collision(field, value, message) -> None:
    note = REGISTRY.get("note")
    conflicting = replace(REGISTRY.get("quick_note"), name="conflict", **{field: value})
    with pytest.raises(CatalogCompilationError, match=message):
        CompiledEntityCatalog.compile([note, conflicting], version="1")


def test_catalog_hash_is_order_independent_and_models_are_resolved() -> None:
    forward = CompiledEntityCatalog.compile(REGISTRY.list(), version="1")
    reverse = CompiledEntityCatalog.compile(list(reversed(REGISTRY.list())), version="1")

    assert forward.hash == reverse.hash
    assert forward.model_for("note").__name__ == "Note"
    assert forward.try_get_by_sync_key("unknown") is None
    assert forward.get("setting").primary_key == "key"


def test_registry_compile_seals_registration() -> None:
    from app.registry import EntityRegistry
    from app.registry.entities import EntityCategory, EntitySpec, FieldSpec, StorageType

    registry = EntityRegistry()
    registry.register(
        EntitySpec(
            name="example",
            model_path="app.models.task.Task",
            table_name="examples",
            storage_type=StorageType.DB_ONLY,
            category=EntityCategory.BUSINESS,
            sync_enabled=False,
            soft_delete=False,
            fields=(FieldSpec("id", "string", nullable=False),),
        )
    )
    registry.compile(version="1")
    with pytest.raises(CatalogCompilationError, match="sealed"):
        registry.register(
            replace(registry.get("example"), name="other", table_name="others")
        )


def test_catalog_rejects_sync_nullable_or_integer_primary_key() -> None:
    nullable = replace(REGISTRY.get("session"), primary_key="task_id")
    with pytest.raises(CatalogCompilationError, match="primary key"):
        CompiledEntityCatalog.compile([nullable], version="1")

    integer = replace(REGISTRY.get("session"), primary_key="duration")
    with pytest.raises(CatalogCompilationError, match="primary key"):
        CompiledEntityCatalog.compile([integer], version="1")
