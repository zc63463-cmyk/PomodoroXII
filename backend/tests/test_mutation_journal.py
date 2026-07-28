from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
import rfc8785
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.errors import (
    MUTATION_REJECTION_SPECS,
    RESERVED_TS_CODES,
    S3_MUTATION_REJECTION_CODES,
    AppError,
    IdempotencyConflictError,
    MutationRejectedError,
    to_wire_json,
)
from app.models.mutation import MutationBatch, MutationOperation, MutationStep
from app.models.sync_outbox import SyncOutbox
from app.mutation.journal import IllegalMutationTransition, MutationJournal
from app.mutation.types import (
    BatchMutationResult,
    ContainedProjectionActionField,
    DbMutationPlan,
    InvalidPayloadHashError,
    MutationCommand,
    MutationRejection,
    MutationRequest,
    MutationResult,
    MutationRuleViolation,
    MutationState,
    PersistedMutationCommand,
    PersistedProjectionDescriptor,
    PreparedBatchItem,
    ProjectionActionTag,
    ProjectionPlan,
    StepState,
    SyncEventPlan,
    bounded_child_operation_id,
    canonical_payload_hash,
    decode_persisted_command,
    persisted_command_bytes,
    require_payload_hash,
    validate_operation_id,
)


def test_authoritative_child_operation_id_vectors_match_in_process_and_fresh_process() -> None:
    fixture_path = Path(__file__).parent / "fixtures/task_space_session_child_operation_id_vectors.json"
    raw = fixture_path.read_bytes()
    vectors = json.loads(raw)
    assert tuple(vectors) == ("algorithm", "valid", "invalid")
    assert vectors["algorithm"] == "child-v1"
    assert [item["name"] for item in vectors["valid"]] == [
        "colon_parent",
        "colon_suffix",
        "plain_result_127",
        "plain_result_128",
        "first_overflow_129",
        "parent_127",
        "parent_128",
        "suffix_512",
    ]
    assert [item["name"] for item in vectors["invalid"]] == [
        "suffix_513",
        "suffix_non_ascii",
    ]
    assert raw.endswith(b"\n") and not raw.endswith(b"\n\n")
    assert b"\r\n" not in raw
    for vector in vectors["valid"]:
        actual = bounded_child_operation_id(vector["parent_id"], vector["suffix"])
        assert actual == vector["expected"], vector["name"]
        validate_operation_id(actual)
    assert len(vectors["valid"][2]["expected"].encode("ascii")) == 127
    assert len(vectors["valid"][3]["expected"].encode("ascii")) == 128
    assert vectors["valid"][4]["expected"].startswith("childh:")
    for vector in vectors["invalid"]:
        with pytest.raises(ValueError, match=vector["error"]):
            bounded_child_operation_id(vector["parent_id"], vector["suffix"])

    probe = vectors["valid"][6]
    backend_root = Path(__file__).parents[1]
    completed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            (
                "import sys; sys.path.insert(0, sys.argv[1]); "
                "from app.mutation.types import bounded_child_operation_id; "
                "print(bounded_child_operation_id(sys.argv[2], sys.argv[3]))"
            ),
            str(backend_root),
            probe["parent_id"],
            probe["suffix"],
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.strip() == probe["expected"]
from tests.ast_helpers import literal_exception_codes


def test_package_journal_exports_do_not_cycle_through_models() -> None:
    from app.models.mutation import MutationBatch as ImportedMutationBatch
    from app.mutation import MutationJournal as ExportedMutationJournal

    assert ImportedMutationBatch.__name__ == "MutationBatch"
    assert ExportedMutationJournal.__name__ == "MutationJournal"


def test_authoritative_rfc8785_payload_vectors() -> None:
    path = Path(__file__).parent / "fixtures/task_space_session_payload_hash_vectors.json"
    for vector in json.loads(path.read_text(encoding="utf-8")):
        canonical = rfc8785.dumps(vector["payload"])
        assert canonical.decode("utf-8") == vector["canonicalUtf8"]
        assert canonical_payload_hash(vector["payload"]) == vector["sha256"]


def test_request_hash_is_canonical_and_payload_is_deeply_frozen() -> None:
    original = {"tags": ["x"], "meta": {"rank": 1}}
    first = MutationRequest.from_payload(
        name="note.update",
        entity_type="note",
        entity_id="n1",
        payload=original,
        expected_version=2,
    )
    second = MutationRequest.from_payload(
        name="note.update",
        entity_type="note",
        entity_id="n1",
        payload={"meta": {"rank": 1}, "tags": ["x"]},
        expected_version=2,
    )
    original["tags"].append("mutated")
    original["meta"]["rank"] = 99
    assert first.request_hash == second.request_hash
    assert first.payload == {"tags": ("x",), "meta": {"rank": 1}}


