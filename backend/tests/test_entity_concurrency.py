"""Tests for CAS and LWW concurrency resolution in the mutation pipeline.

Covers:
1. strict_cas rejects stale expected_version — no LWW fallback
2. timestamp_lww accepts remote-wins update when client is newer
3. timestamp_lww rejects local-wins update when client is older
4. Real dual-writer asyncio.gather concurrency (one winner, one conflict)
5. LWW equal-timestamp: local wins
6. LWW unparseable authority timestamp: manual resolution
7. Expected version equal: no conflict (resolution=None)
8. strict_cas rejects even with newer client timestamp (no LWW fallback)
9. LWW remote wins writes durable FINALIZED receipt
10. Idempotent retry reads original receipt without re-execution
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text

from app.errors import MutationRejectedError
from app.mutation.types import MutationState
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
    # Fresh restart reads the original durable receipt — not recomputed.
    assert await entity_fixture.read_stored_resolution("op-lww-remote") == "remote"


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
    # Fresh restart reads the original durable receipt — not recomputed.
    assert await entity_fixture.read_stored_resolution("op-lww-local") == "local"


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

# --- Task 6: Comprehensive LWW/CAS evidence tests ---


async def test_lww_local_wins_when_client_timestamp_equal(entity_fixture: EntityFixture):
    """Equal client and authority timestamps: local wins (client is not newer)."""
    await entity_fixture.seed_schedule(
        "sch-eq", version=1, updated_at="2026-07-14T00:00:00.000Z"
    )
    outcome = await entity_fixture.execute_sync_update(
        "sch-eq",
        entity_type="schedule",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-lww-equal",
    )
    assert outcome.applied == ()
    assert len(outcome.rejected) == 1
    assert outcome.rejected[0].code == "version_conflict"
    assert outcome.rejected[0].details.get("resolution") == "local"


async def test_lww_manual_resolution_when_authority_timestamp_unparseable(
    entity_fixture: EntityFixture,
):
    """Unparseable authority timestamp: manual resolution required."""
    await entity_fixture.seed_schedule(
        "sch-manual", version=1, updated_at="not-a-timestamp"
    )
    outcome = await entity_fixture.execute_sync_update(
        "sch-manual",
        entity_type="schedule",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-lww-manual",
    )
    assert outcome.applied == ()
    assert len(outcome.rejected) == 1
    assert outcome.rejected[0].code == "version_conflict"
    assert outcome.rejected[0].details.get("resolution") == "manual"


async def test_expected_version_equal_returns_no_conflict(entity_fixture: EntityFixture):
    """Matching expected_version: no conflict, resolution is None."""
    await entity_fixture.seed_schedule(
        "sch-match", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    outcome = await entity_fixture.execute_sync_update(
        "sch-match",
        entity_type="schedule",
        expected_version=1,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-version-match",
    )
    assert len(outcome.applied) == 1
    assert outcome.rejected == ()
    assert outcome.applied[0].resolution is None


async def test_strict_cas_rejects_even_with_newer_client_timestamp(
    entity_fixture: EntityFixture,
):
    """strict_cas policy rejects stale version even when client timestamp is newer."""
    await entity_fixture.seed_strict_cas_entity(
        "strict-newer", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    outcome = await entity_fixture.execute_sync_update(
        "strict-newer",
        entity_type="strict_fixture",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-strict-newer",
    )
    assert outcome.applied == ()
    assert len(outcome.rejected) == 1
    assert outcome.rejected[0].code == "version_conflict"
    assert "resolution" not in outcome.rejected[0].details


async def test_lww_remote_wins_writes_durable_receipt(entity_fixture: EntityFixture):
    """LWW remote-wins update writes a durable FINALIZED receipt with resolution='remote'."""
    await entity_fixture.seed_schedule(
        "sch-durable", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    outcome = await entity_fixture.execute_sync_update(
        "sch-durable",
        entity_type="schedule",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-durable-remote",
    )
    assert len(outcome.applied) == 1
    assert outcome.applied[0].resolution == "remote"
    assert outcome.applied[0].state == MutationState.FINALIZED

    # Durable version incremented exactly once.
    async with entity_fixture._sessions() as session:
        result = await session.execute(
            text("SELECT version FROM schedules WHERE id = 'sch-durable'")
        )
        row = result.fetchone()
    assert row is not None
    assert row[0] == 2

    # Fresh restart reads the original durable receipt.
    assert await entity_fixture.read_stored_resolution("op-durable-remote") == "remote"


async def test_idempotent_retry_reads_original_receipt(entity_fixture: EntityFixture):
    """Re-executing the same operation_id returns the original receipt without re-execution."""
    await entity_fixture.seed_schedule(
        "sch-retry", version=1, updated_at="2026-07-01T00:00:00.000Z"
    )
    # First execution: succeeds, version becomes 2.
    first = await entity_fixture.execute_sync_update(
        "sch-retry",
        entity_type="schedule",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-retry-test",
    )
    assert len(first.applied) == 1
    assert first.applied[0].resolution == "remote"

    # Second execution with same operation_id: returns original receipt.
    second = await entity_fixture.execute_sync_update(
        "sch-retry",
        entity_type="schedule",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:00.000Z",
        operation_id="op-retry-test",
    )
    assert len(second.applied) == 1
    assert second.applied[0].resolution == "remote"

    # DB version still 2 — not incremented again.
    async with entity_fixture._sessions() as session:
        result = await session.execute(
            text("SELECT version FROM schedules WHERE id = 'sch-retry'")
        )
        row = result.fetchone()
    assert row is not None
    assert row[0] == 2
