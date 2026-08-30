"""Wave 2C B: FocusSession offline provisional import through real Sync push.

Reproduces exactly what the browser outbox sends for an offline
start -> pause -> resume -> end session: a compound create batch of the
four provisional entities followed by standalone clock updates.  The
full chain must land in SQL and be readable via FocusSessionQuery.load.
"""

from __future__ import annotations

import pytest

from app.focus_session.policy import FocusSessionMutationPolicy
from app.sync.contracts import SyncEventInput
from app.sync.protocol import SyncProtocol

STARTED = "2026-07-15T08:00:00.000Z"
PAUSED = "2026-07-15T08:05:00.000Z"
RESUMED = "2026-07-15T08:06:00.000Z"
ENDED = "2026-07-15T08:10:00.000Z"
SESSION_ID = "fs-offline-1"
OPERATION_ID = "op-offline-import"


def _locator_reader(_scope, request):
    payload = request.payload
    return {
        "state": "claiming",
        "space_id": payload.get("space_id", "space-test"),
        "session_id": payload.get("session_id", request.entity_id),
        "operation_id": payload.get("command_id", request.entity_id),
        "owner_device_id": payload.get("owner_device_id"),
        "owner_tab_id": payload.get("owner_tab_id"),
        "ownership_epoch": payload.get("ownership_epoch"),
    }


def _session_row(*, ended_at=None, pause_started_at=None, gross_seconds=0,
                 paused_seconds=0, focused_seconds=0, updated_at=STARTED,
                 validity="pending", review_state="not_required",
                 timer_completion=None, version=0, session_revision=1):
    return {
        "id": SESSION_ID,
        "created_at": STARTED,
        "updated_at": updated_at,
        "version": version,
        "session_revision": session_revision,
        "started_at": STARTED,
        "ended_at": ended_at,
        "pause_started_at": pause_started_at,
        "planned_seconds": 1500,
        "gross_seconds": gross_seconds,
        "paused_seconds": paused_seconds,
        "break_seconds": 0,
        "focused_seconds": focused_seconds,
        "timer_completion": timer_completion,
        "validity": validity,
        "validity_reason": None,
        "overall_progress": None,
        "mood": None,
        "session_note": "",
        "review_state": review_state,
        "ownership_state": "local_provisional",
    }


def _context_row():
    return {
        "id": f"ctx-{SESSION_ID}",
        "created_at": STARTED,
        "updated_at": STARTED,
        "version": 0,
        "session_id": SESSION_ID,
        "project_id": "proj-1",
        "level2_work_item_id": "l2-a",
        "title_snapshot": "Level 2",
        "parent_snapshot": None,
        "estimate_snapshot": None,
        "status_snapshot": None,
        "structure_snapshot": "{}",
        "linked_at": STARTED,
        "link_method": "manual",
    }


def _attribution_row():
    return {
        "id": f"attr-{SESSION_ID}-1",
        "created_at": STARTED,
        "updated_at": STARTED,
        "version": 0,
        "session_id": SESSION_ID,
        "revision": 1,
        "project_id": "proj-1",
        "level2_work_item_id": "l2-a",
        "reason": None,
        "corrected_from_revision": None,
        "effective": True,
    }


def _create_events():
    return [
        SyncEventInput(
            entity_type="focusSession", entity_id=SESSION_ID, action="create",
            payload=_session_row(), expected_version=None,
            client_updated_at=STARTED, operation_id=f"{OPERATION_ID}:fs",
        ),
        SyncEventInput(
            entity_type="sessionTaskContext", entity_id=f"ctx-{SESSION_ID}",
            action="create", payload=_context_row(), expected_version=None,
            client_updated_at=STARTED, operation_id=f"{OPERATION_ID}:ctx",
        ),
        SyncEventInput(
            entity_type="sessionAttributionRevision",
            entity_id=f"attr-{SESSION_ID}-1", action="create",
            payload=_attribution_row(), expected_version=None,
            client_updated_at=STARTED, operation_id=f"{OPERATION_ID}:attr",
        ),
    ]


