"""Pydantic wire schemas for FocusSession and ActiveSession contract routes.

Defines ``CanonicalUtc`` (strict UTC ``...Z`` string), all operation-specific
active-session request schemas, and the FocusSession review/reconcile schemas.
"""
from __future__ import annotations

import re
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from app.schemas.task_space import CommandId, WireModel

# --------------------------------------------------------------------------- #
# CanonicalUtc
# --------------------------------------------------------------------------- #

_CANONICAL_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$"
)


def _validate_canonical_utc(value: str) -> str:
    if not isinstance(value, str) or _CANONICAL_UTC_PATTERN.fullmatch(value) is None:
        raise ValueError("canonical_utc")
    return value


CanonicalUtc = Annotated[str, AfterValidator(_validate_canonical_utc)]


# --------------------------------------------------------------------------- #
# Provisional snapshot schemas
# --------------------------------------------------------------------------- #


class ProvisionalSessionSnapshot(WireModel):
    session_revision: int = Field(ge=0)
    started_at: CanonicalUtc
    pause_started_at: CanonicalUtc | None = None
    planned_seconds: int = Field(gt=0)
    gross_seconds: int = Field(ge=0)
    paused_seconds: int = Field(ge=0)
    break_seconds: int = Field(ge=0)
    focused_seconds: int = Field(ge=0)
    validity: Literal["pending"]
    validity_reason: str | None = Field(default=None, max_length=500)
    review_state: Literal["not_required"]
    ownership_state: Literal["local_provisional"]
    session_note: str = Field(default="", max_length=20_000)


class ProvisionalTaskContextSnapshot(WireModel):
    project_id: str = Field(min_length=1, max_length=64)
    project_title_snapshot: str = Field(min_length=1, max_length=500)
    level2_work_item_id: str = Field(min_length=1, max_length=64)
    level2_title_snapshot: str = Field(min_length=1, max_length=500)
    level2_parent_id_snapshot: str | None = Field(default=None, max_length=64)
    level2_status_definition_id_snapshot: str = Field(min_length=1, max_length=64)
    level2_version_snapshot: int = Field(ge=0)
    level2_effort_lower_seconds_snapshot: int | None = Field(default=None, ge=0)
    level2_effort_upper_seconds_snapshot: int | None = Field(default=None, ge=0)
    linked_at: CanonicalUtc
    link_method: Literal["explicit", "contextual_confirmed"]


class ProvisionalPlanItemSnapshot(WireModel):
    id: str = Field(min_length=1, max_length=64)
    work_item_id: str = Field(min_length=1, max_length=64)
    title_snapshot: str = Field(min_length=1, max_length=500)
    level2_work_item_id_snapshot: str = Field(min_length=1, max_length=64)
    work_item_version_snapshot: int = Field(ge=0)
    plan_rank: int = Field(ge=0)
    source: Literal["before_start", "during_session"]
    added_at: CanonicalUtc
    removed_at: CanonicalUtc | None = None
    removal_reason: str | None = Field(default=None, max_length=500)
    current_during_session: bool
    completion_draft: bool


class ProvisionalFocusSessionSnapshot(WireModel):
    session: ProvisionalSessionSnapshot
    context: ProvisionalTaskContextSnapshot
    plan: list[ProvisionalPlanItemSnapshot]


class ActivateProvisionalPayload(WireModel):
    cached_at: CanonicalUtc
    cached_ownership_epoch: int | None = Field(default=None, gt=0)
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    snapshot: ProvisionalFocusSessionSnapshot
    expected_work_item_versions: dict[str, int]


class ActivationConflictValidityCorrection(WireModel):
    loser_validity: Literal["invalid"]
    loser_validity_reason: Literal["activation_conflict_loser"]


class ResolveActivationConflictPayload(WireModel):
    winner_role: Literal["active", "candidate"]
    decision_at: CanonicalUtc
    validity_correction: ActivationConflictValidityCorrection


# --------------------------------------------------------------------------- #
# Active-session request schemas
# --------------------------------------------------------------------------- #


class ActivateProvisionalRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ActivateProvisionalPayload


class ResolveActivationConflictRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ResolveActivationConflictPayload


class StartActiveSessionPayload(WireModel):
    level2_work_item_id: str = Field(min_length=1, max_length=64)
    level3_work_item_ids: list[str]
    planned_seconds: int = Field(gt=0)
    started_at: CanonicalUtc
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    expected_work_item_versions: dict[str, int]


class StartActiveSessionRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: StartActiveSessionPayload


class HeartbeatPayload(WireModel):
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    heartbeat_at: CanonicalUtc


class HeartbeatRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: HeartbeatPayload


class OwnedClockPayload(WireModel):
    expected_version: int = Field(ge=0)
    occurred_at: CanonicalUtc
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)


class PauseActiveSessionRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: OwnedClockPayload


class ResumeActiveSessionRequest(PauseActiveSessionRequest):
    pass


class EndActiveSessionPayload(OwnedClockPayload):
    timer_completion: Literal["completed", "ended_early", "interrupted"]
    validity: Literal["pending", "valid", "invalid"]
    validity_reason: str | None = Field(default=None, max_length=500)


class EndActiveSessionRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: EndActiveSessionPayload


class TakeoverPayload(WireModel):
    new_owner_device_id: str = Field(min_length=1, max_length=64)
    new_owner_tab_id: str = Field(min_length=1, max_length=64)


class TakeoverRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: TakeoverPayload


class OwnerProofPayload(WireModel):
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)


class UpdateActiveSessionNotePayload(OwnerProofPayload):
    expected_version: int = Field(ge=0)
    session_note: str = Field(max_length=20_000)


class UpdateActiveSessionNoteRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: UpdateActiveSessionNotePayload


class SetCurrentPlanItemPayload(OwnerProofPayload):
    work_item_id: str | None = Field(default=None, max_length=64)
    expected_plan_versions: dict[str, int]


class SetCurrentPlanItemRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: SetCurrentPlanItemPayload


class SetCompletionDraftPayload(OwnerProofPayload):
    plan_item_id: str = Field(min_length=1, max_length=64)
    expected_plan_version: int = Field(ge=0)
    completion_draft: bool


class SetCompletionDraftRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: SetCompletionDraftPayload


class AddPlanItemPayload(OwnerProofPayload):
    work_item_id: str = Field(min_length=1, max_length=64)
    expected_work_item_version: int = Field(ge=0)
    plan_rank: int = Field(ge=0)
    added_at: CanonicalUtc


class AddPlanItemRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: AddPlanItemPayload


class RemovePlanItemPayload(OwnerProofPayload):
    plan_item_id: str = Field(min_length=1, max_length=64)
    expected_plan_version: int = Field(ge=0)
    removed_at: CanonicalUtc
    removal_reason: str = Field(min_length=1, max_length=500)


class RemovePlanItemRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: RemovePlanItemPayload


# --------------------------------------------------------------------------- #
# FocusSession review and reconcile schemas
# --------------------------------------------------------------------------- #


class ReviewOutcomePayload(WireModel):
    work_item_id: str = Field(min_length=1, max_length=64)
    touched: bool
    result: Literal["completed", "progressed", "stuck", "untouched", "cancelled"]
    execution_persona: Literal["ox", "pig", "hajimi", "wukong"] | None = None
    persona_switched: bool | None = None
    persona_note: str | None = Field(default=None, max_length=2_000)
    state_command: Literal["complete", "cancel", "none"]
    expected_work_item_version: int = Field(ge=0)


class SubmitFocusSessionReviewPayload(WireModel):
    expected_version: int = Field(ge=0)
    validity: Literal["valid", "invalid"]
    review_state: Literal["completed", "skipped"]
    reviewed_at: CanonicalUtc
    outcomes: list[ReviewOutcomePayload]


class SubmitFocusSessionReviewRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: SubmitFocusSessionReviewPayload


class ReconcileFocusSessionCommandsPayload(WireModel):
    command_ids: list[CommandId] = Field(min_length=1)
    replay_safe: bool
    abandon_command_ids: list[CommandId] = Field(default_factory=list)
    decision_at: CanonicalUtc | None = None

    @model_validator(mode="after")
    def validate_abandonment(self) -> Self:
        if len(set(self.command_ids)) != len(self.command_ids):
            raise ValueError("commandIds must be unique")
        if len(set(self.abandon_command_ids)) != len(self.abandon_command_ids):
            raise ValueError("abandonCommandIds must be unique")
        if not set(self.abandon_command_ids) <= set(self.command_ids):
            raise ValueError("abandonCommandIds must be a commandIds subset")
        if bool(self.abandon_command_ids) != (self.decision_at is not None):
            raise ValueError("decisionAt is required exactly for abandonment")
        return self


class ReconcileFocusSessionCommandsRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ReconcileFocusSessionCommandsPayload

    @model_validator(mode="after")
    def validate_root_operation_namespace(self) -> Self:
        if self.command_id in self.payload.command_ids:
            raise ValueError("root commandId must differ from every envelope commandId")
        return self
