"""Thin contract router for FocusSession history, review, and reconciliation.

Only three Space-authorized routes are exposed:
- GET  /{session_id}                    -> module.get
- POST /{session_id}/review             -> module.submit_review
- POST /{session_id}/commands/reconcile -> module.reconcile_commands

No start, pause, resume, or end routes exist on this router; those
lifecycle mutations belong to the ActiveSession router.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.focus_session.contracts import FocusSessionCommand
from app.routes.v1.contract_dependencies import (
    get_contract_space_runtime,
    get_focus_session_module,
)
from app.schemas.focus_session import (
    ReconcileFocusSessionCommandsRequest,
    SubmitFocusSessionReviewRequest,
)

router = APIRouter()


def _make_focus_command(body: Any) -> FocusSessionCommand:
    """Map a validated wire request to a frozen FocusSessionCommand."""
    return FocusSessionCommand(
        command_id=body.command_id,
        space_id=body.space_id,
        session_id=body.session_id,
        ownership_epoch=body.ownership_epoch,
        payload_hash=body.payload_hash,
        payload=body.payload.model_dump(mode="json"),
    )


# --------------------------------------------------------------------------- #
# History route
# --------------------------------------------------------------------------- #


@router.get("/{session_id}")
async def get_focus_session(
    session_id: str,
    module=Depends(get_focus_session_module),
    scope=Depends(get_contract_space_runtime),
) -> dict[str, Any]:
    """Get a FocusSession by ID."""
    view = await module.get(scope, session_id)
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Review route
# --------------------------------------------------------------------------- #


@router.post("/{session_id}/review")
async def submit_review(
    session_id: str,
    body: SubmitFocusSessionReviewRequest,
    module=Depends(get_focus_session_module),
    scope=Depends(get_contract_space_runtime),
) -> dict[str, Any]:
    """Submit a FocusSession review."""
    command = _make_focus_command(body)
    view = await module.submit_review(scope, command)
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Reconciliation route
# --------------------------------------------------------------------------- #


@router.post("/{session_id}/commands/reconcile")
async def reconcile_commands(
    session_id: str,
    body: ReconcileFocusSessionCommandsRequest,
    module=Depends(get_focus_session_module),
    scope=Depends(get_contract_space_runtime),
) -> dict[str, Any]:
    """Reconcile pending FocusSession commands."""
    command = _make_focus_command(body)
    view = await module.reconcile_commands(scope, command)
    return {"value": dict(view.value)}
