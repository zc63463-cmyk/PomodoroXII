from __future__ import annotations

import json
from pathlib import Path

import pytest
import rfc8785
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.errors import (
    MUTATION_REJECTION_SPECS,
    S3_MUTATION_REJECTION_CODES,
    AppError,
    IdempotencyConflictError,
    MutationRejectedError,
    to_wire_json,
)
from app.models.mutation import MutationBatch, MutationOperation
from app.models.sync_outbox import SyncOutbox
from app.mutation.journal import IllegalMutationTransition, MutationJournal
from app.mutation.types import (
    BatchMutationResult,
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
    ProjectionPlan,
    SyncEventPlan,
    canonical_payload_hash,
    decode_persisted_command,
    persisted_command_bytes,
    require_payload_hash,
)
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
        projections=(ProjectionPlan("markdown", "notes/n1.md", 0, b"old", b"new"),),
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


def test_persisted_command_hash_and_fresh_decoder_are_canonical() -> None:
    persisted = _command().persisted()
    encoded = persisted_command_bytes(persisted)
    decoded = decode_persisted_command(encoded)
    assert persisted_command_bytes(decoded) == encoded
    assert to_wire_json(BatchMutationResult("batch", (), ())) == {
        "batch_id": "batch",
        "applied": [],
        "rejected": [],
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
        PersistedProjectionDescriptor("markdown", "notes/n1.md", 0, digest, size, None, None)


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
    duplicate = ProjectionPlan("markdown", "notes/n1.md", 0, None, b"a")
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
    assert found <= S3_MUTATION_REJECTION_CODES


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
    await journal.finalize_batch("batch-1")
    assert await journal.visible_event_count("batch-1") == 2
    async with sessions() as session:
        states = set(
            await session.scalars(
                select(MutationOperation.state).where(MutationOperation.batch_id == "batch-1")
            )
        )
    assert states == {MutationState.FINALIZED}
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