def test_payload_hash_rejects_false_or_malformed_declaration() -> None:
    payload = {"z": 1, "a": [True, None, "雪"]}
    expected = "d625d1d0dc331b7f55c53959732d6fbe3678413b7e013655326ab86130da6559"
    require_payload_hash(expected, payload)
    for declared in ("0" * 64, "A" * 64, "short"):
        with pytest.raises(InvalidPayloadHashError):
            require_payload_hash(declared, payload)


def _request() -> MutationRequest:
    return MutationRequest.from_payload(
        name="note.update",
        entity_type="note",
        entity_id="n1",
        payload={"title": "A"},
        expected_version=1,
    )


def _command() -> MutationCommand:
    return MutationCommand.from_effects(
        request=_request(),
        db_plans=(
            DbMutationPlan(
                table="notes",
                primary_key={"id": "n1"},
                operation="update",
                expected_version=1,
                before_row={"title": "Old"},
                after_row={"title": "A"},
            ),
        ),
        projections=(
            ProjectionPlan(
                ProjectionActionTag.MARKDOWN_WRITE,
                None,
                ContainedProjectionActionField("notes/n1.md"),
                0,
                b"old",
                b"new",
            ),
        ),
        sync_events=(
            SyncEventPlan(
                entity_type="note",
                entity_id="n1",
                action="update",
                payload={"id": "n1", "title": "A"},
                version=2,
                created_at="2026-07-20T00:00:00Z",
            ),
        ),
        result_value={"id": "n1", "title": "A"},
    )


@pytest.mark.asyncio
async def test_intent_creates_exact_pending_projection_steps(space_session) -> None:
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    journal = MutationJournal(sessions)
    command = _command()

    await journal.create_batch_intent(
        "batch-steps", "request-hash", ("operation-steps",), (command,), ()
    )

    async with sessions() as session:
        steps = tuple(
            await session.scalars(
                select(MutationStep).order_by(MutationStep.ordinal)
            )
        )
    descriptor = command.persisted().projections[0]
    assert len(steps) == 1
    assert (
        steps[0].operation_id,
        steps[0].ordinal,
        steps[0].name,
        steps[0].store,
        steps[0].target,
        steps[0].before_hash,
        steps[0].after_hash,
        StepState(steps[0].state),
        steps[0].applied_hash,
    ) == (
        "operation-steps",
        0,
        descriptor.tag.value,
        descriptor.tag.value,
        str(descriptor.target),
        descriptor.before_sha256,
        descriptor.after_sha256,
        StepState.PENDING,
        None,
    )


def test_persisted_command_hash_and_fresh_decoder_are_canonical() -> None:
    persisted = _command().persisted()
    encoded = persisted_command_bytes(persisted)
    decoded = decode_persisted_command(encoded)
    assert persisted_command_bytes(decoded) == encoded
    assert to_wire_json(BatchMutationResult("batch", (), ())) == {
        "batch_id": "batch",
        "applied": [],
        "rejected": [],
        "operation_id_derivations": {},
    }

    noncanonical = json.dumps(json.loads(encoded), indent=2).encode()
    with pytest.raises(ValueError, match="canonical"):
        decode_persisted_command(noncanonical)
    with pytest.raises(ValueError, match="command_hash"):
        PersistedMutationCommand(
            persisted.request,
            persisted.db_plans,
            persisted.projections,
            persisted.sync_events,
            persisted.result_value,
            persisted.resolution,
            "0" * 64,
        )


@pytest.mark.parametrize(
    ("digest", "size"),
    [(None, 0), ("0" * 63, 0), ("0" * 64, -1), ("0" * 64, True)],
)
def test_projection_descriptor_rejects_invalid_hash_size_pairs(
    digest: str | None, size: int | None
) -> None:
    with pytest.raises(ValueError):
        PersistedProjectionDescriptor(
            ProjectionActionTag.MARKDOWN_WRITE,
            None,
            ContainedProjectionActionField("notes/n1.md"),
            0,
            digest,
            size,
            None,
            None,
        )


