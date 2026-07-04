"""Pydantic schemas for the meta API (entity registry introspection).

These models serialise ``EntitySpec`` / ``FieldSpec`` dataclasses into
JSON-safe dicts so the ``/api/v1/meta/*`` routes can return them with
full type information.

Design notes:
- ``StorageType`` and ``EntityCategory`` are ``str, Enum`` subclasses, so
  Pydantic v2 serialises them as their string values automatically.
- ``default`` is typed ``Any`` because column defaults range from
  primitives (``""``, ``0``, ``False``) to JSON strings (``"[]"``).
- ``from_attributes`` is enabled so Pydantic can read directly from the
  frozen dataclasses without an intermediate dict conversion.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.registry.entities import EntityCategory, StorageType


class FieldSpecOut(BaseModel):
    """A single column's metadata."""

    name: str
    type: str
    nullable: bool
    default: Any = None
    indexed: bool = False
    unique: bool = False
    description: str = ""

    model_config = {"from_attributes": True}


class EntitySpecOut(BaseModel):
    """Full metadata for one entity."""

    name: str
    model_path: str
    table_name: str
    storage_type: StorageType
    category: EntityCategory
    sync_enabled: bool
    soft_delete: bool
    primary_key: str = "id"
    description: str = ""
    fields: list[FieldSpecOut]

    model_config = {"from_attributes": True}


class EntityListOut(BaseModel):
    """Paginated-style envelope for the entities listing.

    The list is intentionally not paginated (the registry is a small
    in-process singleton with ~20 entries), but the envelope keeps a
    ``total`` field for parity with other list endpoints.
    """

    entities: list[EntitySpecOut]
    total: int


class RegistryHealthOut(BaseModel):
    """Health / stats payload for ``GET /api/v1/meta/health``."""

    registry_loaded: bool
    entity_count: int
    categories: dict[str, int]


class EntitySchemaOut(BaseModel):
    """Field-schema response for ``GET /api/v1/meta/entities/{type}/schema``.

    Intentionally lighter than ``EntitySpecOut``: this payload is meant
    for external code generators that only need column shape, not
    business classification flags.
    """

    entity_type: str
    table_name: str
    primary_key: str
    fields: list[FieldSpecOut]
