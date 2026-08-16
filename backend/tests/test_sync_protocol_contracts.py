from __future__ import annotations

import hashlib
import json
import re
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.fixtures.sync_domain_policy_cases import sync_domain_policy_cases
from tests.test_entity_invariants import entity_fixture  # noqa: F401

UTC = "2026-08-05T10:00:00.000Z"


def _event(**overrides):
    value = {
        "entity_type": "schedule",
        "entity_id": "schedule-1",
        "action": "create",
        "payload": {"id": "schedule-1", "title": "Ship"},
        "expected_version": None,
        "client_updated_at": UTC,
        "operation_id": "op-1",
    }
    value.update(overrides)
    return value


def _sized_event(target_bytes: int, index: int = 0):
    """Build a canonical event with an exact RFC 8785 byte length."""
    from app.sync.contracts import SyncEventInput, canonical_sync_event_bytes

    raw = _event(
        entity_id=f"boundary-entity-{index:03d}",
        operation_id=f"boundary-op-{index:03d}",
        payload={"blob": ""},
    )
    low, high = 0, target_bytes
    result = None
    while low <= high:
        size = (low + high) // 2
        candidate = SyncEventInput.from_mapping(
            {**raw, "payload": {"blob": "x" * size}}
        )
        actual = len(canonical_sync_event_bytes(candidate))
        if actual <= target_bytes:
            result = candidate
            low = size + 1
        else:
            high = size - 1
    assert result is not None
    assert len(canonical_sync_event_bytes(result)) == target_bytes
    return result


def test_sync_contracts_reject_bool_and_unsafe_versions() -> None:
    from app.sync.contracts import SyncEventInput

    for invalid in (True, 2**53, -1, "1"):
        with pytest.raises(ValueError):
            SyncEventInput(**_event(expected_version=invalid))


def test_sync_contracts_reject_noncanonical_utc() -> None:
    from app.sync.contracts import SyncEventInput

    for timestamp in (
        "2026-08-05T10:00:00+00:00",
        "2026-08-05t10:00:00.000Z",
        "2026-02-30T10:00:00.000Z",
    ):
        with pytest.raises(ValueError):
            SyncEventInput(**_event(client_updated_at=timestamp))


def test_decode_sync_i_json_rejects_duplicate_nested_keys() -> None:
    from app.sync.contracts import SyncInputError, decode_sync_i_json

    with pytest.raises(SyncInputError) as raised:
        decode_sync_i_json(
            b'{"events":[{"entity_type":"schedule","payload":{"x":1,"x":2}}]}',
            max_bytes=1024,
        )
    assert raised.value.code == "duplicate_object_key"


def test_sync_event_parser_rejects_unexpected_fields_and_non_mapping_items() -> None:
    from app.sync.contracts import SyncInputError, parse_sync_event_batch

    with pytest.raises(SyncInputError) as unexpected:
        parse_sync_event_batch(
            {"events": [_event(unexpected="nope")]},
        )
    assert unexpected.value.code == "invalid_event"

    with pytest.raises(SyncInputError) as non_mapping:
        parse_sync_event_batch({"events": ["not-an-event"]})
    assert non_mapping.value.code == "invalid_event"

    with pytest.raises(SyncInputError) as unsafe:
        parse_sync_event_batch({"events": [_event(payload={"n": 2**53})]})
    assert unsafe.value.code == "unsafe_integer"


def test_direct_push_validation_enforces_canonical_event_and_batch_budgets() -> None:
    from app.sync.contracts import SyncEventInput, SyncInputError, validate_sync_push_inputs

    event = SyncEventInput(**_event(payload={"title": "large enough"}))
    with pytest.raises(SyncInputError) as event_error:
        validate_sync_push_inputs(
            "client-a",
            "batch-a",
            [event],
            max_event_bytes=1,
        )
    assert event_error.value.code == "event_payload_too_large"

    with pytest.raises(SyncInputError) as batch_error:
        validate_sync_push_inputs(
            "client-a",
            "batch-a",
            [event],
            max_batch_bytes=1,
        )
    assert batch_error.value.code == "sync_batch_too_large"


def test_batch_budget_counts_canonical_array_framing() -> None:
    from app.sync.contracts import (
        SyncEventInput,
        SyncInputError,
        canonical_sync_batch_bytes,
        validate_sync_push_inputs,
    )

    events = tuple(
        SyncEventInput(
            **_event(
                entity_id=f"schedule-{index}",
                operation_id=f"batch-op-{index}",
                payload={"id": f"schedule-{index}", "title": "x"},
            )
        )
        for index in range(2)
    )
    exact = len(canonical_sync_batch_bytes(events))
    validate_sync_push_inputs("client-a", "batch-a", events, max_batch_bytes=exact)
    with pytest.raises(SyncInputError) as raised:
        validate_sync_push_inputs("client-a", "batch-a", events, max_batch_bytes=exact - 1)
    assert raised.value.code == "sync_batch_too_large"


