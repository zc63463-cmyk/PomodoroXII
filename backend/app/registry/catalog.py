"""Compile the mutable entity registry into an immutable runtime catalog."""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from sqlalchemy import inspect as sa_inspect

from app.registry.entities import EntitySpec, require_sync_conflict_policy


class CatalogCompilationError(ValueError):
    """Raised when registry declarations cannot form a safe catalog."""


def _canonical_spec(spec: EntitySpec) -> dict[str, Any]:
    return {
        "name": spec.name,
        "model_path": spec.model_path,
        "table_name": spec.table_name,
        "storage_type": spec.storage_type.value,
        "category": spec.category.value,
        "sync_enabled": spec.sync_enabled,
        "soft_delete": spec.soft_delete,
        "primary_key": spec.primary_key,
        "fields": [field.__dict__ for field in spec.fields],
        "sync_entity_type": spec.sync_entity_type,
        "pull_key": spec.pull_key,
        "route_prefix": spec.route_prefix,
        "delete_strategy": spec.delete_strategy,
        "route_enabled": spec.route_enabled,
        "mcp_schema_enabled": spec.mcp_schema_enabled,
        "sync_conflict_policy": require_sync_conflict_policy(
            spec.sync_conflict_policy
        ).value,
        "junction_endpoints": spec.junction_endpoints,
    }


def _resolve_model(spec: EntitySpec) -> type[Any]:
    module_path, separator, class_name = spec.model_path.rpartition(".")
    if not separator or not module_path or not class_name:
        raise CatalogCompilationError(f"model path cannot be resolved: {spec.model_path!r}")
    try:
        return getattr(importlib.import_module(module_path), class_name)
    except (ImportError, AttributeError) as exc:
        raise CatalogCompilationError(
            f"model path cannot be resolved: {spec.model_path!r}"
        ) from exc


def _resolve_attribute(path: str, *, label: str) -> Any:
    module_path, separator, attribute = path.rpartition(".")
    if not separator or not module_path or not attribute:
        raise CatalogCompilationError(f"{label} cannot be resolved: {path!r}")
    try:
        return getattr(importlib.import_module(module_path), attribute)
    except (ImportError, AttributeError) as exc:
        raise CatalogCompilationError(f"{label} cannot be resolved: {path!r}") from exc


