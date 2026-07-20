"""Canonical persisted mutation journal state literals."""

from __future__ import annotations

from enum import StrEnum


class MutationState(StrEnum):
    INTENT = "INTENT"
    STAGED = "STAGED"
    DB_COMMITTED = "DB_COMMITTED"
    FINALIZING = "FINALIZING"
    FORWARD_APPLIED = "FORWARD_APPLIED"
    FINALIZED = "FINALIZED"
    ABORTED = "ABORTED"
    COMPENSATING = "COMPENSATING"
    COMPENSATED = "COMPENSATED"
    FAILED_MANUAL = "FAILED_MANUAL"


class StepState(StrEnum):
    PENDING = "PENDING"
    APPLIED = "APPLIED"
    COMPENSATED = "COMPENSATED"


MUTATION_STATES = tuple(state.value for state in MutationState)
STEP_STATES = tuple(state.value for state in StepState)