def test_sync_event_and_batch_budgets_accept_exact_bytes_and_reject_plus_one() -> None:
    from app.sync.contracts import (
        MAX_CANONICAL_BATCH_BYTES,
        MAX_EVENT_PAYLOAD_BYTES,
        SyncInputError,
        canonical_sync_batch_bytes,
        validate_sync_push_inputs,
    )

    exact_event = _sized_event(MAX_EVENT_PAYLOAD_BYTES)
    plus_one_event = _sized_event(MAX_EVENT_PAYLOAD_BYTES + 1)
    validate_sync_push_inputs("client-a", "event-boundary", [exact_event])
    with pytest.raises(SyncInputError) as event_error:
        validate_sync_push_inputs("client-a", "event-boundary", [plus_one_event])
    assert event_error.value.code == "event_payload_too_large"

    full_event = _sized_event(MAX_EVENT_PAYLOAD_BYTES)
    full_events = tuple(
        replace(full_event, operation_id=f"boundary-op-{index:03d}", entity_id=f"boundary-entity-{index:03d}")
        for index in range(39)
    )
    last_target = MAX_CANONICAL_BATCH_BYTES - (39 * MAX_EVENT_PAYLOAD_BYTES + 41)
    exact_last = _sized_event(last_target, 39)
    exact_batch = (*full_events, exact_last)
    assert len(canonical_sync_batch_bytes(exact_batch)) == MAX_CANONICAL_BATCH_BYTES
    validate_sync_push_inputs("client-a", "batch-boundary", exact_batch)

    plus_one_batch = (*full_events, _sized_event(last_target + 1, 39))
    assert len(canonical_sync_batch_bytes(plus_one_batch)) == MAX_CANONICAL_BATCH_BYTES + 1
    with pytest.raises(SyncInputError) as batch_error:
        validate_sync_push_inputs("client-a", "batch-boundary", plus_one_batch)
    assert batch_error.value.code == "sync_batch_too_large"


def test_sync_event_record_from_row_fails_closed_on_duplicate_or_malformed_payload() -> None:
    from types import SimpleNamespace

    from app.sync.contracts import SyncEventRecord, SyncLedgerIntegrityError

    row = SimpleNamespace(
        operation_id="ledger-op",
        batch_id="ledger-batch",
        entity_type="schedule",
        entity_id="schedule-1",
        action="create",
        version=1,
        created_at=UTC,
        payload='{"nested":{"key":1,"key":2}}',
    )
    with pytest.raises(SyncLedgerIntegrityError):
        SyncEventRecord.from_row(row)
    row.payload = "not-json"
    with pytest.raises(SyncLedgerIntegrityError):
        SyncEventRecord.from_row(row)


@pytest.mark.asyncio
async def test_protocol_pull_escalates_malformed_visible_ledger_to_recovery(entity_fixture) -> None:
    from app.errors import SpaceRecoveryRequiredError
    from app.models.sync_client import SyncClient
    from app.models.sync_outbox import SyncOutbox
    from app.sync.protocol import SyncProtocol

    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="ledger-integrity-client",
                ack_sequence=0,
                catalog_hash=entity_fixture.catalog.hash,
                registered_at=UTC,
                last_seen_at=UTC,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
        session.add(
            SyncOutbox(
                entity_type="schedule",
                entity_id="ledger-corrupt",
                action="create",
                payload='{"key":1,"key":2}',
                operation_id="ledger-corrupt-op",
                batch_id="ledger-corrupt-batch",
                version=1,
                created_at=UTC,
                visible=True,
            )
        )

    scope = entity_fixture.open_mutation_scope()
    try:
        with pytest.raises(SpaceRecoveryRequiredError):
            await SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog).pull(
                "ledger-integrity-client", None, 10
            )
    finally:
        await scope.aclose()


