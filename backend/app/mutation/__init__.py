"""Durable mutation journal primitives."""

from typing import Any

from app.mutation.types import (
    MUTATION_STATES,
    STEP_STATES,
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
    ProjectionPlan,
    StepState,
    SyncEventPlan,
    canonical_payload_hash,
    decode_persisted_command,
    require_payload_hash,
)

_JOURNAL_EXPORTS = {
    "LEGAL_TRANSITIONS",
    "IllegalMutationTransition",
    "MutationJournal",
}


def __getattr__(name: str) -> Any:
    if name not in _JOURNAL_EXPORTS:
        raise AttributeError(name)
    from app.mutation import journal

    return getattr(journal, name)


__all__ = [
    "MUTATION_STATES",
    "STEP_STATES",
    "MutationState",
    "StepState",
    "LEGAL_TRANSITIONS",
    "IllegalMutationTransition",
    "MutationJournal",
    "BatchMutationResult",
    "DbMutationPlan",
    "MutationCommand",
    "MutationRejection",
    "MutationRequest",
    "MutationResult",
    "MutationRuleViolation",
    "PersistedMutationCommand",
    "PreparedBatchItem",
    "ProjectionPlan",
    "SyncEventPlan",
    "canonical_payload_hash",
    "decode_persisted_command",
    "require_payload_hash",
]
