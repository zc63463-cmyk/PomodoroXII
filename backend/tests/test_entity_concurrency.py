"""Tests for CAS and LWW concurrency resolution in the mutation pipeline.

Covers:
1. strict_cas rejects stale expected_version — no LWW fallback
2. timestamp_lww accepts remote-wins update when client is newer
3. timestamp_lww rejects local-wins update when client is older
"""

from __future__ import annotations

import pytest

from app.errors import MutationRejectedError
from tests.test_entity_invariants import EntityFixture, entity_fixture  # noqa: F401


async def test_strict_cas_rejects_stale_version(entity_fixture: EntityFixture):
    """strict_cas policy rejects updates with wrong expected_version — no LWW fallback."""
    await entity_fixture.seed_strict_cas_entity(
        "sf-1", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    scope = entity_fixture.open_mutation_scope()
    try:
        request = entity_fixture.commands.update(
            scope, "strict_fixture", "sf-1", {"title": "Updated"}, expected_version=2
        )
        with pytest.raises(MutationRejectedError) as exc_info:
            await entity_fixture.uow.execute(scope, request, "op-strict-cas")
        assert exc_info.value.rejection.code == "version_conflict"
    finally:
        await scope.aclose()


async def test_lww_remote_wins_when_client_is_newer(entity_fixture: EntityFixture):
    """timestamp_lww accepts updates when client timestamp is newer — resolution='remote'."""
    await entity_fixture.seed_schedule(
        "sch-1", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    scope = entity_fixture.open_mutation_scope()
    try:
        event = entity_fixture.sync_event(
            action="update",
            entity_id="sch-1",
            payload={"id": "sch-1", "title": "Updated"},
            client_updated_at="2026-07-14T00:00:00.000Z",
            expected_version=2,
        )
        request = entity_fixture.commands.from_sync_event(scope, event)
        result = await entity_fixture.uow.execute(scope, request, "op-lww-remote")
        assert result.resolution == "remote"
    finally:
        await scope.aclose()


async def test_lww_local_wins_when_client_is_older(entity_fixture: EntityFixture):
    """timestamp_lww rejects updates when client timestamp is older — resolution='local'."""
    await entity_fixture.seed_schedule(
        "sch-2", version=1, updated_at="2026-07-14T00:00:00.000Z"
    )
    scope = entity_fixture.open_mutation_scope()
    try:
        event = entity_fixture.sync_event(
            action="update",
            entity_id="sch-2",
            payload={"id": "sch-2", "title": "Stale"},
            client_updated_at="2026-07-01T00:00:00.000Z",
            expected_version=2,
        )
        request = entity_fixture.commands.from_sync_event(scope, event)
        with pytest.raises(MutationRejectedError) as exc_info:
            await entity_fixture.uow.execute(scope, request, "op-lww-local")
        assert exc_info.value.rejection.code == "version_conflict"
        assert exc_info.value.rejection.details.get("resolution") == "local"
    finally:
        await scope.aclose()