@pytest.mark.asyncio
async def test_bounded_pull_defers_full_envelope_boundary_event(entity_fixture) -> None:
    import json

    from app.services.sync_outbox import record_sync_event
    from app.sync.contracts import (
        PullPageEnvelope,
        SyncEventRecord,
        canonical_contract_bytes,
    )
    from app.sync.cursor import SyncCursorCodec
    from app.sync.protocol import read_visible_event_page_bounded

    codec = SyncCursorCodec(b"envelope-boundary-secret-0123456789")
    envelope = PullPageEnvelope(
        codec, entity_fixture.catalog.hash, "space-test", "envelope-client", 0
    )
    async with entity_fixture._sessions.begin() as session:
        first = await record_sync_event(
            session,
            entity_type="workItem",
            entity_id="envelope-first",
            action="create",
            payload={"id": "envelope-first", "title": "first"},
            operation_id="envelope-op-1",
            batch_id="envelope-batch",
            version=1,
            created_at=UTC,
            visible=True,
        )
        second = await record_sync_event(
            session,
            entity_type="workItemNote",
            entity_id="envelope-second",
            action="update",
            payload={"blob": ""},
            operation_id="envelope-op-2",
            batch_id="envelope-batch",
            version=1,
            created_at=UTC,
            visible=True,
        )
        await session.flush()
        first_record = SyncEventRecord.from_row(first)
        target = 4097
        low, high = 0, target
        blob_size = None
        while low <= high:
            size = (low + high) // 2
            candidate = SyncEventRecord(
                "envelope-op-2",
                "envelope-batch",
                "workItemNote",
                "envelope-second",
                "update",
                {"blob": "x" * size},
                1,
                UTC,
            )
            candidate_wire = {
                "events": [first_record, candidate],
                "next_cursor": envelope.cursor_for(second.id),
                "has_more": False,
                "catalog_hash": entity_fixture.catalog.hash,
            }
            actual = len(canonical_contract_bytes(candidate_wire))
            if actual <= target:
                blob_size = size
                low = size + 1
            else:
                high = size - 1
        assert blob_size is not None
        candidate = SyncEventRecord(
            "envelope-op-2",
            "envelope-batch",
            "workItemNote",
            "envelope-second",
            "update",
            {"blob": "x" * blob_size},
            1,
            UTC,
        )
        assert len(
            canonical_contract_bytes(
                {
                    "events": [first_record, candidate],
                    "next_cursor": envelope.cursor_for(second.id),
                    "has_more": False,
                    "catalog_hash": entity_fixture.catalog.hash,
                }
            )
        ) == target
        second.payload = json.dumps(
            {"blob": "x" * blob_size}, ensure_ascii=False, sort_keys=True
        )

    async with entity_fixture._sessions() as session:
        first_page = (
            await read_visible_event_page_bounded(
                session,
                after_sequence=0,
                max_events=500,
                page_envelope=envelope,
                max_canonical_page_bytes=target - 1,
            )
        ).page
        assert [event.operation_id for event in first_page.events] == ["envelope-op-1"]
        assert first_page.has_more is True
        second_page = (
            await read_visible_event_page_bounded(
                session,
                after_sequence=first.id,
                max_events=500,
                page_envelope=envelope,
                max_canonical_page_bytes=target - 1,
            )
        ).page
        assert [event.operation_id for event in second_page.events] == ["envelope-op-2"]


@pytest.mark.asyncio
async def test_opaque_pull_pages_interleaved_catalog_events_exactly_once(entity_fixture) -> None:
    from app.models.sync_client import SyncClient
    from app.services.sync_outbox import record_sync_event
    from app.sync.protocol import SyncProtocol

    events = (
        ("workItem", "create"),
        ("workItemNote", "update"),
        ("focusSession", "create"),
        ("note", "update"),
        ("tombstone", "delete"),
        ("workItem", "update"),
        ("workItemNote", "delete"),
    )
    async with entity_fixture._sessions.begin() as session:
        for page_size in range(1, 8):
            session.add(
                SyncClient(
                    client_id=f"interleave-{page_size}",
                    ack_sequence=0,
                    catalog_hash=entity_fixture.catalog.hash,
                    registered_at=UTC,
                    last_seen_at=UTC,
                    expires_at="2099-08-05T00:00:00.000Z",
                    requires_recovery=False,
                    recovery_generation=0,
                )
            )
        for index, (entity_type, action) in enumerate(events):
            entity_id = f"interleave-{index}"
            await record_sync_event(
                session,
                entity_type=entity_type,
                entity_id=entity_id,
                action=action,
                payload={} if action == "delete" else {"id": entity_id, "index": index},
                operation_id=f"interleave-op-{index}",
                batch_id="interleave-batch",
                version=index + 1,
                created_at=f"2026-08-05T10:00:0{index}.000Z",
                visible=True,
            )

    scope = entity_fixture.open_mutation_scope()
    try:
        protocol = SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog)
        expected = [f"interleave-op-{index}" for index in range(len(events))]
        for page_size in range(1, 8):
            cursor = None
            actual = []
            while True:
                page = await protocol.pull(
                    f"interleave-{page_size}", cursor, page_size
                )
                actual.extend(event.operation_id for event in page.events)
                if not page.has_more:
                    break
                cursor = page.next_cursor
            assert actual == expected
            assert len(actual) == len(set(actual))
    finally:
        await scope.aclose()


