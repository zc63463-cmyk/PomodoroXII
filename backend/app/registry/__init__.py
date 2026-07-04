"""Entity registry singleton for PomodoroXII.

The registry is a process-level singleton populated at import time by
``app.registry.builtin``.  It is consumed by:

- ``app.services.sync.SyncService`` (Phase C) to dispatch per-entity writes
- ``app.routes.v1.trash`` to discover soft-delete-capable entities
- ``app.routes.v1.meta`` to expose schema introspection over HTTP

Iron rules (consistent with the project's three-layer discipline):
- Does NOT import FastAPI.
- Does NOT call ``commit()``.
- Does NOT import ORM models (only references them by ``model_path`` string).
"""
from __future__ import annotations

from app.registry.entities import (
    EntityCategory,
    EntitySpec,
    FieldSpec,
    StorageType,
)

__all__ = [
    "EntityRegistry",
    "REGISTRY",
    "EntitySpec",
    "FieldSpec",
    "StorageType",
    "EntityCategory",
]


class EntityRegistry:
    """Process-level registry of entity metadata specs.

    The registry is intentionally minimal: it stores ``EntitySpec``
    instances keyed by their ``name`` and offers a handful of
    convenience filters.  All mutation happens at import time via
    ``register``; runtime callers only read.
    """

    def __init__(self) -> None:
        self._specs: dict[str, EntitySpec] = {}

    def register(self, spec: EntitySpec) -> None:
        """Register an ``EntitySpec``.

        Raises ``ValueError`` if a spec with the same name is already
        registered, which usually indicates a duplicate declaration in
        ``builtin.py``.
        """
        if spec.name in self._specs:
            raise ValueError(f"Entity {spec.name!r} already registered")
        self._specs[spec.name] = spec

    def get(self, name: str) -> EntitySpec:
        """Return the spec for *name* or raise ``KeyError``."""
        if name not in self._specs:
            raise KeyError(f"Unknown entity: {name!r}")
        return self._specs[name]

    def list(self) -> list[EntitySpec]:
        """Return all registered specs (insertion order)."""
        return list(self._specs.values())

    def list_by_category(self, cat: EntityCategory) -> list[EntitySpec]:
        """Return specs whose ``category`` equals *cat*."""
        return [s for s in self._specs.values() if s.category == cat]

    def list_sync_enabled(self) -> list[EntitySpec]:
        """Return specs flagged as ``sync_enabled``."""
        return [s for s in self._specs.values() if s.sync_enabled]

    def list_soft_delete(self) -> list[EntitySpec]:
        """Return specs that support soft-delete via ``trashed_at``."""
        return [s for s in self._specs.values() if s.soft_delete]

    def __contains__(self, name: str) -> bool:
        return name in self._specs

    def __len__(self) -> int:
        return len(self._specs)


# Process-level singleton.
REGISTRY = EntityRegistry()

# Importing ``builtin`` populates ``REGISTRY`` with the 18 declared
# entities.  This import is placed *after* ``REGISTRY`` is created to
# avoid a circular dependency: ``builtin`` imports ``REGISTRY`` from
# this module, and we import ``builtin`` to trigger registration.
from app.registry import builtin  # noqa: E402, F401