@dataclass(frozen=True)
class CompiledEntityCatalog:
    version: str
    hash: str
    _by_name: Mapping[str, EntitySpec] = field(repr=False)
    _by_sync_key: Mapping[str, EntitySpec] = field(repr=False)
    _sync_enabled: tuple[EntitySpec, ...] = field(repr=False)
    _models_by_name: Mapping[str, type[Any]] = field(repr=False)

    @classmethod
    def compile(cls, specs: Iterable[EntitySpec], *, version: str) -> "CompiledEntityCatalog":
        ordered = tuple(sorted(specs, key=lambda item: item.name))
        if not ordered:
            raise CatalogCompilationError("catalog cannot be empty")
        names: set[str] = set()
        tables: set[str] = set()
        routes: set[str] = set()
        sync_keys: set[str] = set()
        allowed_delete = {"hard_tombstone", "soft_delete", "cascade_soft_delete", "fs_saga"}
        models: dict[str, type[Any]] = {}
        for spec in ordered:
            require_sync_conflict_policy(spec.sync_conflict_policy)
            if spec.name in names:
                raise CatalogCompilationError(f"duplicate entity name: {spec.name}")
            if spec.table_name in tables:
                raise CatalogCompilationError(f"duplicate table: {spec.table_name}")
            if spec.route_enabled and (not spec.route_prefix or spec.route_prefix in routes):
                raise CatalogCompilationError(f"duplicate or missing route: {spec.route_prefix!r}")
            if spec.route_enabled and not all(
                (spec.service_path, spec.schema_module, spec.schema_prefix)
            ):
                raise CatalogCompilationError(f"route contract incomplete: {spec.name}")
            if spec.service_path:
                _resolve_attribute(spec.service_path, label="service path")
            if spec.schema_module and spec.schema_prefix:
                schema_module = importlib.import_module(spec.schema_module)
                if not hasattr(schema_module, spec.schema_prefix):
                    raise CatalogCompilationError(
                        f"schema prefix cannot be resolved: {spec.schema_prefix}"
                    )
            elif spec.route_enabled or spec.mcp_schema_enabled is True and spec.schema_module:
                raise CatalogCompilationError(f"schema contract incomplete: {spec.name}")
            if spec.route_prefix:
                routes.add(spec.route_prefix)
            if spec.sync_enabled and spec.effective_sync_entity_type in sync_keys:
                raise CatalogCompilationError(
                    f"duplicate sync key: {spec.effective_sync_entity_type}"
                )
            if spec.sync_enabled:
                sync_keys.add(spec.effective_sync_entity_type)
            if spec.delete_strategy not in allowed_delete:
                raise CatalogCompilationError(f"unknown delete strategy: {spec.delete_strategy}")
            if spec.primary_key not in spec.field_names:
                raise CatalogCompilationError(f"primary key missing: {spec.primary_key}")
            if spec.junction_endpoints is not None:
                for field_name, endpoint_type in spec.junction_endpoints:
                    if field_name not in spec.field_names:
                        raise CatalogCompilationError(
                            f"junction endpoint field not in spec fields: {field_name}"
                        )
                    # endpoint_type existence is validated after the loop
            names.add(spec.name)
            tables.add(spec.table_name)
            models[spec.name] = _resolve_model(spec)
            if spec.sync_enabled:
                try:
                    mapper = sa_inspect(models[spec.name])
                    column = mapper.columns[spec.primary_key]
                except (KeyError, AttributeError) as exc:
                    raise CatalogCompilationError(
                        f"primary key cannot be resolved: {spec.primary_key}"
                    ) from exc
                if column.nullable or column.type.__class__.__name__.lower() not in {
                    "string",
                    "varchar",
                    "text",
                }:
                    raise CatalogCompilationError(
                        f"sync primary key must be nonnullable string: {spec.primary_key}"
                    )
        # Validate junction endpoint entity types exist in the catalog.
        for spec in ordered:
            if spec.junction_endpoints is not None:
                for _field_name, endpoint_type in spec.junction_endpoints:
                    if endpoint_type not in names:
                        raise CatalogCompilationError(
                            f"junction endpoint entity type not in catalog: {endpoint_type}"
                        )

        canonical = json.dumps(
            [_canonical_spec(spec) for spec in ordered],
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return cls(
            version=version,
            hash=hashlib.sha256(canonical).hexdigest(),
            _by_name=MappingProxyType({spec.name: spec for spec in ordered}),
            _by_sync_key=MappingProxyType(
                {spec.effective_sync_entity_type: spec for spec in ordered if spec.sync_enabled}
            ),
            _sync_enabled=tuple(spec for spec in ordered if spec.sync_enabled),
            _models_by_name=MappingProxyType(models),
        )

    def get(self, name: str) -> EntitySpec:
        return self._by_name[name]

    def get_by_sync_key(self, key: str) -> EntitySpec:
        return self._by_sync_key[key]

    def try_get_by_sync_key(self, key: str) -> EntitySpec | None:
        return self._by_sync_key.get(key)

    def model_for(self, name: str) -> type[Any]:
        return self._models_by_name[name]

    def list_sync_enabled(self) -> tuple[EntitySpec, ...]:
        return self._sync_enabled

    def list(self) -> tuple[EntitySpec, ...]:
        return tuple(self._by_name.values())

    def list_by_category(self, category: Any) -> tuple[EntitySpec, ...]:
        return tuple(spec for spec in self._by_name.values() if spec.category == category)

    def list_soft_delete(self) -> tuple[EntitySpec, ...]:
        return tuple(spec for spec in self._by_name.values() if spec.soft_delete)

    def junction_endpoints_for(self, entity_type: str) -> tuple[tuple[str, str], ...] | None:
        """Return junction endpoint metadata for an entity type, or None.

        Each tuple is (field_name, endpoint_entity_type).
        """
        spec = self._by_name.get(entity_type)
        return spec.junction_endpoints if spec else None

    def __contains__(self, name: str) -> bool:
        return name in self._by_name

    def __len__(self) -> int:
        return len(self._by_name)