def test_sync_canonical_vectors_match_rfc8785_bytes() -> None:
    from app.sync.contracts import SyncEventInput, canonical_sync_event_bytes

    vectors = json.loads(
        (Path(__file__).parent / "fixtures" / "sync_event_canonical_vectors.json").read_text(
            encoding="utf-8"
        )
    )
    for vector in vectors:
        payload = canonical_sync_event_bytes(SyncEventInput.from_mapping(vector["event"]))
        assert len(payload) == vector["canonicalBytes"]
        assert payload.decode("utf-8") == vector["canonicalUtf8"]
        assert hashlib.sha256(payload).hexdigest() == vector["sha256"]


def test_page_token_uses_opaque_cursor_byte_bounds() -> None:
    from app.sync.contracts import validate_page_token

    assert validate_page_token("a" * 16) == "a" * 16
    assert validate_page_token("b" * 2048) == "b" * 2048
    for invalid in ("a" * 15, "b" * 2049, "\u00e9" * 16, " a" * 8):
        with pytest.raises(ValueError):
            validate_page_token(invalid)


def test_batch_id_accepts_the_shared_printable_ascii_contract() -> None:
    from app.sync.contracts import validate_batch_id

    assert validate_batch_id("!batch/1?~") == "!batch/1?~"


def test_domain_policy_fixture_is_catalog_wide_and_wire_parseable() -> None:
    from app.sync.contracts import SyncEventInput

    cases = sync_domain_policy_cases()
    assert {case.policy_owner for case in cases} == {
        "generic", "task_space", "focus_session"
    }
    assert {
        case.event["entity_type"]
        for case in cases
        if case.policy_owner != "generic"
    } >= {
        "workItem", "workItemNote", "focusSession", "sessionTaskContext",
        "sessionAttributionRevision", "sessionWorkItemPlan", "sessionWorkItemOutcome",
    }
    for case in cases:
        SyncEventInput.from_mapping(case.event)

    assert {
        case.authoritative_running_operation
        for case in cases
        if case.authoritative_running_operation is not None
    } == {
        "session_note",
        "current_item",
        "completion_draft",
        "plan_add",
        "plan_remove",
    }


