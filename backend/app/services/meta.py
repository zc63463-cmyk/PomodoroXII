"""MetaService -- read-only queries over the entity registry.

This service is a thin adapter between the in-process ``REGISTRY``
singleton and the route layer.  It converts registry errors
(``KeyError``) into domain errors (``NotFoundError``) so the FastAPI
exception handlers can render them as proper 404 responses.

Unlike other services, ``MetaService`` does NOT take an ``AsyncSession``
because the registry is a pure in-memory structure with no DB access.
It still follows the iron rules: no FastAPI import, no commit calls.
"""
from __future__ import annotations

from typing import Any

from app.errors import NotFoundError, ValidationError
from app.registry import REGISTRY
from app.registry.entities import EntityCategory, EntitySpec


class MetaService:
    """Read-only query facade over the global ``REGISTRY`` singleton."""

    def __init__(self) -> None:
        self.registry = REGISTRY

    # ------------------------------------------------------------------ #
    # Listing queries
    # ------------------------------------------------------------------ #
    def list_entities(
        self, *, category: EntityCategory | None = None,
    ) -> list[EntitySpec]:
        """Return all entity specs, optionally filtered by category.

        If *category* is provided as a string, it is coerced to the
        ``EntityCategory`` enum; an invalid value raises
        ``ValidationError`` (HTTP 422).
        """
        if category is None:
            return self.registry.list()
        if isinstance(category, str):
            try:
                category = EntityCategory(category)
            except ValueError as exc:
                raise ValidationError(
                    f"Invalid category: {category!r}"
                ) from exc
        return self.registry.list_by_category(category)

    def list_sync_enabled(self) -> list[EntitySpec]:
        """Return entities flagged as sync-eligible."""
        return self.registry.list_sync_enabled()

    def list_soft_delete(self) -> list[EntitySpec]:
        """Return entities that support the ``trashed_at`` soft-delete column."""
        return self.registry.list_soft_delete()

    # ------------------------------------------------------------------ #
    # Single-entity queries
    # ------------------------------------------------------------------ #
    def get_entity(self, name: str) -> EntitySpec:
        """Return the spec for *name* or raise ``NotFoundError`` (HTTP 404)."""
        if name not in self.registry:
            raise NotFoundError(f"Entity {name!r} not found in registry")
        return self.registry.get(name)

    def get_schema(self, name: str) -> dict[str, Any]:
        """Return a code-generator-friendly schema dict for *name*.

        Raises ``NotFoundError`` if *name* is not registered.
        """
        spec = self.get_entity(name)
        return {
            "entity_type": spec.name,
            "table_name": spec.table_name,
            "primary_key": spec.primary_key,
            "fields": [self._field_dict(f) for f in spec.fields],
        }

    # ------------------------------------------------------------------ #
    # Health / stats
    # ------------------------------------------------------------------ #
    def health(self) -> dict[str, Any]:
        """Return registry health + per-category counts."""
        cats: dict[str, int] = {}
        for spec in self.registry.list():
            key = spec.category.value
            cats[key] = cats.get(key, 0) + 1
        return {
            "registry_loaded": len(self.registry) > 0,
            "entity_count": len(self.registry),
            "categories": cats,
        }

    # ------------------------------------------------------------------ #
    # Serialisation helpers (shared with routes)
    # ------------------------------------------------------------------ #
    @staticmethod
    def serialize(spec: EntitySpec) -> dict[str, Any]:
        """Convert an ``EntitySpec`` to a JSON-safe dict.

        Used by the route layer to feed ``EntitySpecOut`` Pydantic models.
        """
        return {
            "name": spec.name,
            "model_path": spec.model_path,
            "table_name": spec.table_name,
            "storage_type": spec.storage_type.value,
            "category": spec.category.value,
            "sync_enabled": spec.sync_enabled,
            "soft_delete": spec.soft_delete,
            "primary_key": spec.primary_key,
            "description": spec.description,
            "fields": [MetaService._field_dict(f) for f in spec.fields],
        }

    @staticmethod
    def _field_dict(f: Any) -> dict[str, Any]:
        return {
            "name": f.name,
            "type": f.type,
            "nullable": f.nullable,
            "default": f.default,
            "indexed": f.indexed,
            "unique": f.unique,
            "description": f.description,
        }
