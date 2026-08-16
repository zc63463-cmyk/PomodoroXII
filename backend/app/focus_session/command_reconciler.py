"""Durable reconciliation of immutable FocusSession command envelopes.

The reconciler is deliberately a thin coordinator.  It never compiles a
Task Space mutation itself and never treats the mutable current receipt as the
source of the original command.  Original S3 journal results are queried
first; replay and receipt transitions are then executed through the shared S3
MutationUnitOfWork.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

from app.errors import AppError, IdempotencyConflictError, MutationRejectedError
from app.focus_session.commands import (
    build_focus_request,
    build_server_focus_command,
    validate_reconcile_shape,
)
from app.focus_session.contracts import (
    CommandReceiptState,
    FocusSessionCommand,
    FocusSessionView,
)
from app.focus_session.module import focus_session_view, require_focus_scope
from app.focus_session.receipts import decode_reconcile_coordination, receipt_view
from app.models.mutation import MutationOperation
from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt
from app.mutation.journal import MutationJournal
from app.mutation.types import (
    MutationRequest,
    MutationState,
    bounded_child_operation_id,
    decode_persisted_command,
    validate_canonical_timestamp,
    validate_operation_id,
)
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpaceCommandModule,
    TaskSpaceOutcome,
    TaskSpaceRejected,
)
from app.task_space.module import build_task_space_request


class StoredTaskCommandLookup(Protocol):
    async def query_original(
        self,
        scope,
        command_id: str,
        expected_request: MutationRequest,
    ) -> TaskSpaceOutcome | None: ...


class ReceiptWriter(Protocol):
    async def record_pending(self, scope, envelope: SessionCommandEnvelope) -> Mapping[str, object]: ...

    async def record(
        self,
        scope,
        envelope: SessionCommandEnvelope,
        outcome: TaskSpaceOutcome | None,
        *,
        expected_coordination: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]: ...


TRANSITION_STATUS_ID = {
    "complete": SYSTEM_STATUS_IDS["completed"],
    "cancel": SYSTEM_STATUS_IDS["cancelled"],
}
TERMINAL_RECEIPT_STATES = frozenset({
    "succeeded", "failed", "conflict", "abandoned",
})


def expected_replay_coordination(
    decision: Mapping[str, object],
) -> Mapping[str, object] | None:
    if decision.get("kind") != "replay_claimed":
        return None
    root_command_id = decision.get("root_command_id")
    if not isinstance(root_command_id, str):
        raise AppError(code="active_session_recovery_required")
    validate_operation_id(root_command_id)
    return {"kind": "replay_claimed", "root_command_id": root_command_id}


def current_replay_coordination(receipt: object | None) -> Mapping[str, object] | None:
    if receipt is None:
        return None
    value = decode_reconcile_coordination(
        state=CommandReceiptState(str(receipt.state)),
        result_json=receipt.result_json,
    )
    if value is None:
        return None
    return {"kind": value["kind"], "root_command_id": value["rootCommandId"]}


def require_exact_admission_decisions(
    admission: Mapping[str, object], command_ids: tuple[str, ...],
) -> Mapping[str, Mapping[str, object]]:
    if set(admission) != {"ordered_command_ids", "decisions"}:
        raise AppError(code="active_session_recovery_required")
    ordered = admission.get("ordered_command_ids")
    if not isinstance(ordered, (tuple, list)) or tuple(ordered) != command_ids:
        raise AppError(code="active_session_recovery_required")
    decisions = admission.get("decisions")
    if not isinstance(decisions, Mapping) or set(decisions) != set(command_ids):
        raise AppError(code="active_session_recovery_required")
    return {
        command_id: require_closed_admission_decision(decisions[command_id])
        for command_id in command_ids
    }


def require_closed_admission_decision(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not isinstance(value.get("kind"), str):
        raise AppError(code="active_session_recovery_required")
    kind = value["kind"]
    if kind == "replay_claimed":
        expected_keys = {"kind", "root_command_id"}
    elif kind == "abandoned":
        expected_keys = {"kind", "root_command_id", "decision_at"}
    elif kind == "observe":
        expected_keys = {"kind", "receipt_state"}
    else:
        raise AppError(code="active_session_recovery_required")
    if set(value) != expected_keys:
        raise AppError(code="active_session_recovery_required")
    if kind in {"replay_claimed", "abandoned"}:
        root = value.get("root_command_id")
        if not isinstance(root, str):
            raise AppError(code="active_session_recovery_required")
        try:
            validate_operation_id(root)
        except (TypeError, ValueError) as exc:
            raise AppError(code="active_session_recovery_required") from exc
    if kind == "abandoned":
        timestamp = value.get("decision_at")
        if not isinstance(timestamp, str):
            raise AppError(code="active_session_recovery_required")
        try:
            validate_canonical_timestamp(timestamp)
        except (TypeError, ValueError) as exc:
            raise AppError(code="active_session_recovery_required") from exc
    if kind == "observe" and value.get("receipt_state") not in {
        "not_needed", "pending", "succeeded", "failed", "conflict", "unknown", "abandoned",
    }:
        raise AppError(code="active_session_recovery_required")
    return value


def require_receipt(receipt: object | None) -> object:
    if receipt is None:
        raise AppError(code="active_session_recovery_required")
    return receipt


def validate_reconcile_command(scope, command: FocusSessionCommand) -> None:
    require_focus_scope(scope, command.space_id, command.session_id)
    validate_reconcile_shape(command)


def envelope_to_task_space_command(envelope: SessionCommandEnvelope) -> MutateWorkItem:
    try:
        status_definition_id = TRANSITION_STATUS_ID[envelope.target_transition]
    except KeyError as exc:
        raise AppError(code="active_session_recovery_required") from exc
    return MutateWorkItem(
        command_id=envelope.command_id,
        space_id=envelope.space_id,
        work_item_id=envelope.work_item_id,
        expected_version=envelope.expected_version,
        payload={
            "operation": "transition",
            "status_definition_id": status_definition_id,
        },
        payload_hash=envelope.payload_hash,
    )


class S3StoredTaskCommandLookup:
    """Read finalized Task Space outcomes from the shared S3 journal."""

    def __init__(self, journal_factory=MutationJournal) -> None:
        self._journal_factory = journal_factory

    async def query_original(self, scope, command_id: str, expected_request: MutationRequest) -> TaskSpaceOutcome | None:
        async with scope.session_factory() as session:
            operation = await session.get(MutationOperation, command_id)
        if operation is None:
            return None
        try:
            persisted = decode_persisted_command(operation.command_json)
        except (TypeError, ValueError) as exc:
            raise AppError(
                code="idempotency_conflict",
                details={"reason": "stored_request_invalid", "commandId": command_id},
            ) from exc
        if persisted.request.request_hash != expected_request.request_hash:
            raise IdempotencyConflictError(operation_id=command_id)
        batch = await self._journal_factory(scope.session_factory).find_batch(operation.batch_id)
        if batch is None or batch.state not in {MutationState.FINALIZED, MutationState.ABORTED}:
            return None
        for result in batch.result.applied:
            if result.operation_id == command_id:
                return TaskSpaceAccepted(
                    command_id=command_id,
                    entity_type=result.entity_type,
                    entity_id=result.entity_id,
                    version=int(result.version or 0),
                    value=result.value,
                )
        for rejection in batch.result.rejected:
            if rejection.operation_id == command_id:
                return TaskSpaceRejected(
                    command_id=command_id,
                    code=rejection.code,
                    retryable=rejection.retryable,
                    details=rejection.details,
                )
        raise AppError(
            code="active_session_recovery_required",
            details={"reason": "stored_operation_outcome_missing", "commandId": command_id},
        )


class S3ReceiptWriter:
    """Persist one current Session receipt through the FocusSession policy."""

    def __init__(self, uow, *, clock=None, journal_factory=MutationJournal) -> None:
        self._uow = uow
        self._clock = clock
        self._journal_factory = journal_factory

    async def _existing_child(self, scope, operation_id: str):
        return await self._journal_factory(scope.session_factory).find_batch(operation_id)

    @staticmethod
    def _outcome_fields(outcome: TaskSpaceOutcome | None) -> tuple[str, str | None, bool, Mapping[str, object] | None, object | None]:
        if outcome is None:
            return "unknown", "command_result_unknown", True, {"reason": "task_space_result_unknown"}, None
        if isinstance(outcome, TaskSpaceAccepted):
            return "succeeded", None, False, None, outcome.value
        if isinstance(outcome, TaskSpaceRejected):
            state = "conflict" if outcome.code in {"version_conflict", "work_item_structure_changed", "invalid_work_item_tree"} else "failed"
            return state, outcome.code, outcome.retryable, outcome.details, None
        raise TypeError(f"unsupported TaskSpace outcome: {type(outcome).__name__}")

    async def _write(
        self,
        scope,
        envelope: SessionCommandEnvelope,
        *,
        state: str,
        error_code: str | None,
        retryable: bool,
        details: Mapping[str, object] | None,
        result: object | None,
        expected_coordination: Mapping[str, object] | None,
    ) -> Mapping[str, object]:
        async with scope.session_factory() as session:
            current_receipt = await session.get(SessionCommandReceipt, envelope.command_id)
        if current_receipt is not None and str(current_receipt.state) in TERMINAL_RECEIPT_STATES:
            return receipt_view(current_receipt)
        operation_suffix = f"receipt:{envelope.command_id}:{state}" if expected_coordination else f"receipt:{state}"
        parent_id = (
            str(expected_coordination["root_command_id"])
            if expected_coordination else envelope.command_id
        )
        operation_id = bounded_child_operation_id(parent_id, operation_suffix)
        existing = await self._existing_child(scope, operation_id)
        if existing is not None:
            if current_receipt is None:
                raise AppError(code="active_session_recovery_required")
            return receipt_view(current_receipt)
        current_clock = self._clock
        if current_clock is None:
            from app.services.time import utc_now_iso_ms
            current_clock = utc_now_iso_ms
        updated_at = str(current_clock())
        payload: dict[str, object] = {
            "space_id": envelope.space_id,
            "session_id": envelope.session_id,
            "command_id": envelope.command_id,
            "state": state,
            "error_code": error_code,
            "retryable": retryable,
            "details": details,
            "result": result,
            "updated_at": updated_at,
            "expected_coordination": expected_coordination,
        }
        command = build_server_focus_command(
            command_id=operation_id,
            space_id=envelope.space_id,
            session_id=envelope.session_id,
            ownership_epoch=None,
            action="record_receipt",
            payload=payload,
        )
        try:
            await self._uow.execute(
                scope,
                build_focus_request("record_receipt", command),
                operation_id,
            )
        except MutationRejectedError as exc:
            raise AppError(code=exc.rejection.code, details=exc.rejection.details) from exc
        except IdempotencyConflictError as exc:
            raise AppError(code="idempotency_conflict", details=getattr(exc, "details", {})) from exc
        async with scope.session_factory() as session:
            receipt = await session.get(SessionCommandReceipt, envelope.command_id)
        if receipt is None:
            raise AppError(code="active_session_recovery_required")
        return receipt_view(receipt)

    async def record_pending(self, scope, envelope: SessionCommandEnvelope) -> Mapping[str, object]:
        return await self._write(
            scope,
            envelope,
            state="pending",
            error_code=None,
            retryable=False,
            details=None,
            result=None,
            expected_coordination=None,
        )

    async def record(self, scope, envelope: SessionCommandEnvelope, outcome: TaskSpaceOutcome | None, *, expected_coordination=None) -> Mapping[str, object]:
        state, error_code, retryable, details, result = self._outcome_fields(outcome)
        if outcome is None and expected_coordination is not None:
            root_id = str(expected_coordination["root_command_id"])
            result = {"_reconcileCoordination": {"kind": "replay_finished_unknown", "rootCommandId": root_id}}
        return await self._write(
            scope,
            envelope,
            state=state,
            error_code=error_code,
            retryable=retryable,
            details=details,
            result=result,
            expected_coordination=expected_coordination,
        )


class SessionCommandReconciler:
    def __init__(self, task_space: TaskSpaceCommandModule, stored: StoredTaskCommandLookup, receipt_writer: ReceiptWriter, query) -> None:
        self._task_space = task_space
        self._stored = stored
        self._receipt_writer = receipt_writer
        self._query = query

    async def reconcile(self, scope, command: FocusSessionCommand, *, admission: Mapping[str, object]) -> FocusSessionView:
        validate_reconcile_command(scope, command)
        session_id = command.session_id
        if session_id is None:
            raise AppError(code="active_session_recovery_required")
        command_ids = tuple(str(value) for value in command.payload["command_ids"])
        envelopes = await self._query.selected_envelopes_by_ids(scope, session_id, command_ids)
        decisions = require_exact_admission_decisions(
            admission, tuple(envelope.command_id for envelope in envelopes)
        )
        for envelope in envelopes:
            await self._reconcile_one(scope, envelope, root_command=command, decision=decisions[envelope.command_id])
        view = await self._query.load(scope, session_id)
        return FocusSessionView(value=focus_session_view(view))

    async def _reconcile_one(self, scope, envelope, *, root_command: FocusSessionCommand, decision: Mapping[str, object]) -> Mapping[str, object]:
        local = await self._query.receipt(scope, envelope.command_id)
        task_command = envelope_to_task_space_command(envelope)
        expected_request = build_task_space_request(task_command)
        original = await self._stored.query_original(scope, envelope.command_id, expected_request)
        if original is not None:
            if local is not None and str(local.state) == "abandoned":
                raise AppError(code="active_session_recovery_required")
            return await self._receipt_writer.record(
                scope, envelope, original,
                expected_coordination=current_replay_coordination(local),
            )
        if local is not None and str(local.state) in TERMINAL_RECEIPT_STATES:
            return receipt_view(local)
        kind = decision.get("kind")
        if kind == "abandoned":
            if local is None or str(local.state) != "abandoned":
                raise AppError(code="active_session_recovery_required")
            return receipt_view(local)
        if kind == "observe":
            if local is None:
                return await self._receipt_writer.record_pending(scope, envelope)
            return receipt_view(local)
        if kind != "replay_claimed":
            raise AppError(code="active_session_recovery_required")
        current_coordination = current_replay_coordination(local)
        expected_coordination = expected_replay_coordination(decision)
        if current_coordination != expected_coordination:
            return receipt_view(require_receipt(local))
        root_id = str(decision["root_command_id"])
        if root_id != root_command.command_id:
            return receipt_view(require_receipt(local))
        if not bool(root_command.payload["replay_safe"]) or not bool(envelope.replay_safe):
            raise AppError(code="active_session_recovery_required")
        try:
            outcome = await self._task_space.execute(scope, task_command)
        except TimeoutError:
            outcome = None
        return await self._receipt_writer.record(
            scope, envelope, outcome,
            expected_coordination=expected_coordination,
        )


__all__ = [
    "ReceiptWriter",
    "S3ReceiptWriter",
    "S3StoredTaskCommandLookup",
    "SessionCommandReconciler",
    "StoredTaskCommandLookup",
    "current_replay_coordination",
    "envelope_to_task_space_command",
    "expected_replay_coordination",
    "require_closed_admission_decision",
    "require_exact_admission_decisions",
]
