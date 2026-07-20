"""Transaction-bound compare-and-swap operations for the mutation journal."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mutation import MutationBatch, MutationOperation
from app.models.sync_outbox import SyncOutbox
from app.mutation.types import MutationState

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


class MutationJournal:
    def __init__(self, session_factory: Callable[[], AsyncSession]) -> None:
        self._sessions = session_factory

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

    async def finalize_batch(self, batch_id: str) -> None:
        async with self._sessions.begin() as session:
            await self.finalize_batch_in_transaction(session, batch_id)

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
