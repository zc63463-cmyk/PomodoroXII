"""Thin contract router for FocusSession history, review, and reconciliation.

Only three Space-authorized routes are exposed:
- GET  /{session_id}                    -> module.get
- POST /{session_id}/review             -> module.submit_review
- POST /{session_id}/commands/reconcile -> module.reconcile_commands

No start, pause, resume, or end routes exist on this router; those
lifecycle mutations belong to the ActiveSession router.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header

from app.deps import get_space_runtime_handle
from app.focus_session.contracts import FocusSessionCommand
from app.routes.v1.contract_dependencies import (
    get_focus_session_module,
    require_idempotency_key,
    require_path_identity,
    require_space_identity,
)
from app.schemas.focus_session import (
    FocusSessionAggregateResponse,
    ReconcileFocusSessionCommandsRequest,
    ReviewOutcomePayload,
    SubmitFocusSessionReviewRequest,
)

router = APIRouter()


def _map_review_outcome(outcome: ReviewOutcomePayload) -> dict[str, object]:
    return {
        "work_item_id": outcome.work_item_id,
        "touched": outcome.touched,
        "result": outcome.result,
        "execution_persona": outcome.execution_persona,
        "persona_switched": outcome.persona_switched,
        "persona_note": outcome.persona_note,
        "state_command": outcome.state_command,
        "expected_work_item_version": outcome.expected_work_item_version,
    }


def _map_review_payload(body: SubmitFocusSessionReviewRequest) -> dict[str, object]:
    payload = body.payload
    return {
        "expected_version": payload.expected_version,
        "validity": payload.validity,
        "review_state": payload.review_state,
        "reviewed_at": payload.reviewed_at,
        "outcomes": [_map_review_outcome(outcome) for outcome in payload.outcomes],
    }


def _map_reconcile_payload(
    body: ReconcileFocusSessionCommandsRequest,
) -> dict[str, object]:
    payload = body.payload
    return {
        "command_ids": list(payload.command_ids),
        "replay_safe": payload.replay_safe,
        "abandon_command_ids": list(payload.abandon_command_ids),
        "decision_at": payload.decision_at,
    }


def _make_focus_command(
    body: SubmitFocusSessionReviewRequest | ReconcileFocusSessionCommandsRequest,
    payload: dict[str, object],
) -> FocusSessionCommand:
    return FocusSessionCommand(
        command_id=body.command_id,
        space_id=body.space_id,
        session_id=body.session_id,
        ownership_epoch=body.ownership_epoch,
        payload_hash=body.payload_hash,
        payload=payload,
    )


# --------------------------------------------------------------------------- #
# History route
# --------------------------------------------------------------------------- #


@router.get("/{session_id}", response_model=FocusSessionAggregateResponse)
async def get_focus_session(
    session_id: str,
    module=Depends(get_focus_session_module),
    scope=Depends(get_space_runtime_handle),
) -> FocusSessionAggregateResponse:
    """Get a FocusSession by ID."""
    view = await module.get(scope, session_id)
    return FocusSessionAggregateResponse.model_validate(dict(view.value))


# --------------------------------------------------------------------------- #
# Review route
# --------------------------------------------------------------------------- #


@router.post("/{session_id}/review", response_model=FocusSessionAggregateResponse)
async def submit_review(
    session_id: str,
    body: SubmitFocusSessionReviewRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    module=Depends(get_focus_session_module),
    scope=Depends(get_space_runtime_handle),
) -> FocusSessionAggregateResponse:
    """Submit a FocusSession review."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    require_path_identity(session_id, body.session_id, "FocusSession")
    command = _make_focus_command(body, _map_review_payload(body))
    view = await module.submit_review(scope, command)
    return FocusSessionAggregateResponse.model_validate(dict(view.value))


# --------------------------------------------------------------------------- #
# Reconciliation route
# --------------------------------------------------------------------------- #


@router.post(
    "/{session_id}/commands/reconcile",
    response_model=FocusSessionAggregateResponse,
)
async def reconcile_commands(
    session_id: str,
    body: ReconcileFocusSessionCommandsRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    module=Depends(get_focus_session_module),
    scope=Depends(get_space_runtime_handle),
) -> FocusSessionAggregateResponse:
    """Reconcile pending FocusSession commands."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    require_path_identity(session_id, body.session_id, "FocusSession")
    command = _make_focus_command(body, _map_reconcile_payload(body))
    view = await module.reconcile_commands(scope, command)
    return FocusSessionAggregateResponse.model_validate(dict(view.value))
