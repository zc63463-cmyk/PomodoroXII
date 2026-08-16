"""Pydantic wire schemas for FocusSession and ActiveSession contract routes.

Defines ``CanonicalUtc`` (strict UTC ``...Z`` string), all operation-specific
active-session request schemas, and the FocusSession review/reconcile schemas.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from app.schemas.task_space import CommandId, WireModel, WireResponseModel

# --------------------------------------------------------------------------- #
# CanonicalUtc
# --------------------------------------------------------------------------- #

_CANONICAL_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$"
)


def _validate_canonical_utc(value: str) -> str:
    if not isinstance(value, str) or _CANONICAL_UTC_PATTERN.fullmatch(value) is None:
        raise ValueError("canonical_utc")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("canonical_utc") from exc
    return value


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


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

    @model_validator(mode="after")
    def validate_effort_bounds(self) -> Self:
        lower = self.level2_effort_lower_seconds_snapshot
        upper = self.level2_effort_upper_seconds_snapshot
        if lower is not None and upper is not None and lower > upper:
            raise ValueError("effort lower bound exceeds upper bound")
        return self


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

    @model_validator(mode="after")
    def validate_removal(self) -> Self:
        reason = self.removal_reason
        if self.removed_at is None:
            if reason is not None:
                raise ValueError("active plan item cannot have a removal reason")
        elif reason is None or not reason.strip():
            raise ValueError("removed plan item requires a nonblank reason")
        return self


class ProvisionalFocusSessionSnapshot(WireModel):
    session: ProvisionalSessionSnapshot
    context: ProvisionalTaskContextSnapshot
    plan: list[ProvisionalPlanItemSnapshot]


class ConflictSideIdentity(WireModel):
    space_id: CommandId
    session_id: CommandId


class ConflictPairIdentity(WireModel):
    active: ConflictSideIdentity
    candidate: ConflictSideIdentity

    @model_validator(mode="after")
    def validate_distinct(self) -> Self:
        if (
            self.active.space_id == self.candidate.space_id
            and self.active.session_id == self.candidate.session_id
        ):
            raise ValueError("conflict pair sides must not be identical")
        return self


class ActivateProvisionalPayload(WireModel):
    cached_at: CanonicalUtc
    cached_ownership_epoch: int | None = Field(default=None, gt=0)
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    pair: ConflictPairIdentity
    snapshot: ProvisionalFocusSessionSnapshot
    expected_work_item_versions: dict[str, int]

    @model_validator(mode="after")
    def validate_snapshot(self) -> Self:
        session = self.snapshot.session
        context = self.snapshot.context
        plan = self.snapshot.plan
        started = _utc(session.started_at)
        cached = _utc(self.cached_at)
        if started > cached:
            raise ValueError("Session startedAt must not exceed cachedAt")
        if session.gross_seconds != int((cached - started).total_seconds()):
            raise ValueError("gross seconds do not match the cached interval")
        if session.pause_started_at is not None:
            paused_at = _utc(session.pause_started_at)
            if paused_at < started or paused_at > cached:
                raise ValueError("pauseStartedAt must be within the cached interval")
        if session.paused_seconds + session.break_seconds > session.gross_seconds:
            raise ValueError("paused and break seconds exceed gross seconds")
        if session.focused_seconds != max(
            0,
            session.gross_seconds - session.paused_seconds - session.break_seconds,
        ):
            raise ValueError("focused seconds do not match duration facts")

        plan_ids = [item.id for item in plan]
        work_item_ids = [item.work_item_id for item in plan]
        ranks = [item.plan_rank for item in plan]
        if len(set(plan_ids)) != len(plan_ids):
            raise ValueError("plan IDs must be unique")
        if len(set(work_item_ids)) != len(work_item_ids):
            raise ValueError("plan WorkItem IDs must be unique")
        if len(set(ranks)) != len(ranks):
            raise ValueError("plan ranks must be unique")
        if sum(item.current_during_session and item.removed_at is None for item in plan) > 1:
            raise ValueError("at most one active plan item may be current")
        if any(
            item.level2_work_item_id_snapshot != context.level2_work_item_id
            for item in plan
        ):
            raise ValueError("plan context does not match the level-2 WorkItem")

        expected_versions = {context.level2_work_item_id: context.level2_version_snapshot}
        expected_versions.update(
            {item.work_item_id: item.work_item_version_snapshot for item in plan}
        )
        if any(not key.strip() for key in self.expected_work_item_versions):
            raise ValueError("expected WorkItem version keys must be nonblank")
        if self.expected_work_item_versions != expected_versions:
            raise ValueError("expected WorkItem versions do not match the snapshot")
        return self


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

    @model_validator(mode="after")
    def validate_version_map(self) -> Self:
        if any(not item_id.strip() for item_id in self.level3_work_item_ids):
            raise ValueError("level-3 WorkItem IDs must be nonblank")
        if len(set(self.level3_work_item_ids)) != len(self.level3_work_item_ids):
            raise ValueError("level-3 WorkItem IDs must be unique")
        expected_ids = {self.level2_work_item_id, *self.level3_work_item_ids}
        if set(self.expected_work_item_versions) != expected_ids:
            raise ValueError("expected WorkItem versions must exactly match the request")
        return self


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

    @model_validator(mode="after")
    def validate_persona(self) -> Self:
        if self.execution_persona is None and (
            self.persona_switched is not None or self.persona_note is not None
        ):
            raise ValueError("persona metadata requires an execution persona")
        if self.persona_note is not None and not self.persona_note.strip():
            raise ValueError("persona note must be nonblank")
        return self


class SubmitFocusSessionReviewPayload(WireModel):
    expected_version: int = Field(ge=0)
    validity: Literal["valid", "invalid"]
    review_state: Literal["completed", "skipped"]
    reviewed_at: CanonicalUtc
    outcomes: list[ReviewOutcomePayload]

    @model_validator(mode="after")
    def validate_outcomes(self) -> Self:
        outcome_ids = [outcome.work_item_id for outcome in self.outcomes]
        if len(set(outcome_ids)) != len(outcome_ids):
            raise ValueError("review Outcome WorkItem IDs must be unique")
        if self.review_state == "skipped" and self.outcomes:
            raise ValueError("a skipped review cannot contain outcomes")
        return self


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


# --------------------------------------------------------------------------- #
# Operation-specific response schemas
# --------------------------------------------------------------------------- #


class FocusSessionResponse(WireResponseModel):
    """Authoritative FocusSession wire post-image."""

    id: str = Field(min_length=1, max_length=64)
    space_id: str = Field(min_length=1, max_length=64)
    created_at: CanonicalUtc
    updated_at: CanonicalUtc
    version: int = Field(ge=0)
    session_revision: int = Field(ge=0)
    started_at: CanonicalUtc
    ended_at: CanonicalUtc | None
    pause_started_at: CanonicalUtc | None
    planned_seconds: int = Field(gt=0)
    gross_seconds: int = Field(ge=0)
    paused_seconds: int = Field(ge=0)
    break_seconds: int = Field(ge=0)
    focused_seconds: int = Field(ge=0)
    timer_completion: Literal["completed", "ended_early", "interrupted"] | None
    validity: Literal["pending", "valid", "invalid"]
    validity_reason: str | None
    overall_progress: Literal["smooth", "progressed", "stuck", "interrupted"] | None
    mood: Literal["great", "good", "normal", "bad"] | None
    session_note: str = Field(max_length=20_000)
    review_state: Literal["not_required", "pending", "completed", "skipped"]
    ownership_state: Literal["authoritative", "local_provisional", "activation_conflict"]


class SessionTaskContextResponse(WireResponseModel):
    id: str = Field(min_length=1, max_length=64)
    space_id: str = Field(min_length=1, max_length=64)
    created_at: CanonicalUtc
    updated_at: CanonicalUtc
    version: int = Field(ge=0)
    session_id: str = Field(min_length=1, max_length=64)
    project_id: str = Field(min_length=1, max_length=64)
    level2_work_item_id: str = Field(min_length=1, max_length=64)
    project_title_snapshot: str = Field(min_length=1, max_length=500)
    level2_title_snapshot: str = Field(min_length=1, max_length=500)
    level2_parent_id_snapshot: str | None
    level2_status_definition_id_snapshot: str = Field(min_length=1, max_length=64)
    level2_version_snapshot: int = Field(ge=0)
    level2_effort_lower_seconds_snapshot: int | None = Field(default=None, ge=0)
    level2_effort_upper_seconds_snapshot: int | None = Field(default=None, ge=0)
    linked_at: CanonicalUtc
    link_method: Literal["explicit", "contextual_confirmed"]


class SessionAttributionRevisionResponse(WireResponseModel):
    id: str = Field(min_length=1, max_length=64)
    space_id: str = Field(min_length=1, max_length=64)
    created_at: CanonicalUtc
    updated_at: CanonicalUtc
    version: int = Field(ge=0)
    session_id: str = Field(min_length=1, max_length=64)
    revision: int = Field(gt=0)
    project_id: str = Field(min_length=1, max_length=64)
    level2_work_item_id: str = Field(min_length=1, max_length=64)
    reason: str | None
    corrected_from_revision: int | None = Field(default=None, gt=0)
    effective: bool


class SessionWorkItemPlanResponse(WireResponseModel):
    id: str = Field(min_length=1, max_length=64)
    space_id: str = Field(min_length=1, max_length=64)
    created_at: CanonicalUtc
    updated_at: CanonicalUtc
    version: int = Field(ge=0)
    session_id: str = Field(min_length=1, max_length=64)
    work_item_id: str = Field(min_length=1, max_length=64)
    title_snapshot: str = Field(min_length=1, max_length=500)
    level2_work_item_id_snapshot: str = Field(min_length=1, max_length=64)
    work_item_version_snapshot: int = Field(ge=0)
    plan_rank: int = Field(ge=0)
    source: Literal["before_start", "during_session", "review_materialized"]
    added_at: CanonicalUtc
    removed_at: CanonicalUtc | None
    removal_reason: str | None
    current_during_session: bool
    completion_draft: bool


class SessionWorkItemOutcomeResponse(WireResponseModel):
    id: str = Field(min_length=1, max_length=64)
    space_id: str = Field(min_length=1, max_length=64)
    created_at: CanonicalUtc
    updated_at: CanonicalUtc
    version: int = Field(ge=0)
    session_id: str = Field(min_length=1, max_length=64)
    session_revision: int = Field(ge=0)
    revision: int = Field(gt=0)
    corrected_from_revision: int | None = Field(default=None, gt=0)
    effective: bool
    work_item_id: str = Field(min_length=1, max_length=64)
    touched: bool
    result: Literal["completed", "progressed", "stuck", "untouched", "cancelled"]
    execution_persona: Literal["ox", "pig", "hajimi", "wukong"] | None
    persona_switched: bool | None
    persona_note: str | None = Field(default=None, max_length=2_000)
    state_command: Literal["complete", "cancel", "none"]
    command_id: str | None
    reviewed_at: CanonicalUtc | None


class SessionCommandEnvelopeResponse(WireResponseModel):
    command_id: str = Field(min_length=1, max_length=128)
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    session_revision: int = Field(ge=0)
    work_item_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    target_transition: Literal["complete", "cancel"]
    replay_safe: bool
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: CanonicalUtc


class SessionCommandReceiptResponse(WireResponseModel):
    command_id: str = Field(min_length=1, max_length=128)
    state: Literal["not_needed", "pending", "succeeded", "failed", "conflict", "unknown", "abandoned"]
    error_code: str | None
    retryable: bool
    details: dict[str, Any] | None
    result: Any | None
    updated_at: CanonicalUtc


class FocusSessionAggregateResponse(WireResponseModel):
    session: FocusSessionResponse
    context: SessionTaskContextResponse | None
    attribution: SessionAttributionRevisionResponse
    plan: list[SessionWorkItemPlanResponse]
    outcomes: list[SessionWorkItemOutcomeResponse]
    command_envelopes: list[SessionCommandEnvelopeResponse]
    command_receipts: list[SessionCommandReceiptResponse]


class ActiveSessionLocatorResponse(WireResponseModel):
    space_id: str
    session_id: str
    operation_id: str
    state: Literal["claiming", "active", "releasing"]
    owner_device_id: str
    owner_tab_id: str
    ownership_epoch: int = Field(gt=0)
    lease_expires_at: CanonicalUtc
    updated_at: CanonicalUtc


class ActiveSessionResponse(ActiveSessionLocatorResponse):
    kind: Literal["authoritative", "resumed"] | None = None
    session: FocusSessionAggregateResponse


class ActivationCandidateResponse(WireResponseModel):
    space_id: str
    session_id: str
    session: FocusSessionAggregateResponse


class ActivationConflictResponse(WireResponseModel):
    kind: Literal["activation_conflict"]
    active: ActiveSessionResponse
    candidate: ActivationCandidateResponse


class EndActiveSessionResponse(WireResponseModel):
    session: FocusSessionAggregateResponse
    locator: None


ActiveSessionOperationResponse = ActiveSessionResponse | ActivationConflictResponse
