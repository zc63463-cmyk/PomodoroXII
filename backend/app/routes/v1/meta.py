"""REST routes for the entity registry (meta API).

These endpoints expose the in-process ``REGISTRY`` singleton over HTTP
so external tools and other projects can introspect the PomodoroXII
entity schema without reverse-engineering ORM models.

All endpoints require a *master* token (``require_master_token``) because
metadata is cross-space: it describes the schema of every space, not any
single space's data.

Routes commit (no-op here -- registry is read-only); MetaService performs
only in-memory lookups.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.deps import require_master_token
from app.schemas.meta import (
    EntityListOut,
    EntitySchemaOut,
    EntitySpecOut,
    RegistryHealthOut,
)
from app.services.meta import MetaService

router = APIRouter()


@router.get("/health", response_model=RegistryHealthOut)
async def registry_health(
    user: dict = Depends(require_master_token),
) -> dict:
    """Return registry load status, entity count, and per-category counts."""
    return MetaService().health()


@router.get("/entities", response_model=EntityListOut)
async def list_entities(
    category: str | None = Query(
        None,
        description=(
            "Filter by category: business|sync_infra|meta|setting"
        ),
    ),
    user: dict = Depends(require_master_token),
) -> dict:
    """List all registered entities, optionally filtered by category."""
    svc = MetaService()
    specs = svc.list_entities(category=category)
    return {
        "entities": [svc.serialize(s) for s in specs],
        "total": len(specs),
    }


@router.get("/entities/{entity_type}", response_model=EntitySpecOut)
async def get_entity(
    entity_type: str,
    user: dict = Depends(require_master_token),
) -> dict:
    """Return the full metadata spec for a single entity."""
    svc = MetaService()
    spec = svc.get_entity(entity_type)
    return svc.serialize(spec)


@router.get("/entities/{entity_type}/schema", response_model=EntitySchemaOut)
async def get_entity_schema(
    entity_type: str,
    user: dict = Depends(require_master_token),
) -> dict:
    """Return the field schema for an entity (code-generator friendly).

    Lighter than ``GET /entities/{entity_type}``: omits business
    classification flags (sync_enabled, soft_delete, etc.) and returns
    only the column shape.
    """
    svc = MetaService()
    return svc.get_schema(entity_type)
