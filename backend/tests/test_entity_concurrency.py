"""Tests for CAS and LWW concurrency resolution in the mutation pipeline.

Covers:
1. strict_cas rejects stale expected_version — no LWW fallback
2. timestamp_lww accepts remote-wins update when client is newer
3. timestamp_lww rejects local-wins update when client is older
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text

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


async def test_concurrent_writers_one_wins_one_version_conflict(
    entity_fixture: EntityFixture,
):
    """Real asyncio.gather dual-writer: exactly one succeeds, one gets version_conflict."""
    await entity_fixture.seed_schedule(
        "sch-race", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    lock = asyncio.Lock()
    scope_a = entity_fixture.open_concurrent_scope(lock)
    scope_b = entity_fixture.open_concurrent_scope(lock)

    async def writer_a():
        request = entity_fixture.commands.update(
            scope_a, "schedule", "sch-race", {"title": "Writer A"}, expected_version=1
        )
        return await entity_fixture.uow.execute(scope_a, request, "op-writer-a")

    async def writer_b():
        request = entity_fixture.commands.update(
            scope_b, "schedule", "sch-race", {"title": "Writer B"}, expected_version=1
        )
        return await entity_fixture.uow.execute(scope_b, request, "op-writer-b")

    results = await asyncio.gather(writer_a(), writer_b(), return_exceptions=True)

    successes = [r for r in results if not isinstance(r, BaseException)]
    failures = [r for r in results if isinstance(r, BaseException)]
    assert len(successes) == 1, f"Expected 1 success, got {len(successes)}"
    assert len(failures) == 1, f"Expected 1 failure, got {len(failures)}"
    assert isinstance(failures[0], MutationRejectedError)
    assert failures[0].rejection.code == "version_conflict"

    # Final durable version incremented exactly once
    async with entity_fixture._sessions() as session:
        result = await session.execute(
            text("SELECT version, title FROM schedules WHERE id = 'sch-race'")
        )
        row = result.fetchone()
    assert row is not None
    assert row[0] == 2, f"Expected version=2, got {row[0]}"
    assert row[1] in ("Writer A", "Writer B"), f"Unexpected title: {row[1]}"

    await scope_a.aclose()
    await scope_b.aclose()
