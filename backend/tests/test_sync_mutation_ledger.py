"""Task 3 exactly-once and visible-ledger boundary tests."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.models.mutation import MutationBatch, MutationOperation
from app.models.sync_outbox import SyncOutbox
from app.services.sync_outbox import record_sync_event
from tests.test_entity_invariants import entity_fixture  # noqa: F401

UTC = "2026-08-05T10:00:00.000Z"


@pytest.mark.asyncio
async def test_ledger_event_is_visible_only_after_the_uow_finalizes(entity_fixture) -> None:
    from app.models.sync_client import SyncClient

    await entity_fixture.seed_schedule(
        "ledger-schedule", version=1, updated_at="2026-08-05T09:00:00.000Z"
    )
    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="ledger-client",
                ack_sequence=0,
                catalog_hash=entity_fixture.catalog.hash,
                registered_at=UTC,
                last_seen_at=UTC,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
    scope = entity_fixture.open_mutation_scope()
    try:
        from app.sync.contracts import SyncEventInput
        from app.sync.protocol import SyncProtocol

        result = await SyncProtocol(
            scope, entity_fixture.uow, catalog=entity_fixture.catalog
        ).push(
            "ledger-client",
            [
                SyncEventInput(
                    entity_type="schedule",
                    entity_id="ledger-schedule",
                    action="update",
                    payload={"title": "finalized"},
                    expected_version=1,
                    client_updated_at=UTC,
                    operation_id="ledger-op",
                )
            ],
            "ledger-batch",
        )
        assert [item.operation_id for item in result.applied] == ["ledger-op"]
        async with entity_fixture._sessions() as session:
            rows = tuple(
                await session.scalars(
                    select(SyncOutbox).where(SyncOutbox.batch_id == "ledger-batch")
                )
            )
        assert [(row.operation_id, row.visible) for row in rows] == [("ledger-op", True)]
    finally:
        await scope.aclose()


@pytest.mark.asyncio
async def test_mapper_pre_rejection_is_in_the_durable_batch_receipt(entity_fixture) -> None:
    from app.models.sync_client import SyncClient

    await entity_fixture.seed_schedule(
        "ledger-reject", version=1, updated_at="2026-08-05T09:00:00.000Z"
    )
    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="ledger-reject-client",
                ack_sequence=0,
                catalog_hash=entity_fixture.catalog.hash,
                registered_at=UTC,
                last_seen_at=UTC,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
    scope = entity_fixture.open_mutation_scope()
    try:
        from app.sync.contracts import SyncEventInput
        from app.sync.protocol import SyncProtocol

        result = await SyncProtocol(
            scope, entity_fixture.uow, catalog=entity_fixture.catalog
        ).push(
            "ledger-reject-client",
            [
                SyncEventInput(
                    entity_type="schedule",
                    entity_id="ledger-reject",
                    action="update",
                    payload={"title": "accepted"},
                    expected_version=1,
                    client_updated_at=UTC,
                    operation_id="ledger-accepted",
                ),
                SyncEventInput(
                    entity_type="not-sync-enabled",
                    entity_id="ledger-unknown",
                    action="create",
                    payload={},
                    expected_version=None,
                    client_updated_at=UTC,
                    operation_id="ledger-rejected",
                ),
            ],
            "ledger-mixed-batch",
        )
        assert [item.operation_id for item in result.applied] == ["ledger-accepted"]
        assert [item.operation_id for item in result.errors] == ["ledger-rejected"]
        async with entity_fixture._sessions() as session:
            assert await session.scalar(
                select(func.count()).select_from(MutationOperation).where(
                    MutationOperation.operation_id == "ledger-rejected"
                )
            ) == 0
            batch = await session.get(MutationBatch, "ledger-mixed-batch")
            assert batch is not None and "ledger-rejected" in (batch.result_json or "")
    finally:
        await scope.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("include_accepted", [False, True], ids=["all-rejected", "mixed"])
async def test_unknown_payload_field_has_durable_replayable_rejection(
    entity_fixture, include_accepted
) -> None:
    from app.models.sync_client import SyncClient

    await entity_fixture.seed_schedule(
        "unknown-field-target", version=1, updated_at="2026-08-05T09:00:00.000Z"
    )
    await entity_fixture.seed_schedule(
        "unknown-field-accepted", version=1, updated_at="2026-08-05T09:00:00.000Z"
    )
    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="unknown-field-client",
                ack_sequence=0,
                catalog_hash=entity_fixture.catalog.hash,
                registered_at=UTC,
                last_seen_at=UTC,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
    scope = entity_fixture.open_mutation_scope()
    try:
        from app.sync.contracts import SyncEventInput
        from app.sync.protocol import SyncProtocol

        rejected = SyncEventInput(
            entity_type="schedule",
            entity_id="unknown-field-target",
            action="update",
            payload={"title": "invalid", "unknown_field": "must reject"},
            expected_version=1,
            client_updated_at=UTC,
            operation_id=f"unknown-field-rejected-{include_accepted}",
        )
        events = [rejected]
        if include_accepted:
            events.insert(
                0,
                SyncEventInput(
                    entity_type="schedule",
                    entity_id="unknown-field-accepted",
                    action="update",
                    payload={"title": "accepted"},
                    expected_version=1,
                    client_updated_at=UTC,
                    operation_id="unknown-field-accepted",
                ),
            )
        protocol = SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog)
        batch_id = f"unknown-field-batch-{include_accepted}"
        result = await protocol.push("unknown-field-client", events, batch_id)

        assert [item.operation_id for item in result.applied] == (
            ["unknown-field-accepted"] if include_accepted else []
        )
        assert result.conflicts == ()
        assert [(item.operation_id, item.code) for item in result.errors] == [
            (rejected.operation_id, "payload_field_not_allowed")
        ]
        assert await protocol.push("unknown-field-client", events, batch_id) == result
        queried = await protocol.query_operations(
            "unknown-field-client", [event.operation_id for event in events]
        )
        assert all(item.state == "terminal" for item in queried.items)
        assert all(item.result == result for item in queried.items)
    finally:
        await scope.aclose()


@pytest.mark.asyncio
async def test_rolled_back_ledger_append_is_not_visible(space_session) -> None:
    with pytest.raises(RuntimeError, match="abort"):
        async with space_session.begin():
            await record_sync_event(
                space_session,
                entity_type="schedule",
                entity_id="rolled-back",
                action="create",
                payload={"id": "rolled-back", "title": "never visible"},
                operation_id="rolled-back-op",
                batch_id="rolled-back-batch",
                version=1,
                created_at=UTC,
                visible=True,
            )
            raise RuntimeError("abort")

    assert await space_session.scalar(
        select(func.count()).select_from(SyncOutbox).where(
            SyncOutbox.operation_id == "rolled-back-op"
        )
    ) == 0
