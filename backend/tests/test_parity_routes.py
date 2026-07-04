"""Parity gate: REGISTRY route metadata vs actual FastAPI v1 routes.

Ensures that every entity flagged as ``route_enabled`` in the registry has a
corresponding router mounted under ``/api/v1``, and that every non-entity
router (auth, meta, trash, stats, sync) is explicitly accounted for.
"""
from __future__ import annotations

from app.registry import REGISTRY
from app.routes.v1 import build_v1_router

# Routers that are not tied to a single EntitySpec route_enabled entry.
# Spaces are handled by the ``space`` EntitySpec (route_enabled=True), so
# they are NOT listed here.
EXPECTED_NON_ENTITY_PREFIXES = {
    "/auth",
    "/meta",
    "/trash",
    "/stats",
    "/sync",
}


def _extract_v1_prefix(route) -> str | None:
    """Return the sub-prefix under ``/api/v1`` for an included router.

    ``build_v1_router()`` mounts sub-routers via ``include_router``; the
    resulting routes are ``_IncludedRouter`` instances whose
    ``include_context.prefix`` holds the full mounted path
    (e.g. ``/api/v1/tasks``). This helper strips the leading ``/api/v1``
    and returns ``/tasks``.
    """
    include_context = getattr(route, "include_context", None)
    if include_context is None:
        return None
    full_prefix = include_context.prefix
    if not full_prefix.startswith("/api/v1"):
        return None
    return full_prefix[len("/api/v1") :] or "/"


def _collect_v1_prefixes() -> set[str]:
    """Collect all sub-prefixes mounted under ``/api/v1``."""
    router = build_v1_router()
    prefixes: set[str] = set()
    for route in router.routes:
        prefix = _extract_v1_prefix(route)
        if prefix is not None:
            prefixes.add(prefix)
    return prefixes


def test_route_enabled_entities_must_have_non_empty_route_prefix():
    """Every EntitySpec with route_enabled=True must declare a route_prefix.

    A silent `if spec.route_enabled and spec.route_prefix` filter would
    hide entities that set route_enabled=True but forgot route_prefix.
    This test fails loud in that case so the registry stays consistent.
    """
    offenders = [
        spec.name
        for spec in REGISTRY.list()
        if spec.route_enabled and not spec.route_prefix
    ]
    assert not offenders, (
        f"EntitySpec with route_enabled=True but empty/None route_prefix: {offenders}"
    )


def test_registry_route_enabled_matches_v1_router():
    """Every route_enabled entity in REGISTRY must appear in v1 routes."""
    actual_prefixes = _collect_v1_prefixes()

    expected_entity_prefixes = {
        spec.route_prefix
        for spec in REGISTRY.list()
        if spec.route_enabled and spec.route_prefix
    }

    missing = expected_entity_prefixes - actual_prefixes
    assert not missing, (
        f"REGISTRY entities with route_enabled=True missing from v1 router: {missing}"
    )


def test_v1_entity_prefixes_are_registered():
    """Every v1 prefix that belongs to an entity CRUD router is registered."""
    actual_prefixes = _collect_v1_prefixes()

    expected_entity_prefixes = {
        spec.route_prefix
        for spec in REGISTRY.list()
        if spec.route_enabled and spec.route_prefix
    }

    actual_entity_prefixes = actual_prefixes - EXPECTED_NON_ENTITY_PREFIXES
    extra = actual_entity_prefixes - expected_entity_prefixes
    assert not extra, (
        f"v1 router has entity-like prefixes not registered in REGISTRY: {extra}"
    )


def test_non_entity_routers_present():
    """The known non-entity routers must still be mounted."""
    actual_prefixes = _collect_v1_prefixes()

    missing = EXPECTED_NON_ENTITY_PREFIXES - actual_prefixes
    assert not missing, f"Expected non-entity routers missing from v1 router: {missing}"