def test_direct_record_constructors_reject_untyped_or_invalid_children() -> None:
    with pytest.raises(TypeError, match="MutationRequest"):
        MutationCommand({}, (), (), (), {}, None, "0" * 64)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="MutationRequest"):
        PreparedBatchItem(0, "op", "0" * 64, {}, None)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="DbMutationPlan"):
        MutationCommand(_request(), ({"table": "notes"},), (), (), {}, None, "0" * 64)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="state"):
        MutationResult("op", "batch", "note", "n1", 1, None, "BOGUS", {})  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="MutationResult"):
        BatchMutationResult("batch", ({"operation_id": "op"},), ())  # type: ignore[arg-type]
    for request_index, intent_hash in ((True, "0" * 64), (0, "bad")):
        with pytest.raises(ValueError):
            PreparedBatchItem(request_index, "op", intent_hash, _request(), None)  # type: ignore[arg-type]
    duplicate = ProjectionPlan(
        ProjectionActionTag.MARKDOWN_WRITE,
        None,
        ContainedProjectionActionField("notes/n1.md"),
        0,
        None,
        b"a",
    )
    with pytest.raises(ValueError, match="ordinals"):
        MutationCommand.from_effects(
            request=_request(),
            db_plans=(),
            projections=(duplicate, duplicate),
            sync_events=(),
            result_value={},
        )


def test_rule_violation_and_rejection_deep_freeze_details() -> None:
    source = {"conflict": {"versions": [1, 2]}}
    violation = MutationRuleViolation("version_conflict", source, retryable=False)
    rejection = MutationRejection(
        request_index=0,
        operation_id="op-1",
        entity_type="note",
        entity_id="n1",
        code=violation.code,
        retryable=violation.retryable,
        details=violation.details,
    )
    source["conflict"]["versions"].append(3)
    assert rejection.details["conflict"]["versions"] == (1, 2)
    with pytest.raises(AttributeError, match="immutable"):
        violation._retryable = True
    with pytest.raises(ValueError, match="retryable"):
        MutationRejection(
            request_index=0,
            operation_id="op-2",
            entity_type="note",
            entity_id="n2",
            code="version_conflict",
            retryable=True,
            details={},
        )


def test_closed_error_map_and_direct_app_error_resolution() -> None:
    from app.errors import RESERVED_S4_MAPPING_CODES, RESERVED_TS_CODES

    assert set(MUTATION_REJECTION_SPECS) == (
        S3_MUTATION_REJECTION_CODES | RESERVED_TS_CODES | RESERVED_S4_MAPPING_CODES
    )
    error = AppError(code="active_session_recovery_required")
    assert (error.status_code, error.detail, error.legacy_error_type, error.retryable) == (
        503,
        "Active Session coordination requires recovery",
        "service_unavailable",
        True,
    )
    with pytest.raises(ValueError, match="override"):
        AppError("wrong", code="version_conflict")
    with pytest.raises(ValueError, match="unknown"):
        AppError(code="not-a-registered-code")

    rejection = MutationRejection(0, "op", "note", "n1", "version_conflict", False, {})
    rendered = MutationRejectedError(rejection)
    assert rendered.rejection is rejection
    assert (rendered.code, rendered.status_code, rendered.retryable) == (
        "version_conflict",
        409,
        False,
    )
    conflict = IdempotencyConflictError()
    assert (conflict.code, conflict.status_code, conflict.retryable) == (
        "idempotency_conflict",
        409,
        False,
    )
    conflict = IdempotencyConflictError(
        operation_id="op",
        existing_batch_id="old",
        requested_batch_id="new",
    )
    assert conflict.details == {
        "operation_id": "op",
        "existing_batch_id": "old",
        "requested_batch_id": "new",
    }
    with pytest.raises(TypeError):
        IdempotencyConflictError("unsafe", status_code=200, retryable=True)  # type: ignore[call-arg]

    class ForgedRejection:
        code = "version_conflict"
        retryable = False
        details = {}

    with pytest.raises(TypeError, match="MutationRejection"):
        MutationRejectedError(ForgedRejection())


def test_literal_mutation_rule_codes_are_a_closed_s3_subset() -> None:
    app_root = Path(__file__).parents[1] / "app"
    found: set[str] = set()
    for path in app_root.rglob("*.py"):
        found |= literal_exception_codes(path, "MutationRuleViolation")
    assert found <= (S3_MUTATION_REJECTION_CODES | RESERVED_TS_CODES)