@pytest.mark.parametrize(
    "case",
    tuple(
        case
        for case in sync_domain_policy_cases()
        if case.authoritative_running_operation is not None
    ),
    ids=lambda case: case.name,
)
@pytest.mark.asyncio
async def test_sync_cannot_bypass_authoritative_active_session_owner(
    mutation_fixture_factory, monkeypatch, case
) -> None:
    from sqlalchemy import func, select

    import app.mutation.unit_of_work as mutation_uow
    from app.focus_session.policy import FocusSessionMutationPolicy
    from app.models.focus_session import FocusSession
    from app.models.mutation import MutationOperation, MutationStep
    from app.models.session_revision import SessionWorkItemPlan
    from app.models.sync_client import SyncClient
    from app.models.sync_outbox import SyncOutbox
    from app.sync.contracts import SyncEventInput
    from app.sync.protocol import SyncProtocol

    def locator_reader(_scope, request):
        raise AssertionError(
            f"Sync owner rejection consulted coordinator locator: {request.entity_id}"
        )

    policy = FocusSessionMutationPolicy(locator_reader=locator_reader)
    policy_calls = []
    original_policy_compile = policy.compile

    async def track_policy_call(context, request):
        policy_calls.append((request.entity_type, request.name))
        return await original_policy_compile(context, request)

    monkeypatch.setattr(policy, "compile", track_policy_call)
    mutation = mutation_fixture_factory(policies=(policy,))
    async with mutation._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="authoritative-observer",
                ack_sequence=0,
                catalog_hash=mutation.catalog.hash,
                registered_at="2026-08-05T09:00:00.000Z",
                last_seen_at="2026-08-05T09:00:00.000Z",
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
        session.add(
            FocusSession(
                id="authoritative-session",
                created_at="2026-08-05T09:00:00.000Z",
                updated_at="2026-08-05T09:00:00.000Z",
                version=1,
                session_revision=1,
                started_at="2026-08-05T09:00:00.000Z",
                ended_at=None,
                pause_started_at=None,
                planned_seconds=1500,
                gross_seconds=0,
                paused_seconds=0,
                break_seconds=0,
                focused_seconds=0,
                validity="pending",
                review_state="not_required",
                ownership_state="authoritative",
                session_note="authoritative note",
            )
        )
        session.add(
            SessionWorkItemPlan(
                id="authoritative-plan",
                created_at="2026-08-05T09:00:00.000Z",
                updated_at="2026-08-05T09:00:00.000Z",
                version=1,
                session_id="authoritative-session",
                work_item_id="work-item-current",
                title_snapshot="Current item",
                level2_snapshot="level-2",
                work_item_version_snapshot=1,
                plan_rank=0,
                source="before_start",
                added_at="2026-08-05T09:00:00.000Z",
                removed_at=None,
                removal_reason=None,
                current_during_session=False,
                completion_draft=False,
            )
        )

    before = mutation.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("FocusSession Sync event reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    event = SyncEventInput.from_mapping(case.event)
    result = await SyncProtocol(
        mutation.scope, mutation.uow, catalog=mutation.catalog
    ).push("authoritative-observer", [event], f"batch-{case.name}")

    assert result.applied == ()
    assert result.conflicts == ()
    assert [(item.operation_id, item.code) for item in result.errors] == [
        (event.operation_id, "stale_session_owner")
    ]
    assert result.errors[0].details["reason"] == "authoritative_session"
    expected_entity_type = (
        "focus_session"
        if case.authoritative_running_operation == "session_note"
        else "session_work_item_plan"
    )
    expected_request_name = (
        "entity.create"
        if case.authoritative_running_operation == "plan_add"
        else "entity.update"
    )
    assert policy_calls == [(expected_entity_type, expected_request_name)]
    assert mutation.overlay_snapshot() == before
    assert await mutation.visible_events() == ()
    async with mutation._sessions() as session:
        assert await session.scalar(select(func.count()).select_from(MutationOperation)) == 0
        assert await session.scalar(select(func.count()).select_from(MutationStep)) == 0
        assert await session.scalar(select(func.count()).select_from(SyncOutbox)) == 0


@pytest.mark.parametrize(
    "case",
    tuple(case for case in sync_domain_policy_cases() if case.policy_owner == "task_space"),
    ids=lambda case: case.name,
)
@pytest.mark.asyncio
async def test_sync_mapper_cases_reach_registered_task_space_policy(
    task_space_fixture, monkeypatch, case
) -> None:
    import app.mutation.unit_of_work as mutation_uow
    from app.errors import MutationRejectedError
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    raw = dict(case.event)
    if raw["entity_type"] == "workItemNote":
        note = await task_space_fixture.seed_note("sync-domain-policy")
        raw["entity_id"] = str(note["id"])
        raw["expected_version"] = int(note["version"])
    event = SyncEventInput.from_mapping(raw)
    request = SyncCommandMapper(
        task_space_fixture.catalog, task_space_fixture.entity_commands
    ).to_request(task_space_fixture.scope, event)

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("registered Task Space entity reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as raised:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, event.operation_id
        )
    assert raised.value.rejection.code == case.expected_error_code
    assert await task_space_fixture.visible_events(operation_id=event.operation_id) == ()


def test_mapper_propagates_expected_version_and_client_timestamp() -> None:
    from app.commands.entity import EntityCommand
    from app.registry import CATALOG
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    class Scope:
        pass

    event = SyncEventInput(
        **_event(
            action="update",
            expected_version=7,
            client_updated_at="2026-08-05T10:00:00.123456Z",
            payload={"title": "new"},
        )
    )
    request = SyncCommandMapper(CATALOG, EntityCommand(CATALOG)).to_request(
        Scope(), event
    )
    assert request.expected_version == 7
    assert request.client_updated_at == event.client_updated_at
    assert request.entity_id == event.entity_id


@pytest.mark.asyncio
async def test_sync_mapper_rejects_create_for_authoritative_tombstone(
    entity_fixture,
) -> None:
    from app.errors import MutationRejectedError
    from app.models.tombstone import Tombstone
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    async with entity_fixture._sessions.begin() as session:
        session.add(
            Tombstone(
                entity_type="schedule",
                entity_id="deleted-schedule",
                deleted_at=UTC,
                delete_sequence=1,
            )
        )

    event = SyncEventInput(
        **_event(
            entity_id="deleted-schedule",
            operation_id="tombstone-create-op",
            payload={
                "id": "deleted-schedule",
                "title": "Resurrected",
                "due_at": "2026-08-07T10:00:00.000Z",
            },
        )
    )
    scope = entity_fixture.open_mutation_scope()
    try:
        request = SyncCommandMapper(
            entity_fixture.catalog, entity_fixture.commands
        ).to_request(scope, event)
        with pytest.raises(MutationRejectedError) as raised:
            await entity_fixture.uow.execute(scope, request, event.operation_id)
    finally:
        await scope.aclose()

    assert raised.value.rejection.code == "tombstone_conflict"
    assert raised.value.rejection.details["resolution"] == "tombstone"


def test_mapper_normalizes_catalog_json_fields_for_database_storage() -> None:
    from app.commands.entity import EntityCommand
    from app.registry import CATALOG
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    event = SyncEventInput(
        **_event(
            entity_type="quickNote",
            payload={"content": "capture", "tags": ["sync", "array"]},
        )
    )
    request = SyncCommandMapper(CATALOG, EntityCommand(CATALOG)).to_request(None, event)
    assert request.payload["tags"] == '["sync","array"]'
    assert event.payload["tags"] == ("sync", "array")

    string_event = SyncEventInput(
        **_event(
            entity_type="quickNote",
            entity_id="quick-string",
            operation_id="quick-string-op",
            payload={"content": "capture", "tags": "9007199254740992"},
        )
    )
    string_request = SyncCommandMapper(
        CATALOG, EntityCommand(CATALOG)
    ).to_request(None, string_event)
    assert string_request.payload["tags"] == '"9007199254740992"'


def test_sync_wire_payload_rejects_json_that_decodes_to_unsafe_i_json() -> None:
    from app.errors import SpaceRecoveryRequiredError
    from app.mutation.unit_of_work import _sync_wire_payload
    from app.registry import CATALOG

    spec = CATALOG.get_by_sync_key("quickNote")
    with pytest.raises(SpaceRecoveryRequiredError):
        _sync_wire_payload(spec, {"tags": "9007199254740992"})


@pytest.mark.asyncio
@pytest.mark.parametrize("second_action", ["create", "update"])
async def test_same_batch_delete_blocks_resurrection(
    entity_fixture, second_action: str
) -> None:
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    entity_id = f"same-batch-{second_action}"
    await entity_fixture.seed_schedule(
        entity_id,
        version=1,
        updated_at="2026-08-05T10:00:00.000Z",
    )
    delete_event = SyncEventInput(
        **_event(
            entity_id=entity_id,
            action="delete",
            payload={},
            expected_version=1,
            operation_id=f"{entity_id}-delete",
        )
    )
    second_event = SyncEventInput(
        **_event(
            entity_id=entity_id,
            action=second_action,
            payload=(
                {
                    "id": entity_id,
                    "title": "Resurrected",
                    "due_at": "2026-08-07T10:00:00.000Z",
                }
                if second_action == "create"
                else {"title": "Resurrected"}
            ),
            expected_version=None if second_action == "create" else 1,
            operation_id=f"{entity_id}-{second_action}",
        )
    )
    mapper = SyncCommandMapper(entity_fixture.catalog, entity_fixture.commands)
    scope = entity_fixture.open_mutation_scope()
    try:
        result = await entity_fixture.uow.execute_batch(
            scope,
            (mapper.to_request(scope, delete_event), mapper.to_request(scope, second_event)),
            f"{entity_id}-batch",
            operation_ids=(delete_event.operation_id, second_event.operation_id),
        )
    finally:
        await scope.aclose()

    assert [item.operation_id for item in result.applied] == [delete_event.operation_id]
    assert [item.operation_id for item in result.rejected] == [second_event.operation_id]
    assert result.rejected[0].code == "tombstone_conflict"
    assert result.rejected[0].details["resolution"] == "tombstone"


def test_mapper_partitions_unknown_entity_as_durable_pre_rejection() -> None:
    from app.commands.entity import EntityCommand
    from app.registry import CATALOG
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    event = SyncEventInput(**_event(entity_type="not-sync-enabled"))
    mapped = SyncCommandMapper(CATALOG, EntityCommand(CATALOG)).partition(None, [event])
    assert mapped.items[0].request is None
    assert mapped.items[0].pre_rejection is not None
    assert mapped.items[0].pre_rejection.code == "entity_not_sync_enabled"
    assert re.fullmatch(r"[0-9a-f]{64}", mapped.items[0].intent_hash)


def test_push_result_maps_interleaved_receipt_in_input_order() -> None:
    from app.mutation.types import MutationRejection, MutationResult, MutationState
    from app.sync.contracts import PushResult, SyncEventInput

    events = tuple(
        SyncEventInput(
            **_event(
                entity_id=f"schedule-{index}",
                operation_id=f"op-{index}",
                payload={"id": f"schedule-{index}", "title": "x"},
            )
        )
        for index in range(3)
    )
    applied = (
        MutationResult(
            "op-2", "batch-1", "schedule", "schedule-2", 1, None,
            MutationState.FINALIZED, {"id": "schedule-2"},
        ),
        MutationResult(
            "op-0", "batch-1", "schedule", "schedule-0", 1, "remote",
            MutationState.FINALIZED, {"id": "schedule-0"},
        ),
    )
    rejected = (
        MutationRejection(
            1, "op-1", "schedule", "schedule-1", "version_conflict", False, {}
        ),
    )
    result = PushResult.from_uow("batch-1", events, applied, rejected)
    assert [item.operation_id for item in result.applied] == ["op-0", "op-2"]
    assert [item.operation_id for item in result.conflicts] == ["op-1"]
    assert not set(item.operation_id for item in result.applied) & set(
        item.operation_id for item in result.conflicts
    )


def test_push_result_preserves_server_local_lww_conflict_resolution() -> None:
    from app.mutation.types import MutationRejection
    from app.sync.contracts import PushResult, SyncEventInput

    event = SyncEventInput(**_event(action="update", expected_version=2))
    result = PushResult.from_uow(
        "lww-batch",
        [event],
        (),
        (
            MutationRejection(
                0,
                event.operation_id,
                event.entity_type,
                event.entity_id,
                "version_conflict",
                False,
                {"resolution": "local"},
            ),
        ),
    )
    assert result.conflicts[0].resolution == "local"


def test_push_result_rejects_incomplete_duplicate_or_extra_receipts() -> None:
    from app.mutation.types import MutationRejection, MutationResult, MutationState
    from app.sync.contracts import PushResult, SyncEventInput

    events = tuple(
        SyncEventInput(
            **_event(
                entity_id=f"schedule-{index}",
                operation_id=f"receipt-op-{index}",
                payload={"id": f"schedule-{index}", "title": "x"},
            )
        )
        for index in range(2)
    )
    applied = MutationResult(
        "receipt-op-0", "receipt-batch", "schedule", "schedule-0", 1, None,
        MutationState.FINALIZED, {"id": "schedule-0"},
    )
    rejected = MutationRejection(
        1, "receipt-op-1", "schedule", "schedule-1", "version_conflict", False, {}
    )
    assert PushResult.from_uow("receipt-batch", events, (applied,), (rejected,))
    with pytest.raises(ValueError):
        PushResult.from_uow("receipt-batch", events, (applied, applied), ())
    with pytest.raises(ValueError):
        PushResult.from_uow("receipt-batch", events, (applied,), ())
    extra = MutationRejection(
        2, "receipt-extra", "schedule", "schedule-extra", "version_conflict", False, {}
    )
    with pytest.raises(ValueError):
        PushResult.from_uow("receipt-batch", events, (applied,), (rejected, extra))


def test_sync_protocol_exposes_only_durable_operations() -> None:
    from app.sync.protocol import SyncProtocol

    assert {
        "query_operations",
        "push",
        "pull",
        "ack",
        "status",
    } <= set(SyncProtocol.__dict__)


def test_sync_protocol_requires_runtime_catalog_and_space_identity() -> None:
    from app.runtime.leases import LeaseOrderError
    from app.sync.protocol import SyncProtocol, _space_id

    with pytest.raises(ValueError, match="compiled runtime catalog"):
        SyncProtocol(SimpleNamespace())
    with pytest.raises(LeaseOrderError, match="authorized Space identity"):
        _space_id(SimpleNamespace())


@pytest.mark.asyncio
async def test_sync_protocol_requires_uow_recovery_preflight() -> None:
    from app.registry import CATALOG
    from app.sync.protocol import SyncProtocol

    protocol = SyncProtocol(SimpleNamespace(space_id="space-test"), catalog=CATALOG)
    with pytest.raises(RuntimeError, match="MutationUnitOfWork|recover_under_lease"):
        await protocol._recover(object())


def test_sync_settings_keep_raw_and_canonical_batch_budgets_ordered() -> None:
    from app.settings import Settings

    settings = Settings(
        sync_event_payload_max_bytes=256,
        sync_canonical_batch_max_bytes=512,
        request_body_max_bytes=1024 * 1024 + 512,
    )
    assert settings.sync_canonical_batch_max_bytes == 512
    with pytest.raises(ValueError):
        Settings(sync_event_payload_max_bytes=513, sync_canonical_batch_max_bytes=512)
    with pytest.raises(ValueError):
        Settings(sync_canonical_batch_max_bytes=512, request_body_max_bytes=512)


@pytest.mark.asyncio
async def test_sync_protocol_push_and_pull_share_the_uow_visible_ledger(entity_fixture) -> None:
    from app.models.sync_client import SyncClient
    from app.sync.contracts import SyncEventInput
    from app.sync.protocol import SyncProtocol

    await entity_fixture.seed_schedule(
        "schedule-protocol", version=1, updated_at="2026-08-05T09:00:00.000Z"
    )
    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="client-protocol",
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
        protocol = SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog)
        event = SyncEventInput(
            entity_type="schedule",
            entity_id="schedule-protocol",
            action="update",
            payload={"title": "Protocol update"},
            expected_version=1,
            client_updated_at="2026-08-05T10:00:00.000Z",
            operation_id="op-protocol-update",
        )
        pushed = await protocol.push("client-protocol", [event], "batch-protocol")
        assert [item.operation_id for item in pushed.applied] == ["op-protocol-update"]
        page = await protocol.pull("client-protocol", None, 10)
        assert [item.operation_id for item in page.events] == ["op-protocol-update"]
        assert page.events[0].batch_id == "batch-protocol"
    finally:
        await scope.aclose()


