"""Durable, idempotent mutation orchestration under one Space lease."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.errors import (
    IdempotencyConflictError,
    MutationRejectedError,
    SpaceRecoveryRequiredError,
)
from app.file_system.interfaces import FencedProjectionExecutor
from app.models.mutation import MutationOperation
from app.mutation.journal import JournalBatch, MutationJournal
from app.mutation.types import (
    BatchMutationResult,
    DbMutationPlan,
    MutationCommand,
    MutationRejection,
    MutationRequest,
    MutationResult,
    MutationRuleViolation,
    MutationState,
    PersistedMutationCommand,
    PreparedBatchItem,
    SyncEventPlan,
    bounded_child_operation_id,
    canonical_json_bytes,
    decode_persisted_command,
    validate_operation_id,
)
from app.runtime.leases import Lease
from app.runtime.space import SpaceRuntimeHandle
from app.services.sync_outbox import record_sync_event


def hash_prepared_batch_identity(
    identities: tuple[tuple[int, str, str], ...],
) -> str:
    """Hash caller identity before authority reads can classify its intent."""
    return hashlib.sha256(canonical_json_bytes(identities)).hexdigest()


@dataclass(frozen=True, slots=True)
class BatchCompilation:
    operation_ids: tuple[str, ...]
    commands: tuple[MutationCommand, ...]
    rejected: tuple[MutationRejection, ...]


class DbMutationPlanFactory(Protocol):
    def insert(self, row: object) -> DbMutationPlan: ...
    def update(self, before: object, after: object) -> DbMutationPlan: ...
    def delete(self, row: object) -> DbMutationPlan: ...


class SyncEventPlanFactory(Protocol):
    def create(self, row: object) -> SyncEventPlan: ...
    def update(self, row: object) -> SyncEventPlan: ...
    def delete(self, row: object, *, deleted_at: str) -> SyncEventPlan: ...


class MutationDomainPolicy(Protocol):
    @property
    def entity_types(self) -> frozenset[str]: ...

    async def compile(self, context: "MutationCompileContext", request: MutationRequest) -> MutationCommand: ...


@dataclass(frozen=True, slots=True)
class MutationCompileContext:
    scope: SpaceRuntimeHandle
    authority: "AuthorityOverlay"
    catalog: object

    def require_space(self, payload_space_id: str) -> None:
        if payload_space_id != self.scope.scope.space_id:
            raise MutationRuleViolation(
                "space_scope_mismatch",
                {"scopeSpaceId": self.scope.scope.space_id, "payloadSpaceId": payload_space_id},
            )


class AuthorityOverlay:
    """A deterministic in-memory projection of accepted commands in this batch."""

    def __init__(self) -> None:
        self.commands: list[MutationCommand] = []

    @classmethod
    async def from_locked_authorities(cls, scope, session, catalog) -> "AuthorityOverlay":
        # The enclosing UoW holds the Space-exclusive lease before this read.
        del scope, session, catalog
        return cls()

    def apply(self, command: MutationCommand) -> None:
        self.commands.append(command)


class MutationCompiler:
    """Compile policies against one lease-scoped authority overlay."""

    def __init__(self, catalog: object, policies: Sequence[MutationDomainPolicy] = ()) -> None:
        self.catalog = catalog
        self._policies: dict[str, MutationDomainPolicy] = {}
        for policy in policies:
            for entity_type in policy.entity_types:
                if entity_type in self._policies:
                    raise ValueError(f"duplicate mutation policy: {entity_type}")
                self._policies[entity_type] = policy

    async def compile_against_overlay(
        self, scope: SpaceRuntimeHandle, request: MutationRequest, overlay: AuthorityOverlay
    ) -> MutationCommand:
        policy = self._policies.get(request.entity_type)
        if policy is None:
            raise MutationRuleViolation("not_found", {"entityType": request.entity_type})
        return await policy.compile(MutationCompileContext(scope, overlay, self.catalog), request)

    async def compile_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        session: AsyncSession,
    ) -> BatchCompilation:
        overlay = await AuthorityOverlay.from_locked_authorities(scope, session, self.catalog)
        accepted_ids: list[str] = []
        commands: list[MutationCommand] = []
        rejected: list[MutationRejection] = []
        for item in items:
            if item.request is None:
                continue
            try:
                command = await self.compile_against_overlay(scope, item.request, overlay)
            except MutationRuleViolation as exc:
                rejected.append(
                    MutationRejection(
                        item.request_index,
                        item.operation_id,
                        item.request.entity_type,
                        item.request.entity_id,
                        exc.code,
                        exc.retryable,
                        exc.details,
                    )
                )
            else:
                overlay.apply(command)
                accepted_ids.append(item.operation_id)
                commands.append(command)
        return BatchCompilation(tuple(accepted_ids), tuple(commands), tuple(rejected))


class DbMutationInterpreter:
    """Interpret typed journal plans using models from the frozen catalog."""

    def __init__(self, catalog: object) -> None:
        self.catalog = catalog

    def decode_command(self, command_json: str) -> PersistedMutationCommand:
        return decode_persisted_command(command_json)

    def _model_for_plan(self, plan: DbMutationPlan):
        for spec in self.catalog.list():
            if spec.table_name == plan.table:
                return self.catalog.model_for(spec.name), spec.primary_key
        raise SpaceRecoveryRequiredError(f"unknown persisted mutation table: {plan.table}")

    async def apply(
        self, session: AsyncSession, plans: Sequence[DbMutationPlan]
    ) -> tuple[Mapping[str, object], ...]:
        applied: list[Mapping[str, object]] = []
        for plan in plans:
            model, primary_key = self._model_for_plan(plan)
            identity = plan.primary_key[primary_key]
            if plan.operation == "insert":
                if plan.after_row is None:
                    raise SpaceRecoveryRequiredError("insert plan has no after image")
                session.add(model(**dict(plan.after_row)))
                applied.append(plan.after_row)
                continue
            row = await session.get(model, identity)
            if row is None:
                raise MutationRuleViolation("not_found", {"entityId": identity})
            if plan.expected_version is not None and getattr(row, "version", None) != plan.expected_version:
                raise MutationRuleViolation("version_conflict", {"entityId": identity})
            if plan.operation == "update":
                if plan.after_row is None:
                    raise SpaceRecoveryRequiredError("update plan has no after image")
                for key, value in plan.after_row.items():
                    setattr(row, key, value)
                applied.append(plan.after_row)
            else:
                await session.delete(row)
                applied.append(plan.before_row or {})
        await session.flush()
        return tuple(applied)

    async def restore_before(self, session: AsyncSession, plans: Sequence[DbMutationPlan]) -> None:
        for plan in reversed(tuple(plans)):
            model, primary_key = self._model_for_plan(plan)
            identity = plan.primary_key[primary_key]
            row = await session.get(model, identity)
            if plan.operation == "insert":
                if row is not None:
                    await session.delete(row)
            elif plan.before_row is not None:
                if row is None:
                    session.add(model(**dict(plan.before_row)))
                else:
                    for key, value in plan.before_row.items():
                        setattr(row, key, value)
        await session.flush()


def child_operation_ids(batch_id: str, count: int) -> tuple[str, ...]:
    return tuple(bounded_child_operation_id(batch_id, f"{index:04d}") for index in range(count))


class RecoveryGate(Protocol):
    async def require_clean_under_lease(
        self, scope: SpaceRuntimeHandle, lease: Lease, journal: MutationJournal
    ) -> None: ...


class MutationJournalFactory(Protocol):
    def __call__(self, session_factory: async_sessionmaker[AsyncSession]) -> MutationJournal: ...


class MutationUnitOfWork:
    def __init__(
        self,
        *,
        catalog: object,
        compiler: MutationCompiler,
        interpreter: DbMutationInterpreter,
        projection_executor: FencedProjectionExecutor,
        recovery_gate: RecoveryGate,
        journal_factory: MutationJournalFactory,
    ) -> None:
        self.catalog = catalog
        self.compiler = compiler
        self.interpreter = interpreter
        self.projection_executor = projection_executor
        self.recovery_gate = recovery_gate
        self.journal_factory = journal_factory

    async def execute(
        self, scope: SpaceRuntimeHandle, request: MutationRequest, operation_id: str
    ) -> MutationResult:
        outcome = await self.execute_batch(scope, (request,), operation_id, operation_ids=(operation_id,))
        if outcome.rejected:
            raise MutationRejectedError(outcome.rejected[0])
        return outcome.applied[0]

    async def execute_batch(
        self,
        scope: SpaceRuntimeHandle,
        requests: Sequence[MutationRequest],
        batch_id: str,
        *,
        operation_ids: Sequence[str] | None = None,
    ) -> BatchMutationResult:
        requested = tuple(requests)
        resolved_ids = tuple(operation_ids) if operation_ids is not None else child_operation_ids(batch_id, len(requested))
        if len(resolved_ids) != len(requested) or len(set(resolved_ids)) != len(resolved_ids):
            raise ValueError("operation_ids must be unique and align with requests")
        return await self.execute_prepared_batch(
            scope,
            tuple(
                PreparedBatchItem(index, operation_id, request.request_hash, request, None)
                for index, (operation_id, request) in enumerate(zip(resolved_ids, requested, strict=True))
            ),
            batch_id,
        )

    async def execute_prepared_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        batch_id: str,
    ) -> BatchMutationResult:
        validate_operation_id(batch_id)
        prepared = tuple(items)
        if not prepared:
            return BatchMutationResult(batch_id, (), ())
        if tuple(item.request_index for item in prepared) != tuple(range(len(prepared))):
            raise ValueError("prepared items must have contiguous input-order indices")
        operation_ids = tuple(item.operation_id for item in prepared)
        if len(set(operation_ids)) != len(operation_ids):
            raise ValueError("prepared operation IDs must be unique")
        for operation_id in operation_ids:
            validate_operation_id(operation_id)
        request_hash = hash_prepared_batch_identity(
            tuple((item.request_index, item.operation_id, item.intent_hash) for item in prepared)
        )
        async with scope.exclusive_space_resources("mutation", 5) as lease:
            journal = self.journal_factory(scope.session_factory)
            await self.recovery_gate.require_clean_under_lease(scope, lease, journal)
            existing = await journal.find_batch(batch_id)
            if existing is not None:
                return await self._resume_or_return(existing, request_hash)
            bindings = await journal.find_operation_batch_bindings(operation_ids)
            foreign_bindings = tuple(
                sorted((operation_id, owner) for operation_id, owner in bindings.items() if owner != batch_id)
            )
            if foreign_bindings:
                operation_id, owner_batch_id = foreign_bindings[0]
                raise IdempotencyConflictError(
                    operation_id=operation_id,
                    existing_batch_id=owner_batch_id,
                    requested_batch_id=batch_id,
                )
            if bindings:
                raise SpaceRecoveryRequiredError("operation binding exists without its owning batch receipt")
            async with scope.session_factory() as session:
                compilation = await self.compiler.compile_batch(scope, prepared, session)
            rejections = tuple(
                sorted(
                    (
                        *(item.pre_rejection for item in prepared if item.pre_rejection is not None),
                        *compilation.rejected,
                    ),
                    key=lambda rejection: rejection.request_index,
                )
            )
            if not compilation.commands:
                return await journal.record_rejected_batch(batch_id, request_hash, rejections)
            await journal.create_batch_intent(
                batch_id, request_hash, compilation.operation_ids, compilation.commands, rejections
            )
            manifests = await self._publish_stages(scope, lease, compilation.operation_ids, compilation.commands)
            await journal.mark_staged(batch_id, manifests)
            await self._commit_business(scope, journal, batch_id, compilation.operation_ids, compilation.commands)
            await journal.mark_finalizing(batch_id)
            await self._finalize_forward(
                scope, journal, batch_id, compilation.operation_ids, compilation.commands,
                lease.fence_receipt(scope.scope.space_id),
            )
            return await journal.finalize_batch(batch_id)

    async def _resume_or_return(self, existing: JournalBatch, request_hash: str) -> BatchMutationResult:
        if existing.request_hash != request_hash:
            raise IdempotencyConflictError(requested_batch_id=existing.batch_id)
        if existing.state not in (MutationState.FINALIZED, MutationState.ABORTED):
            raise SpaceRecoveryRequiredError("existing mutation receipt requires recovery")
        return existing.result

    async def _publish_stages(self, scope, lease, operation_ids, commands) -> tuple[object, ...]:
        stages = scope.mutation_stages
        if stages is None:
            raise SpaceRecoveryRequiredError("Space mutation stages are not active")
        manifests = []
        for operation_id, command in zip(operation_ids, commands, strict=True):
            manifests.append(
                await stages.publish(
                    operation_id,
                    command.projections,
                    lease=lease,
                    space_id=scope.scope.space_id,
                )
            )
        return tuple(manifests)

    async def _commit_business(self, scope, journal, batch_id, operation_ids, commands) -> None:
        async with scope.session_factory.begin() as session:
            for operation_id, command in zip(operation_ids, commands, strict=True):
                async with session.begin_nested():
                    before_after = await self.interpreter.apply(session, command.db_plans)
                    operation = await session.get(MutationOperation, operation_id)
                    if operation is None or operation.batch_id != batch_id:
                        raise SpaceRecoveryRequiredError("journal operation disappeared during business commit")
                    operation.db_before_json = json.dumps(
                        [dict(plan.before_row or {}) for plan in command.db_plans], separators=(",", ":")
                    )
                    operation.db_after_json = json.dumps(
                        [dict(item) for item in before_after], separators=(",", ":")
                    )
            for operation_id, command in zip(operation_ids, commands, strict=True):
                await MutationJournal.transition_in_transaction(
                    session, operation_id, MutationState.STAGED, MutationState.DB_COMMITTED
                )
                for event in command.sync_events:
                    spec = self.catalog.get(event.entity_type)
                    if not spec.sync_enabled:
                        raise MutationRuleViolation("not_found", {"entityType": event.entity_type})
                    await record_sync_event(
                        session,
                        entity_type=spec.effective_sync_entity_type,
                        entity_id=event.entity_id,
                        action=event.action,
                        payload=event.payload,
                        operation_id=operation_id,
                        batch_id=batch_id,
                        version=event.version,
                        created_at=event.created_at,
                        visible=False,
                    )

    async def _finalize_forward(self, scope, journal, batch_id, operation_ids, commands, receipt) -> None:
        for operation_id, command in zip(operation_ids, commands, strict=True):
            await self.projection_executor.apply_forward(scope, operation_id, command.persisted(), receipt)
            await journal.transition(operation_id, MutationState.FORWARD_APPLIED)
