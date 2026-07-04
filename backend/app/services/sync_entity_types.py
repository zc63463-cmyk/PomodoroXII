"""P1-2: Entity type alias map — canonicalize snake_case ↔ camelCase.

The registry exposes snake_case entity names (e.g. 'quick_note'), while
SyncService.ENTITY_REGISTRY uses camelCase keys (e.g. 'quickNote') for
legacy client compatibility. This module bridges the two so that clients
using either convention are accepted by /sync/push.
"""
from __future__ import annotations

from app.registry import REGISTRY

# Lazily-built alias map: {snake_case_name | camelCase_alias -> camelCase canonical}.
# Entities without sync_entity_type fall back to their name (identity mapping).
_ALIAS_MAP: dict[str, str] = {}


def _build_alias_map() -> dict[str, str]:
    """Build the alias map from REGISTRY (call after registry is populated)."""
    alias: dict[str, str] = {}
    for spec in REGISTRY.list_sync_enabled():
        canonical = spec.sync_entity_type or spec.name
        # Always map the registry name -> canonical.
        alias[spec.name] = canonical
        # If sync_entity_type differs from name, also map it directly
        # (camelCase input should pass through unchanged).
        if spec.sync_entity_type and spec.sync_entity_type != spec.name:
            alias[spec.sync_entity_type] = spec.sync_entity_type
    return alias


def canonicalize_entity_type(etype: str) -> str | None:
    """Return the canonical camelCase entity_type, or None if unknown.

    Accepts both snake_case (registry name) and camelCase (sync_entity_type).
    Returns None for empty/unknown values so the caller can report an error.
    """
    if not etype:
        return None
    # Lazy build + cache (REGISTRY may not be populated at import time).
    global _ALIAS_MAP
    if not _ALIAS_MAP:
        _ALIAS_MAP = _build_alias_map()
    return _ALIAS_MAP.get(etype)