def _clock_events():
    # The browser provisional clock increments session_revision on every clock
    # action (start=1, pause=2, resume=3, end=4) and carries the new value in
    # the post-image.  The server must not treat it as an immutable field.
    pause = _session_row(
        pause_started_at=PAUSED, gross_seconds=300, paused_seconds=0,
        focused_seconds=300, updated_at=PAUSED, version=1, session_revision=2,
    )
    resume = _session_row(
        pause_started_at=None, gross_seconds=360, paused_seconds=60,
        focused_seconds=300, updated_at=RESUMED, version=2, session_revision=3,
    )
    end = _session_row(
        ended_at=ENDED, pause_started_at=None, gross_seconds=600,
        paused_seconds=60, focused_seconds=540, updated_at=ENDED,
        validity="pending", review_state="pending",
        timer_completion="ended_early", version=3, session_revision=4,
    )
    return [
        SyncEventInput(
            entity_type="focusSession", entity_id=SESSION_ID, action="update",
            payload=pause, expected_version=1, client_updated_at=PAUSED,
            operation_id=f"{OPERATION_ID}:pause",
        ),
        SyncEventInput(
            entity_type="focusSession", entity_id=SESSION_ID, action="update",
            payload=resume, expected_version=2, client_updated_at=RESUMED,
            operation_id=f"{OPERATION_ID}:resume",
        ),
        SyncEventInput(
            entity_type="focusSession", entity_id=SESSION_ID, action="update",
            payload=end, expected_version=3, client_updated_at=ENDED,
            operation_id=f"{OPERATION_ID}:end",
        ),
    ]


@pytest.mark.asyncio
async def test_offline_provisional_create_batch_applies_to_sql(mutation_fixture_factory) -> None:
    from app.models.sync_client import SyncClient

    policy = FocusSessionMutationPolicy(locator_reader=_locator_reader)
    mutation = mutation_fixture_factory(policies=(policy,))
    async with mutation._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="client-offline",
                ack_sequence=0,
                catalog_hash=mutation.catalog.hash,
                registered_at=STARTED,
                last_seen_at=STARTED,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)
    result = await protocol.push("client-offline", _create_events(), f"batch-{OPERATION_ID}-create")
    assert [item.operation_id for item in result.applied] == [
        f"{OPERATION_ID}:fs", f"{OPERATION_ID}:ctx", f"{OPERATION_ID}:attr",
    ]
    assert result.errors == ()

    from sqlalchemy import select

    from app.models.focus_session import FocusSession

    async with mutation._sessions() as session:
        row = (await session.execute(
            select(FocusSession).where(FocusSession.id == SESSION_ID)
        )).scalar_one_or_none()
    assert row is not None
    assert row.version == 1


@pytest.mark.asyncio
async def test_offline_clock_updates_follow_create_version_chain(mutation_fixture_factory) -> None:
    from app.models.sync_client import SyncClient

    policy = FocusSessionMutationPolicy(locator_reader=_locator_reader)
    mutation = mutation_fixture_factory(policies=(policy,))
    async with mutation._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="client-offline-chain",
                ack_sequence=0,
                catalog_hash=mutation.catalog.hash,
                registered_at=STARTED,
                last_seen_at=STARTED,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)
    created = await protocol.push(
        "client-offline-chain", _create_events(), f"batch-{OPERATION_ID}-create2",
    )
    assert created.errors == ()
    updated = await protocol.push(
        "client-offline-chain", _clock_events(), f"batch-{OPERATION_ID}-clock",
    )
    assert updated.errors == ()
    assert [item.operation_id for item in updated.applied] == [
        f"{OPERATION_ID}:pause", f"{OPERATION_ID}:resume", f"{OPERATION_ID}:end",
    ]

    from sqlalchemy import select

    from app.focus_session.query import FocusSessionQuery
    from app.models.focus_session import FocusSession

    async with mutation._sessions() as session:
        row = (await session.execute(
            select(FocusSession).where(FocusSession.id == SESSION_ID)
        )).scalar_one_or_none()
        assert row is not None
        assert row.version == 4
        assert row.ended_at == ENDED

    from app.focus_session.module import focus_session_view

    aggregate = await FocusSessionQuery().load(mutation.scope, SESSION_ID)
    view = focus_session_view(aggregate)
    assert view["session"]["clockState"] == "ended"
    assert view["session"]["id"] == SESSION_ID
