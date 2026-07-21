"""Lease-bound restart recovery for durable mutation batches."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from sqlalchemy import delete, select

from app.errors import SpaceRecoveryRequiredError
from app.models.mutation import MutationBatch, MutationOperation, MutationStep
from app.models.sync_outbox import SyncOutbox
from app.mutation.journal import LEGAL_TRANSITIONS, IllegalMutationTransition, MutationJournal
from app.mutation.staging import StageIntegrityError
from app.mutation.types import (
    MutationState,
    PersistedMutationCommand,
    ProjectionActionTag,
    RecoveryInspection,
    RecoveryResult,
    StepState,
    persisted_command_bytes,
)
from app.runtime.leases import Lease, LeaseMode, LeaseOrderError
from app.services.sync_outbox import record_sync_event


class RecoveryAction(StrEnum):
    VALIDATE_STAGE_OR_ABORT = "validate_stage_or_abort"
    APPLY_BUSINESS_OR_ABORT = "apply_business_or_abort"
    FINALIZE_FORWARD_THEN_COMPENSATE = "finalize_forward_then_compensate"
    FINISH_BATCH_OR_COMPENSATE = "finish_batch_or_compensate"
    RESUME_COMPENSATION = "resume_compensation"


RECOVERY_ACTION = {
    MutationState.INTENT: RecoveryAction.VALIDATE_STAGE_OR_ABORT,
    MutationState.STAGED: RecoveryAction.APPLY_BUSINESS_OR_ABORT,
    MutationState.DB_COMMITTED: RecoveryAction.FINALIZE_FORWARD_THEN_COMPENSATE,
    MutationState.FINALIZING: RecoveryAction.FINALIZE_FORWARD_THEN_COMPENSATE,
    MutationState.FORWARD_APPLIED: RecoveryAction.FINISH_BATCH_OR_COMPENSATE,
    MutationState.COMPENSATING: RecoveryAction.RESUME_COMPENSATION,
}


# Kept as executable public data so the parameterized test cannot silently omit
# a persistence boundary. Values describe the required terminal authority.
FAULT_OUTCOME = {
    "before/at INTENT commit": "all-old",
    "temporary stage blob write": "all-old",
    "manifest write/fsync": "all-old",
    "atomic stage rename": "all-new",
    "after each accepted child stage publish": "all-old",
    "before/at batch mark_staged commit": "all-new",
    "STAGED commit": "all-new",
    "ORM flush/savepoint": "all-new",
    "invisible index/ledger insert in outer transaction": "all-new",
    "outer business commit": "all-new",
    "FINALIZING commit": "all-new",
    "Markdown finalize": "all-new",
    "path/frontmatter finalize": "all-new",
    "index row commit": "all-new",
    "FTS commit": "all-new",
    "version/trash finalize": "all-new",
    "terminal status/visibility commit": "all-new",
    "missing/corrupt after-image after DB commit": "all-old",
    "corrupt forward and inverse images": "failed-manual",
    "orphan temp/published stage": "all-old",
    "restart from every nonterminal state": "all-old",
    "accepted batch child finalize failure": "all-old",
}

_TERMINAL = frozenset(
    {MutationState.FINALIZED, MutationState.ABORTED, MutationState.COMPENSATED}
)


class RecoveryUnprovableError(SpaceRecoveryRequiredError):
    """The persisted before/after evidence cannot prove a safe convergence."""


@dataclass(frozen=True, slots=True)
class _Operation:
    row: MutationOperation
    command: PersistedMutationCommand
    manifest: Any | None
    steps: tuple[MutationStep, ...]


def _require_matching_leases(scope: Any, space_lease: Lease) -> None:
    global_lease = getattr(scope, "global_lease", None)
    if global_lease is None or not hasattr(global_lease, "assert_active_owner"):
        raise LeaseOrderError("recovery scope has no active global lease")
    global_lease.assert_active_owner(scope="global")
    if global_lease.mode not in (LeaseMode.SHARED, LeaseMode.EXCLUSIVE):
        raise LeaseOrderError("recovery requires a shared or exclusive global lease")
    if getattr(scope, "space_lease", None) is not space_lease:
        raise LeaseOrderError("recovery requires the handle's matching Space lease")
    space_lease.assert_active_owner(
        mode=LeaseMode.EXCLUSIVE,
        scope=scope.scope.space_id,
    )


def _digest(value: bytes | None) -> tuple[str | None, int | None]:
    if value is None:
        return None, None
    return hashlib.sha256(value).hexdigest(), len(value)


class MutationRecovery:
    """Recover every pending batch under an already-held Space-exclusive lease."""

    def __init__(
        self,
        *,
        catalog: Any,
        interpreter: Any,
        projection_executor: Any,
        journal_factory: Any = MutationJournal,
    ) -> None:
        self.catalog = catalog
        self.interpreter = interpreter
        self.projection_executor = projection_executor
        self.journal_factory = journal_factory

    async def inspect(self, view: Any) -> RecoveryInspection:
        factory = view.session_factory if hasattr(view, "session_factory") else view
        pending: list[str] = []
        failed: list[str] = []
        reasons: list[str] = []
        async with factory() as session:
            rows = tuple(
                await session.scalars(
                    select(MutationBatch).order_by(MutationBatch.batch_id)
                )
            )
        for row in rows:
            state = MutationState(row.state)
            if state in _TERMINAL:
                continue
            pending.append(row.batch_id)
            if state is MutationState.FAILED_MANUAL:
                failed.append(row.batch_id)
                reasons.append("mutation_recovery_required")
        return RecoveryInspection(
            tuple(pending),
            tuple(failed),
            (),
            not pending,
            tuple(reasons),
        )

    async def require_clean_under_lease(
        self,
        scope: Any,
        lease: Lease,
        _journal: MutationJournal,
    ) -> None:
        result = await self.recover_under_lease(scope, lease)
        if result.failed_manual:
            raise SpaceRecoveryRequiredError(
                "space recovery requires manual intervention"
            )

    async def recover_under_lease(
        self,
        scope: Any,
        space_lease: Lease,
    ) -> RecoveryResult:
        _require_matching_leases(scope, space_lease)
        stages = getattr(scope, "mutation_stages", None)
        if stages is None:
            raise SpaceRecoveryRequiredError("Space mutation stages are not active")

        async with scope.session_factory() as session:
            live = frozenset(
                await session.scalars(
                    select(MutationOperation.operation_id).where(
                        MutationOperation.state.not_in(tuple(_TERMINAL))
                    )
                )
            )
            batches = tuple(
                await session.scalars(
                    select(MutationBatch).order_by(MutationBatch.batch_id)
                )
            )
        await stages.collect_orphans(
            live_operation_ids=set(live),
            lease=space_lease,
            space_id=scope.scope.space_id,
        )

        finalized: list[str] = []
        aborted: list[str] = []
        compensated: list[str] = []
        failed_manual: list[str] = []
        for batch in batches:
            state = MutationState(batch.state)
            if state in _TERMINAL:
                continue
            if state is MutationState.FAILED_MANUAL:
                failed_manual.append(batch.batch_id)
                break
            try:
                outcome = await self._recover_batch(
                    scope,
                    space_lease,
                    batch.batch_id,
                    state,
                )
            except RecoveryUnprovableError:
                await self._mark_failed_manual(scope, batch.batch_id)
                failed_manual.append(batch.batch_id)
                break
            if outcome is MutationState.FINALIZED:
                finalized.append(batch.batch_id)
            elif outcome is MutationState.ABORTED:
                aborted.append(batch.batch_id)
            elif outcome is MutationState.COMPENSATED:
                compensated.append(batch.batch_id)
            elif outcome is MutationState.FAILED_MANUAL:
                failed_manual.append(batch.batch_id)

        if failed_manual:
            await self._degrade_space(scope, space_lease)
        return RecoveryResult(
            tuple(finalized),
            tuple(aborted),
            tuple(compensated),
            tuple(failed_manual),
        )

    async def _load_operations(
        self,
        scope: Any,
        batch_id: str,
        *,
        tolerate_missing_stage: bool,
    ) -> tuple[_Operation, ...]:
        async with scope.session_factory() as session:
            batch = await session.get(MutationBatch, batch_id)
            rows = tuple(
                await session.scalars(
                    select(MutationOperation)
                    .where(MutationOperation.batch_id == batch_id)
                    .order_by(MutationOperation.sequence)
                )
            )
            step_rows = {
                row.operation_id: tuple(
                    await session.scalars(
                        select(MutationStep)
                        .where(MutationStep.operation_id == row.operation_id)
                        .order_by(MutationStep.ordinal)
                    )
                )
                for row in rows
            }
        if batch is None or len(rows) != batch.accepted_count or not rows:
            raise RecoveryUnprovableError(
                "mutation batch child set is not complete"
            )
        if tuple(row.sequence for row in rows) != tuple(range(len(rows))):
            raise RecoveryUnprovableError(
                "mutation batch child sequence is not contiguous"
            )

        loaded: list[_Operation] = []
        for row in rows:
            try:
                command = self.interpreter.decode_command(row.command_json)
            except (TypeError, ValueError, SpaceRecoveryRequiredError) as error:
                raise RecoveryUnprovableError(
                    "persisted mutation command is invalid"
                ) from error
            if (
                command.command_hash != row.command_hash
                or persisted_command_bytes(command).decode("utf-8")
                != row.command_json
            ):
                raise RecoveryUnprovableError(
                    "persisted mutation command does not match its journal hash"
                )
            try:
                manifest = scope.mutation_stages.verify(row.operation_id)
            except (FileNotFoundError, StageIntegrityError) as error:
                if tolerate_missing_stage:
                    manifest = None
                else:
                    raise RecoveryUnprovableError(
                        "published stage is missing or invalid"
                    ) from error
            if manifest is not None:
                descriptors = tuple(step.descriptor for step in manifest.steps)
                if descriptors != command.projections:
                    raise RecoveryUnprovableError(
                        "published stage does not match the persisted command"
                    )
                if (
                    row.manifest_sha256 is not None
                    and manifest.manifest_sha256 != row.manifest_sha256
                ):
                    if tolerate_missing_stage:
                        manifest = None
                    else:
                        raise RecoveryUnprovableError(
                            "published stage hash does not match the journal"
                        )
            steps = step_rows[row.operation_id]
            if len(steps) != len(command.projections):
                raise RecoveryUnprovableError(
                    "mutation projection step set is incomplete"
                )
            for step, descriptor in zip(steps, command.projections, strict=True):
                if (
                    step.ordinal != descriptor.ordinal
                    or step.name != descriptor.tag.value
                    or step.store != descriptor.tag.value
                    or step.target != str(descriptor.target)
                    or step.before_hash != descriptor.before_sha256
                    or step.after_hash != descriptor.after_sha256
                ):
                    raise RecoveryUnprovableError(
                        "mutation projection step differs from persisted command"
                    )
                step_state = StepState(step.state)
                expected_applied = {
                    StepState.PENDING: None,
                    StepState.APPLIED: descriptor.after_sha256,
                    StepState.COMPENSATED: descriptor.before_sha256,
                }[step_state]
                if step.applied_hash != expected_applied:
                    raise RecoveryUnprovableError(
                        "mutation projection step hash evidence is invalid"
                    )
            loaded.append(_Operation(row, command, manifest, steps))
        return tuple(loaded)

    async def _recover_batch(
        self,
        scope: Any,
        lease: Lease,
        batch_id: str,
        state: MutationState,
    ) -> MutationState:
        operations = await self._load_operations(
            scope,
            batch_id,
            tolerate_missing_stage=True,
        )
        if state is MutationState.INTENT:
            if not all(operation.manifest is not None for operation in operations):
                await self._set_batch_state(
                    scope,
                    batch_id,
                    MutationState.ABORTED,
                )
                await self._collect_terminal_stages(scope, lease)
                return MutationState.ABORTED
            journal = self.journal_factory(scope.session_factory)
            await journal.mark_staged(
                batch_id,
                tuple(operation.manifest for operation in operations),
            )
            state = MutationState.STAGED
            operations = await self._load_operations(
                scope,
                batch_id,
                tolerate_missing_stage=False,
            )

        if state is MutationState.STAGED:
            if not all(operation.manifest is not None for operation in operations):
                await self._set_batch_state(
                    scope,
                    batch_id,
                    MutationState.ABORTED,
                )
                await self._collect_terminal_stages(scope, lease)
                return MutationState.ABORTED
            await self._apply_business(scope, batch_id, operations)
            state = MutationState.DB_COMMITTED

        journal = self.journal_factory(scope.session_factory)
        if state is MutationState.DB_COMMITTED:
            await journal.mark_finalizing(batch_id)
            state = MutationState.FINALIZING

        if state is MutationState.FINALIZING:
            try:
                await self._finish_forward(scope, lease, batch_id)
            except RecoveryUnprovableError:
                raise
            except BaseException as forward_error:
                try:
                    return await self._compensate(
                        scope,
                        lease,
                        batch_id,
                    )
                except BaseException as compensation_error:
                    raise RecoveryUnprovableError(
                        "neither forward nor inverse projection can be proven"
                    ) from BaseExceptionGroup(
                        "forward and compensation failed",
                        [forward_error, compensation_error],
                    )
            state = MutationState.FORWARD_APPLIED

        if state is MutationState.FORWARD_APPLIED:
            await self._finalize_batch(scope, batch_id)
            return MutationState.FINALIZED
        if state is MutationState.COMPENSATING:
            return await self._compensate(scope, lease, batch_id)
        return state

    async def _apply_business(
        self,
        scope: Any,
        batch_id: str,
        operations: tuple[_Operation, ...],
    ) -> None:
        async with scope.session_factory.begin() as session:
            connection = await session.connection()
            await connection.exec_driver_sql("BEGIN IMMEDIATE")
            for operation in operations:
                if MutationState(operation.row.state) is not MutationState.STAGED:
                    raise RecoveryUnprovableError(
                        "STAGED batch has a mixed child state"
                    )
                async with session.begin_nested():
                    await self.interpreter.apply(
                        session,
                        operation.command.db_plans,
                    )
                    row = await session.get(
                        MutationOperation,
                        operation.row.operation_id,
                    )
                    if row is None or row.batch_id != batch_id:
                        raise RecoveryUnprovableError(
                            "journal operation disappeared during replay"
                        )
                    row.db_before_json = self._db_image_json(
                        operation.command,
                        image="before",
                    )
                    row.db_after_json = self._db_image_json(
                        operation.command,
                        image="after",
                    )
                existing = tuple(
                    await session.scalars(
                        select(SyncOutbox)
                        .where(
                            SyncOutbox.operation_id
                            == operation.row.operation_id
                        )
                        .order_by(SyncOutbox.id)
                    )
                )
                if existing:
                    if len(existing) != len(operation.command.sync_events) or any(
                        event.visible for event in existing
                    ):
                        raise RecoveryUnprovableError(
                            "replayed ledger set is inconsistent"
                        )
                else:
                    for event in operation.command.sync_events:
                        spec = self.catalog.get(event.entity_type)
                        if not spec.sync_enabled:
                            raise RecoveryUnprovableError(
                                "persisted event entity is not sync enabled"
                            )
                        await record_sync_event(
                            session,
                            entity_type=spec.effective_sync_entity_type,
                            entity_id=event.entity_id,
                            action=event.action,
                            payload=event.payload,
                            operation_id=operation.row.operation_id,
                            batch_id=batch_id,
                            version=event.version,
                            created_at=event.created_at,
                            visible=False,
                            flush=False,
                        )
            for operation in operations:
                await MutationJournal.transition_in_transaction(
                    session,
                    operation.row.operation_id,
                    MutationState.STAGED,
                    MutationState.DB_COMMITTED,
                )

    @staticmethod
    def _db_image_json(
        command: PersistedMutationCommand,
        *,
        image: str,
    ) -> str:
        import json

        return json.dumps(
            [
                None
                if getattr(plan, f"{image}_row") is None
                else dict(getattr(plan, f"{image}_row"))
                for plan in command.db_plans
            ],
            separators=(",", ":"),
        )

    async def _finish_forward(
        self,
        scope: Any,
        lease: Lease,
        batch_id: str,
    ) -> None:
        operations = await self._load_operations(
            scope,
            batch_id,
            tolerate_missing_stage=True,
        )
        journal = self.journal_factory(scope.session_factory)
        receipt = lease.fence_receipt(scope.scope.space_id)
        for operation in operations:
            child_state = MutationState(operation.row.state)
            if child_state is MutationState.FORWARD_APPLIED:
                descriptor_states = tuple(
                    [
                        await self._descriptor_state(scope, descriptor)
                        for descriptor in operation.command.projections
                    ]
                )
                if any(state != "after" for state in descriptor_states):
                    raise RecoveryUnprovableError(
                        "FORWARD_APPLIED child does not match its after images"
                    )
                continue
            if child_state is not MutationState.FINALIZING:
                raise RecoveryUnprovableError(
                    "FINALIZING batch has an invalid child state"
                )
            await self._finish_projection_steps(scope, operation, receipt)
            await journal.transition(
                operation.row.operation_id,
                MutationState.FORWARD_APPLIED,
            )

    async def _finish_projection_steps(
        self, scope: Any, operation: _Operation, receipt: Any
    ) -> None:
        for descriptor in operation.command.projections:
            step = operation.steps[descriptor.ordinal]
            step_state = StepState(step.state)
            if step_state is StepState.APPLIED:
                if await self._descriptor_state(scope, descriptor) != "after":
                    raise RecoveryUnprovableError(
                        "applied projection step no longer matches its after evidence"
                    )
                continue
            if step_state is not StepState.PENDING:
                raise RecoveryUnprovableError(
                    "forward projection step has an invalid durable state"
                )
            state = await self._descriptor_state(scope, descriptor)
            if state == "after":
                await self._mark_step(
                    scope, step, StepState.APPLIED, descriptor.after_sha256
                )
                continue
            if state != "before":
                raise RecoveryUnprovableError(
                    "projection step matches neither before nor after evidence"
                )
            await self.projection_executor.apply_forward(
                scope,
                operation.row.operation_id,
                operation.command,
                receipt,
                ordinals=(descriptor.ordinal,),
            )
            if await self._descriptor_state(scope, descriptor) != "after":
                raise RecoveryUnprovableError(
                    "forward projection step did not produce its after image"
                )
            await self._mark_step(
                scope, step, StepState.APPLIED, descriptor.after_sha256
            )

    async def _compensate(
        self,
        scope: Any,
        lease: Lease,
        batch_id: str,
    ) -> MutationState:
        operations = await self._load_operations(
            scope,
            batch_id,
            tolerate_missing_stage=True,
        )
        async with scope.session_factory() as session:
            visible = await session.scalar(
                select(SyncOutbox.id).where(
                    SyncOutbox.batch_id == batch_id,
                    SyncOutbox.visible.is_(True),
                )
            )
        if visible is not None:
            raise RecoveryUnprovableError(
                "visible ledger cannot be compensated"
            )
        await self._set_batch_state(
            scope,
            batch_id,
            MutationState.COMPENSATING,
        )
        receipt = lease.fence_receipt(scope.scope.space_id)
        await self._compensate_projection_batch(scope, operations, receipt)
        async with scope.session_factory.begin() as session:
            for operation in reversed(operations):
                await self.interpreter.restore_before(
                    session,
                    operation.command.db_plans,
                )
            await session.execute(
                delete(SyncOutbox).where(SyncOutbox.batch_id == batch_id)
            )
        await self._set_batch_state(
            scope,
            batch_id,
            MutationState.COMPENSATED,
        )
        return MutationState.COMPENSATED

    async def _compensate_projection_batch(
        self, scope: Any, operations: tuple[_Operation, ...], receipt: Any
    ) -> None:
        for operation in reversed(operations):
            await self._compensate_projection_steps(scope, operation, receipt)

    async def _compensate_projection_steps(
        self, scope: Any, operation: _Operation, receipt: Any
    ) -> None:
        for descriptor in reversed(operation.command.projections):
            step = operation.steps[descriptor.ordinal]
            step_state = StepState(step.state)
            if step_state is StepState.COMPENSATED:
                if await self._descriptor_state(scope, descriptor) != "before":
                    raise RecoveryUnprovableError(
                        "compensated projection step no longer matches its before evidence"
                    )
                continue
            state = await self._descriptor_state(scope, descriptor)
            if state == "before":
                await self._mark_step(
                    scope, step, StepState.COMPENSATED, descriptor.before_sha256
                )
                continue
            if state != "after":
                raise RecoveryUnprovableError(
                    "inverse projection step matches neither before nor after evidence"
                )
            await self.projection_executor.restore_before(
                scope,
                operation.row.operation_id,
                operation.command,
                receipt,
                ordinals=(descriptor.ordinal,),
            )
            if await self._descriptor_state(scope, descriptor) != "before":
                raise RecoveryUnprovableError(
                    "inverse projection step did not produce its before image"
                )
            await self._mark_step(
                scope, step, StepState.COMPENSATED, descriptor.before_sha256
            )

    async def _mark_step(
        self,
        scope: Any,
        step: MutationStep,
        state: StepState,
        applied_hash: str | None,
    ) -> None:
        async with scope.session_factory.begin() as session:
            row = await session.get(MutationStep, step.id)
            if row is None:
                raise RecoveryUnprovableError(
                    "mutation projection step disappeared"
                )
            row.state = state
            row.applied_hash = applied_hash
        step.state = state
        step.applied_hash = applied_hash

    async def _descriptor_state(self, scope: Any, descriptor: Any) -> str:
        snapshot = await scope.file_system.snapshot_projection_authority()
        target = str(descriptor.target)
        source = None if descriptor.source is None else str(descriptor.source)
        if descriptor.tag is ProjectionActionTag.PATH_RENAME:
            before = (
                source is not None
                and _digest(snapshot.markdown.get(source))
                == (descriptor.before_sha256, descriptor.before_size)
                and target not in snapshot.markdown
            )
            after = (
                source is not None
                and source not in snapshot.markdown
                and _digest(snapshot.markdown.get(target))
                == (descriptor.after_sha256, descriptor.after_size)
            )
            return "after" if after else "before" if before else "neither"
        bucket = snapshot.markdown if target.startswith("notes/") else (
            snapshot.index if target.startswith("index/") else snapshot.fts
        )
        actual = _digest(bucket.get(target))
        before = actual == (descriptor.before_sha256, descriptor.before_size)
        after = actual == (descriptor.after_sha256, descriptor.after_size)
        return "after" if after else "before" if before else "neither"
    async def _set_batch_state(
        self,
        scope: Any,
        batch_id: str,
        target: MutationState,
    ) -> None:
        async with scope.session_factory.begin() as session:
            batch = await session.get(MutationBatch, batch_id)
            rows = tuple(
                await session.scalars(
                    select(MutationOperation)
                    .where(MutationOperation.batch_id == batch_id)
                    .order_by(MutationOperation.sequence)
                )
            )
            if batch is None or len(rows) != batch.accepted_count:
                raise IllegalMutationTransition(
                    "batch child set changed during recovery"
                )
            batch_state = MutationState(batch.state)
            if batch_state is not target:
                if target not in LEGAL_TRANSITIONS[batch_state]:
                    raise IllegalMutationTransition(
                        f"illegal batch transition: {batch_state} -> {target}"
                    )
                batch.state = target
            for row in rows:
                child_state = MutationState(row.state)
                if child_state is target:
                    continue
                if target not in LEGAL_TRANSITIONS[child_state]:
                    raise IllegalMutationTransition(
                        f"illegal child transition: {child_state} -> {target}"
                    )
                row.state = target

    async def _mark_failed_manual(
        self,
        scope: Any,
        batch_id: str,
    ) -> None:
        async with scope.session_factory.begin() as session:
            batch = await session.get(MutationBatch, batch_id)
            if batch is None or MutationState(batch.state) in _TERMINAL:
                return
            batch.state = MutationState.FAILED_MANUAL
            rows = tuple(
                await session.scalars(
                    select(MutationOperation).where(
                        MutationOperation.batch_id == batch_id
                    )
                )
            )
            for row in rows:
                row.state = MutationState.FAILED_MANUAL
                row.error_code = "mutation_recovery_required"

    async def _collect_terminal_stages(
        self,
        scope: Any,
        lease: Lease,
    ) -> None:
        async with scope.session_factory() as session:
            live = set(
                await session.scalars(
                    select(MutationOperation.operation_id).where(
                        MutationOperation.state.not_in(tuple(_TERMINAL))
                    )
                )
            )
        await scope.mutation_stages.collect_orphans(
            live_operation_ids=live,
            lease=lease,
            space_id=scope.scope.space_id,
        )

    async def _finalize_batch(self, scope: Any, batch_id: str) -> None:
        async with scope.session_factory.begin() as session:
            await MutationJournal.finalize_batch_in_transaction(
                session,
                batch_id,
            )

    async def _degrade_space(self, scope: Any, lease: Lease) -> None:
        runtime = getattr(scope, "_runtime", None)
        if runtime is None:
            return
        await runtime.begin_degraded_under_lease(
            scope,
            "mutation_recovery_required",
            lease,
        )
        await scope.close_space_resources()


async def inspect_recovery(view: Any) -> RecoveryInspection:
    factory = view.session_factory if hasattr(view, "session_factory") else view
    pending: list[str] = []
    failed: list[str] = []
    reasons: list[str] = []
    async with factory() as session:
        rows = tuple(
            await session.scalars(
                select(MutationBatch).order_by(MutationBatch.batch_id)
            )
        )
    for row in rows:
        state = MutationState(row.state)
        if state in _TERMINAL:
            continue
        pending.append(row.batch_id)
        if state is MutationState.FAILED_MANUAL:
            failed.append(row.batch_id)
            reasons.append("mutation_recovery_required")
    return RecoveryInspection(
        tuple(pending),
        tuple(failed),
        (),
        not pending,
        tuple(reasons),
    )
