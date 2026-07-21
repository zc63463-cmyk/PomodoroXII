"""Transaction-bound compare-and-swap operations for the mutation journal."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mutation import MutationBatch, MutationOperation, MutationStep
from app.models.sync_outbox import SyncOutbox
from app.mutation.types import (
    BatchMutationResult,
    MutationCommand,
    MutationRejection,
    MutationResult,
    MutationState,
    StepState,
    persisted_command_bytes,
)

LEGAL_TRANSITIONS = {
    MutationState.INTENT: frozenset({MutationState.STAGED, MutationState.ABORTED}),
    MutationState.STAGED: frozenset({MutationState.DB_COMMITTED, MutationState.ABORTED}),
    MutationState.DB_COMMITTED: frozenset(
        {
            MutationState.FINALIZING,
            MutationState.COMPENSATING,
            MutationState.FAILED_MANUAL,
        }
    ),
    MutationState.FINALIZING: frozenset(
        {
            MutationState.FORWARD_APPLIED,
            MutationState.COMPENSATING,
            MutationState.FAILED_MANUAL,
        }
    ),
    MutationState.FORWARD_APPLIED: frozenset(
        {
            MutationState.FINALIZED,
            MutationState.COMPENSATING,
            MutationState.FAILED_MANUAL,
        }
    ),
    MutationState.COMPENSATING: frozenset(
        {
            MutationState.COMPENSATED,
            MutationState.FAILED_MANUAL,
        }
    ),
    MutationState.FINALIZED: frozenset(),
    MutationState.ABORTED: frozenset(),
    MutationState.COMPENSATED: frozenset(),
    MutationState.FAILED_MANUAL: frozenset(),
}


class IllegalMutationTransition(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class JournalBatch:
    batch_id: str
    request_hash: str
    state: MutationState
    result: BatchMutationResult


def _encode_result(result: BatchMutationResult) -> str:
    return json.dumps(
        {
            "applied": [
                {
                    "operation_id": item.operation_id,
                    "batch_id": item.batch_id,
                    "entity_type": item.entity_type,
                    "entity_id": item.entity_id,
                    "version": item.version,
                    "resolution": item.resolution,
                    "state": item.state.value,
                    "value": dict(item.value),
                }
                for item in result.applied
            ],
            "rejected": [
                {
                    "request_index": item.request_index,
                    "operation_id": item.operation_id,
                    "entity_type": item.entity_type,
                    "entity_id": item.entity_id,
                    "code": item.code,
                    "retryable": item.retryable,
                    "details": dict(item.details),
                }
                for item in result.rejected
            ],
            "operation_id_derivations": {
                operation_id: dict(derivation)
                for operation_id, derivation in sorted(
                    result.operation_id_derivations.items()
                )
            },
        },
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )


def _decode_result(batch_id: str, payload: str | None) -> BatchMutationResult:
    if payload is None:
        raise IllegalMutationTransition("batch receipt is missing")
    try:
        raw = json.loads(payload)
        result = BatchMutationResult(
            batch_id,
            tuple(
                MutationResult(
                    item["operation_id"],
                    item["batch_id"],
                    item["entity_type"],
                    item["entity_id"],
                    item["version"],
                    item["resolution"],
                    item["state"],
                    item["value"],
                )
                for item in raw["applied"]
            ),
            tuple(
                MutationRejection(
                    item["request_index"],
                    item["operation_id"],
                    item["entity_type"],
                    item["entity_id"],
                    item["code"],
                    item["retryable"],
                    item["details"],
                )
                for item in raw["rejected"]
            ),
            raw.get("operation_id_derivations", {}),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise IllegalMutationTransition("batch receipt is invalid") from exc
    return result


class MutationJournal:
    def __init__(self, session_factory: Callable[[], AsyncSession]) -> None:
        self._sessions = session_factory

    async def is_clean(self) -> bool:
        async with self._sessions() as session:
            pending = await session.scalar(
                select(func.count())
                .select_from(MutationBatch)
                .where(
                    MutationBatch.state.not_in(
                        (MutationState.FINALIZED, MutationState.ABORTED, MutationState.COMPENSATED)
                    )
                )
            )
        return int(pending or 0) == 0

    async def find_batch(self, batch_id: str) -> JournalBatch | None:
        async with self._sessions() as session:
            row = await session.get(MutationBatch, batch_id)
            if row is None:
                return None
            return JournalBatch(
                row.batch_id,
                row.command_hash,
                MutationState(row.state),
                _decode_result(row.batch_id, row.result_json),
            )

    async def find_operation_batch_bindings(
        self, operation_ids: tuple[str, ...]
    ) -> dict[str, str]:
        if not operation_ids:
            return {}
        async with self._sessions() as session:
            rows = tuple(
                await session.execute(
                    select(MutationOperation.operation_id, MutationOperation.batch_id).where(
                        MutationOperation.operation_id.in_(operation_ids)
                    )
                )
            )
        return {operation_id: batch_id for operation_id, batch_id in rows}

    async def create_batch_intent(
        self,
        batch_id: str,
        request_hash: str,
        operation_ids: tuple[str, ...],
        commands: tuple[MutationCommand, ...],
        rejections: tuple[MutationRejection, ...],
        operation_id_derivations: Mapping[str, tuple[str, str]] | None = None,
    ) -> None:
        if len(operation_ids) != len(commands) or not operation_ids:
            raise ValueError("accepted operation IDs must align with commands")
        applied = tuple(
            MutationResult(
                operation_id,
                batch_id,
                command.request.entity_type,
                command.request.entity_id,
                command.sync_events[-1].version if command.sync_events else None,
                command.resolution,
                MutationState.FINALIZED,
                command.result_value,
            )
            for operation_id, command in zip(operation_ids, commands, strict=True)
        )
        derivations = {
            operation_id: {"parent_id": parent_id, "suffix": suffix}
            for operation_id, (parent_id, suffix) in (
                operation_id_derivations or {}
            ).items()
        }
        result = BatchMutationResult(batch_id, applied, rejections, derivations)
        async with self._sessions.begin() as session:
            session.add(
                MutationBatch(
                    batch_id=batch_id,
                    command_hash=request_hash,
                    state=MutationState.INTENT,
                    accepted_count=len(operation_ids),
                    result_json=_encode_result(result),
                )
            )
            for sequence, (operation_id, command) in enumerate(
                zip(operation_ids, commands, strict=True)
            ):
                persisted = command.persisted()
                session.add(
                    MutationOperation(
                        operation_id=operation_id,
                        batch_id=batch_id,
                        sequence=sequence,
                        command_hash=command.command_hash,
                        command_json=persisted_command_bytes(persisted).decode("utf-8"),
                        expected_versions_json=json.dumps(
                            [plan.expected_version for plan in command.db_plans], separators=(",", ":")
                        ),
                        projection_set_json=json.dumps(
                            [item.target for item in command.projections], separators=(",", ":")
                        ),
                        state=MutationState.INTENT,
                    )
                )
                for descriptor in persisted.projections:
                    session.add(
                        MutationStep(
                            operation_id=operation_id,
                            ordinal=descriptor.ordinal,
                            name=descriptor.tag.value,
                            store=descriptor.tag.value,
                            target=str(descriptor.target),
                            before_hash=descriptor.before_sha256,
                            after_hash=descriptor.after_sha256,
                            state=StepState.PENDING,
                        )
                    )

    async def record_rejected_batch(
        self,
        batch_id: str,
        request_hash: str,
        rejections: tuple[MutationRejection, ...],
        operation_id_derivations: Mapping[str, tuple[str, str]] | None = None,
    ) -> BatchMutationResult:
        derivations = {
            operation_id: {"parent_id": parent_id, "suffix": suffix}
            for operation_id, (parent_id, suffix) in (
                operation_id_derivations or {}
            ).items()
        }
        result = BatchMutationResult(batch_id, (), rejections, derivations)
        async with self._sessions.begin() as session:
            session.add(
                MutationBatch(
                    batch_id=batch_id,
                    command_hash=request_hash,
                    state=MutationState.INTENT,
                    accepted_count=0,
                    result_json=_encode_result(result),
                )
            )
            await session.flush()
            await MutationJournal.transition_batch_in_transaction(
                session,
                batch_id,
                MutationState.INTENT,
                MutationState.ABORTED,
            )
        return result

    @staticmethod
    async def transition_batch_in_transaction(
        session: AsyncSession,
        batch_id: str,
        expected: MutationState,
        target: MutationState,
    ) -> None:
        if target not in LEGAL_TRANSITIONS[expected]:
            raise IllegalMutationTransition(f"illegal transition: {expected} -> {target}")
        result = await session.execute(
            update(MutationBatch)
            .where(
                MutationBatch.batch_id == batch_id,
                MutationBatch.state == expected,
            )
            .values(state=target)
        )
        if result.rowcount != 1:
            raise IllegalMutationTransition(
                f"batch {batch_id} is not in expected state {expected}"
            )
        await session.flush()

    async def mark_staged(self, batch_id: str, manifests: tuple[object, ...]) -> None:
        async with self._sessions.begin() as session:
            operations = tuple(
                await session.scalars(
                    select(MutationOperation)
                    .where(MutationOperation.batch_id == batch_id)
                    .order_by(MutationOperation.sequence)
                )
            )
            if len(operations) != len(manifests) or not operations:
                raise IllegalMutationTransition("stage manifest set is incomplete")
            for operation, manifest in zip(operations, manifests, strict=True):
                if getattr(manifest, "operation_id", None) != operation.operation_id:
                    raise IllegalMutationTransition("stage manifest operation mismatch")
                operation.manifest_sha256 = getattr(manifest, "manifest_sha256")
                operation.state = MutationState.STAGED
            batch = await session.get(MutationBatch, batch_id)
            if batch is None or MutationState(batch.state) is not MutationState.INTENT:
                raise IllegalMutationTransition("batch is not awaiting stages")
            batch.state = MutationState.STAGED

    async def mark_finalizing(self, batch_id: str) -> None:
        async with self._sessions.begin() as session:
            for operation_id in tuple(
                await session.scalars(
                    select(MutationOperation.operation_id)
                    .where(MutationOperation.batch_id == batch_id)
                    .order_by(MutationOperation.sequence)
                )
            ):
                await self.transition_in_transaction(
                    session, operation_id, MutationState.DB_COMMITTED, MutationState.FINALIZING
                )

    async def mark_forward_applied(self, batch_id: str) -> None:
        async with self._sessions.begin() as session:
            for operation_id in tuple(
                await session.scalars(
                    select(MutationOperation.operation_id)
                    .where(MutationOperation.batch_id == batch_id)
                    .order_by(MutationOperation.sequence)
                )
            ):
                await self.transition_in_transaction(
                    session, operation_id, MutationState.FINALIZING, MutationState.FORWARD_APPLIED
                )

    @staticmethod
    async def transition_in_transaction(
        session: AsyncSession,
        operation_id: str,
        expected: MutationState,
        target: MutationState,
    ) -> None:
        if target not in LEGAL_TRANSITIONS[expected]:
            raise IllegalMutationTransition(f"illegal transition: {expected} -> {target}")
        batch_id = await session.scalar(
            select(MutationOperation.batch_id).where(MutationOperation.operation_id == operation_id)
        )
        if batch_id is None:
            raise IllegalMutationTransition(f"unknown operation: {operation_id}")
        batch = await session.get(MutationBatch, batch_id)
        child_count = await session.scalar(
            select(func.count())
            .select_from(MutationOperation)
            .where(MutationOperation.batch_id == batch_id)
        )
        if (
            batch is None
            or MutationState(batch.state) is not expected
            or child_count != batch.accepted_count
        ):
            raise IllegalMutationTransition("batch child set or state is inconsistent")
        result = await session.execute(
            update(MutationOperation)
            .where(
                MutationOperation.operation_id == operation_id,
                MutationOperation.state == expected,
            )
            .values(state=target)
        )
        if result.rowcount != 1:
            raise IllegalMutationTransition(
                f"operation {operation_id} is not in expected state {expected}"
            )
        remaining = await session.scalar(
            select(func.count())
            .select_from(MutationOperation)
            .where(
                MutationOperation.batch_id == batch_id,
                MutationOperation.state != target,
            )
        )
        if remaining == 0:
            batch_result = await session.execute(
                update(MutationBatch)
                .where(
                    MutationBatch.batch_id == batch_id,
                    MutationBatch.state == expected,
                )
                .values(state=target)
            )
            if batch_result.rowcount != 1:
                raise IllegalMutationTransition(
                    f"batch {batch_id} is not in expected state {expected}"
                )
        await session.flush()

    async def transition(self, operation_id: str, target: MutationState) -> None:
        async with self._sessions.begin() as session:
            current = await session.scalar(
                select(MutationOperation.state).where(
                    MutationOperation.operation_id == operation_id
                )
            )
            if current is None:
                raise IllegalMutationTransition(f"unknown operation: {operation_id}")
            await self.transition_in_transaction(
                session, operation_id, MutationState(current), target
            )

    async def mark_step_applied(
        self,
        operation_id: str,
        ordinal: int,
        applied_hash: str | None,
    ) -> None:
        async with self._sessions.begin() as session:
            result = await session.execute(
                update(MutationStep)
                .where(
                    MutationStep.operation_id == operation_id,
                    MutationStep.ordinal == ordinal,
                    MutationStep.state == StepState.PENDING,
                    MutationStep.after_hash == applied_hash,
                    MutationStep.applied_hash.is_(None),
                )
                .values(state=StepState.APPLIED, applied_hash=applied_hash)
            )
            if result.rowcount != 1:
                raise IllegalMutationTransition(
                    f"projection step {operation_id}:{ordinal} is not pending "
                    "with the expected after hash"
                )
            await session.flush()

    @staticmethod
    async def finalize_batch_in_transaction(session: AsyncSession, batch_id: str) -> None:
        batch_row = await session.get(MutationBatch, batch_id)
        child_rows = tuple(
            await session.execute(
                select(MutationOperation.operation_id, MutationOperation.state).where(
                    MutationOperation.batch_id == batch_id
                )
            )
        )
        child_ids = {operation_id for operation_id, _state in child_rows}
        ledger_rows = tuple(
            await session.execute(
                select(SyncOutbox.operation_id, SyncOutbox.visible).where(
                    SyncOutbox.batch_id == batch_id
                )
            )
        )
        if (
            batch_row is None
            or MutationState(batch_row.state) is not MutationState.FORWARD_APPLIED
            or len(child_rows) != batch_row.accepted_count
            or not child_rows
            or {MutationState(state) for _operation_id, state in child_rows}
            != {MutationState.FORWARD_APPLIED}
            or any(
                visible or operation_id not in child_ids for operation_id, visible in ledger_rows
            )
        ):
            raise IllegalMutationTransition(
                "all accepted children must be FORWARD_APPLIED before finalization"
            )
        operations = await session.execute(
            update(MutationOperation)
            .where(
                MutationOperation.batch_id == batch_id,
                MutationOperation.state == MutationState.FORWARD_APPLIED,
            )
            .values(state=MutationState.FINALIZED)
        )
        if operations.rowcount != len(child_rows):
            raise IllegalMutationTransition("batch child finalization CAS failed")
        batch = await session.execute(
            update(MutationBatch)
            .where(
                MutationBatch.batch_id == batch_id,
                MutationBatch.state == MutationState.FORWARD_APPLIED,
            )
            .values(state=MutationState.FINALIZED)
        )
        if batch.rowcount != 1:
            raise IllegalMutationTransition("batch finalization CAS failed")
        await session.execute(
            update(SyncOutbox)
            .where(SyncOutbox.batch_id == batch_id, SyncOutbox.visible.is_(False))
            .values(visible=True)
        )
        await session.flush()

    async def finalize_batch(self, batch_id: str) -> BatchMutationResult:
        async with self._sessions.begin() as session:
            await self.finalize_batch_in_transaction(session, batch_id)
        found = await self.find_batch(batch_id)
        if found is None:
            raise IllegalMutationTransition("finalized batch receipt disappeared")
        return found.result

    async def state(self, operation_id: str) -> MutationState:
        async with self._sessions() as session:
            value = await session.scalar(
                select(MutationOperation.state).where(
                    MutationOperation.operation_id == operation_id
                )
            )
        if value is None:
            raise IllegalMutationTransition(f"unknown operation: {operation_id}")
        return MutationState(value)

    async def visible_event_count(self, batch_id: str) -> int:
        async with self._sessions() as session:
            value = await session.scalar(
                select(func.count())
                .select_from(SyncOutbox)
                .where(SyncOutbox.batch_id == batch_id, SyncOutbox.visible.is_(True))
            )
        return int(value or 0)