@pytest.mark.asyncio
async def test_closed_transitions_and_batch_visibility_barrier(space_session) -> None:
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    journal = MutationJournal(sessions)
    async with sessions.begin() as session:
        session.add(
            MutationBatch(
                batch_id="batch-1",
                command_hash="hash",
                state=MutationState.INTENT,
                accepted_count=2,
                result_json=None,
                created_at="t",
                updated_at="t",
            )
        )
        for sequence in range(2):
            operation_id = f"op-{sequence + 1}"
            session.add(
                MutationOperation(
                    operation_id=operation_id,
                    batch_id="batch-1",
                    sequence=sequence,
                    command_hash="hash",
                    command_json="{}",
                    expected_versions_json="{}",
                    projection_set_json="[]",
                    db_before_json=None,
                    db_after_json=None,
                    manifest_sha256=None,
                    state=MutationState.INTENT,
                    result_json=None,
                    error_code=None,
                    created_at="t",
                    updated_at="t",
                )
            )
            session.add(
                SyncOutbox(
                    entity_type="note",
                    entity_id=operation_id,
                    action="update",
                    payload="{}",
                    operation_id=operation_id,
                    batch_id="batch-1",
                    version=1,
                    visible=False,
                )
            )
    for target in (
        MutationState.STAGED,
        MutationState.DB_COMMITTED,
        MutationState.FINALIZING,
        MutationState.FORWARD_APPLIED,
    ):
        await journal.transition("op-1", target)
        await journal.transition("op-2", target)
    assert await journal.visible_event_count("batch-1") == 0
    async with sessions.begin() as session:
        await MutationJournal.finalize_batch_in_transaction(session, "batch-1")
    assert await journal.visible_event_count("batch-1") == 2
    async with sessions() as session:
        states = set(
            await session.scalars(
                select(MutationOperation.state).where(MutationOperation.batch_id == "batch-1")
            )
        )
        assert states == {MutationState.FINALIZED}


@pytest.mark.asyncio
async def test_rejected_batch_uses_intent_to_aborted_batch_transition(space_session, monkeypatch) -> None:
    observed: list[tuple[str, MutationState, MutationState]] = []
    original = MutationJournal.transition_batch_in_transaction

    async def wrapped(session, batch_id, expected, target):
        observed.append((batch_id, expected, target))
        return await original(session, batch_id, expected, target)

    monkeypatch.setattr(MutationJournal, "transition_batch_in_transaction", wrapped)
    assert space_session.bind is not None
    journal = MutationJournal(async_sessionmaker(space_session.bind, expire_on_commit=False))
    result = await journal.record_rejected_batch("rejected-batch", "h" * 64, ())

    assert result.batch_id == "rejected-batch"
    assert observed == [
        ("rejected-batch", MutationState.INTENT, MutationState.ABORTED),
    ]
    with pytest.raises(IllegalMutationTransition):
        await journal.transition("op-1", MutationState.ABORTED)


@pytest.mark.asyncio
async def test_transition_in_transaction_obeys_outer_rollback(space_session) -> None:
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    async with sessions.begin() as session:
        session.add(
            MutationBatch(
                batch_id="rollback-batch",
                command_hash="hash",
                state=MutationState.INTENT,
                accepted_count=1,
                result_json=None,
                created_at="t",
                updated_at="t",
            )
        )
        session.add(
            MutationOperation(
                operation_id="rollback-op",
                batch_id="rollback-batch",
                sequence=0,
                command_hash="hash",
                command_json="{}",
                expected_versions_json="{}",
                projection_set_json="[]",
                db_before_json=None,
                db_after_json=None,
                manifest_sha256=None,
                state=MutationState.INTENT,
                result_json=None,
                error_code=None,
                created_at="t",
                updated_at="t",
            )
        )
    with pytest.raises(RuntimeError, match="fault"):
        async with sessions.begin() as session:
            await MutationJournal.transition_in_transaction(
                session,
                "rollback-op",
                MutationState.INTENT,
                MutationState.STAGED,
            )
            raise RuntimeError("fault after transition")
    async with sessions() as session:
        assert (
            await session.scalar(
                select(MutationOperation.state).where(
                    MutationOperation.operation_id == "rollback-op"
                )
            )
            == MutationState.INTENT
        )
        assert (await session.get(MutationBatch, "rollback-batch")).state == MutationState.INTENT