@pytest.mark.asyncio
async def test_sync_protocol_pull_keeps_cross_entity_and_tombstone_order(entity_fixture) -> None:
    from app.models.sync_client import SyncClient
    from app.services.sync_outbox import record_sync_event
    from app.sync.protocol import SyncProtocol

    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="client-v2-pages",
                ack_sequence=0,
                catalog_hash=entity_fixture.catalog.hash,
                registered_at=UTC,
                last_seen_at=UTC,
                expires_at="2099-08-05T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )
        for index, (entity_type, action) in enumerate(
            (
                ("schedule", "create"),
                ("schedule", "update"),
                ("schedule", "create"),
                ("schedule", "delete"),
            )
        ):
            entity_id = f"v2-page-{index}"
            await record_sync_event(
                session,
                entity_type=entity_type,
                entity_id=entity_id,
                action=action,
                payload={} if action == "delete" else {"id": entity_id, "title": str(index)},
                operation_id=f"v2-page-op-{index}",
                batch_id="v2-page-batch",
                version=index + 1,
                created_at=f"2026-08-05T10:00:0{index}.000Z",
                visible=True,
            )

    scope = entity_fixture.open_mutation_scope()
    try:
        protocol = SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog)
        cursor = None
        pages = []
        while True:
            page = await protocol.pull("client-v2-pages", cursor, 2)
            pages.append(page)
            if not page.has_more:
                break
            cursor = page.next_cursor

        events = [event for page in pages for event in page.events]
        assert [event.operation_id for event in events] == [
            "v2-page-op-0",
            "v2-page-op-1",
            "v2-page-op-2",
            "v2-page-op-3",
        ]
        assert len({event.operation_id for event in events}) == 4
        assert events[-1].action == "delete"
    finally:
        await scope.aclose()