@pytest.mark.parametrize("corruption", ["pre-visible", "foreign-operation"])
@pytest.mark.asyncio
async def test_finalize_rejects_each_corrupt_visibility_shape(
    space_session, corruption: str
) -> None:
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    journal = MutationJournal(sessions)
    async with sessions.begin() as session:
        session.add(
            MutationBatch(
                batch_id="corrupt-batch",
                command_hash="hash",
                state=MutationState.FORWARD_APPLIED,
                accepted_count=1,
                result_json=None,
                created_at="t",
                updated_at="t",
            )
        )
        session.add(
            MutationOperation(
                operation_id="child-op",
                batch_id="corrupt-batch",
                sequence=0,
                command_hash="hash",
                command_json="{}",
                expected_versions_json="{}",
                projection_set_json="[]",
                db_before_json=None,
                db_after_json=None,
                manifest_sha256=None,
                state=MutationState.FORWARD_APPLIED,
                result_json=None,
                error_code=None,
                created_at="t",
                updated_at="t",
            )
        )
        session.add(
            SyncOutbox(
                entity_type="note",
                entity_id="n1",
                action="update",
                payload="{}",
                operation_id=("not-a-child" if corruption == "foreign-operation" else "child-op"),
                batch_id="corrupt-batch",
                version=1,
                visible=corruption == "pre-visible",
            )
        )
    with pytest.raises(IllegalMutationTransition):
        await journal.finalize_batch("corrupt-batch")
    assert await journal.visible_event_count("corrupt-batch") == (
        1 if corruption == "pre-visible" else 0
    )
    async with sessions() as session:
        assert (await session.get(MutationBatch, "corrupt-batch")).state == (
            MutationState.FORWARD_APPLIED
        )


@pytest.mark.asyncio
async def test_transition_rejects_accepted_count_mismatch(space_session) -> None:
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    journal = MutationJournal(sessions)
    async with sessions.begin() as session:
        session.add(
            MutationBatch(
                batch_id="count-batch",
                command_hash="hash",
                state=MutationState.INTENT,
                accepted_count=2,
                result_json=None,
                created_at="t",
                updated_at="t",
            )
        )
        session.add(
            MutationOperation(
                operation_id="only-child",
                batch_id="count-batch",
                sequence=0,
                command_hash="hash",
                command_json="{}",
                expected_versions_json="{}",
                projection_set_json="[]",
                db_before_json=None,
                db_after_json=None,
                manifest_sha256=None,
                state=MutationState.INTENT,
                result_json=None,
                error_code=None,
                created_at="t",
                updated_at="t",
            )
        )
    with pytest.raises(IllegalMutationTransition, match="child set"):
        await journal.transition("only-child", MutationState.STAGED)
    assert await journal.state("only-child") is MutationState.INTENT


@pytest.mark.asyncio
async def test_finalize_in_transaction_obeys_outer_rollback(space_session) -> None:
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    async with sessions.begin() as session:
        session.add(
            MutationBatch(
                batch_id="finalize-rollback",
                command_hash="hash",
                state=MutationState.FORWARD_APPLIED,
                accepted_count=1,
                result_json=None,
                created_at="t",
                updated_at="t",
            )
        )
        session.add(
            MutationOperation(
                operation_id="finalize-child",
                batch_id="finalize-rollback",
                sequence=0,
                command_hash="hash",
                command_json="{}",
                expected_versions_json="{}",
                projection_set_json="[]",
                db_before_json=None,
                db_after_json=None,
                manifest_sha256=None,
                state=MutationState.FORWARD_APPLIED,
                result_json=None,
                error_code=None,
                created_at="t",
                updated_at="t",
            )
        )
        session.add(
            SyncOutbox(
                entity_type="note",
                entity_id="n1",
                action="update",
                payload="{}",
                operation_id="finalize-child",
                batch_id="finalize-rollback",
                version=1,
                visible=False,
            )
        )
    with pytest.raises(RuntimeError, match="fault"):
        async with sessions.begin() as session:
            await MutationJournal.finalize_batch_in_transaction(session, "finalize-rollback")
            raise RuntimeError("fault after finalize")
    async with sessions() as session:
        assert (await session.get(MutationBatch, "finalize-rollback")).state == (
            MutationState.FORWARD_APPLIED
        )
        assert (
            await session.scalar(
                select(MutationOperation.state).where(
                    MutationOperation.operation_id == "finalize-child"
                )
            )
            == MutationState.FORWARD_APPLIED
        )
        assert (
            await session.scalar(
                select(SyncOutbox.visible).where(SyncOutbox.batch_id == "finalize-rollback")
            )
            is False
        )