@pytest.mark.asyncio
async def test_sync_protocol_query_returns_original_full_batch_receipt(entity_fixture) -> None:
    from app.models.sync_client import SyncClient
    from app.sync.contracts import SyncEventInput
    from app.sync.protocol import SyncProtocol

    await entity_fixture.seed_schedule(
        "query-schedule", version=1, updated_at="2026-08-05T09:00:00.000Z"
    )
    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="client-query",
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
        protocol = SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog)
        accepted = SyncEventInput(
            entity_type="schedule",
            entity_id="query-schedule",
            action="update",
            payload={"title": "queried"},
            expected_version=1,
            client_updated_at="2026-08-05T10:00:00.000Z",
            operation_id="query-accepted",
        )
        rejected = SyncEventInput(
            entity_type="not-sync-enabled",
            entity_id="query-rejected",
            action="create",
            payload={},
            expected_version=None,
            client_updated_at="2026-08-05T10:00:00.000Z",
            operation_id="query-rejected",
        )
        pushed = await protocol.push(
            "client-query", [accepted, rejected], "query-batch"
        )
        queried = await protocol.query_operations("client-query", ["query-accepted"])
        assert queried.items[0].state == "terminal"
        assert queried.items[0].batch_id == "query-batch"
        assert queried.items[0].result == pushed
        assert queried.items[0].result is not None
        assert queried.items[0].result.errors[0].operation_id == "query-rejected"
    finally:
        await scope.aclose()


@pytest.mark.asyncio
async def test_sync_protocol_query_finds_mapper_pre_rejection(entity_fixture) -> None:
    from app.models.sync_client import SyncClient
    from app.sync.contracts import SyncEventInput
    from app.sync.protocol import SyncProtocol

    async with entity_fixture._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id="client-pre-rejection",
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
        protocol = SyncProtocol(scope, entity_fixture.uow, catalog=entity_fixture.catalog)
        event = SyncEventInput(
            entity_type="not-sync-enabled",
            entity_id="pre-rejection-entity",
            action="create",
            payload={},
            expected_version=None,
            client_updated_at=UTC,
            operation_id="pre-rejection-op",
        )
        pushed = await protocol.push(
            "client-pre-rejection", [event], "!pre-rejection/batch?"
        )
        queried = await protocol.query_operations(
            "client-pre-rejection", ["pre-rejection-op"]
        )
        assert pushed.errors[0].operation_id == "pre-rejection-op"
        assert queried.items[0].state == "terminal"
        assert queried.items[0].batch_id == "!pre-rejection/batch?"
        assert queried.items[0].result == pushed
    finally:
        await scope.aclose()
