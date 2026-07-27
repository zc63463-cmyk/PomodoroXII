"""Thin contract router for the global ActiveSession.

Every route depends on the master principal only and delegates to
the ActiveSessionCoordinator.  Start and provisional activation
pass their validated ``space_id`` to the Coordinator; every later
action resolves ``space_id`` from Meta or persisted conflict state.

The router is intentionally not mounted in the production v1 app
during TS0; TS1/TS2 mount it after replacing the provider
dependencies.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.focus_session.contracts import ActiveSessionCommand
from app.routes.v1.contract_dependencies import (
    get_active_session_coordinator,
    get_contract_master_principal,
)
from app.schemas.focus_session import (
    ActivateProvisionalRequest,
    AddPlanItemRequest,
    EndActiveSessionRequest,
    HeartbeatRequest,
    PauseActiveSessionRequest,
    RemovePlanItemRequest,
    ResolveActivationConflictRequest,
    SetCompletionDraftRequest,
    SetCurrentPlanItemRequest,
    StartActiveSessionRequest,
    TakeoverRequest,
    UpdateActiveSessionNoteRequest,
)

router = APIRouter()


def _make_command(
    body: Any,
    *,
    space_id: str | None,
) -> ActiveSessionCommand:
    """Map a validated wire request to a frozen ActiveSessionCommand."""
    return ActiveSessionCommand(
        command_id=body.command_id,
        space_id=space_id,
        session_id=body.session_id,
        ownership_epoch=body.ownership_epoch,
        payload_hash=body.payload_hash,
        payload=body.payload.model_dump(mode="json"),
    )


# --------------------------------------------------------------------------- #
# Locate
# --------------------------------------------------------------------------- #


@router.get("")
async def locate(
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Locate the current active session for the master principal."""
    view = await coordinator.locate(principal)
    if view is None:
        raise HTTPException(status_code=404, detail="active_session_not_found")
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Start / activate-provisional — carry root space_id
# --------------------------------------------------------------------------- #


@router.post("/start", status_code=201)
async def start(
    body: StartActiveSessionRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Start a new active session."""
    command = _make_command(body, space_id=body.space_id)
    view = await coordinator.start(principal, command)
    return {"value": dict(view.value)}


@router.post("/activate-provisional")
async def activate_provisional(
    body: ActivateProvisionalRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Activate a provisional session as the global active session."""
    command = _make_command(body, space_id=body.space_id)
    view = await coordinator.activate_provisional(principal, command)
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Locator-bound lifecycle — space_id resolved by Coordinator
# --------------------------------------------------------------------------- #


@router.post("/heartbeat")
async def heartbeat(
    body: HeartbeatRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Send a heartbeat for the active session."""
    command = _make_command(body, space_id=None)
    view = await coordinator.heartbeat(principal, command)
    return {"value": dict(view.value)}


@router.post("/pause")
async def pause(
    body: PauseActiveSessionRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Pause the active session."""
    command = _make_command(body, space_id=None)
    view = await coordinator.pause(principal, command)
    return {"value": dict(view.value)}


@router.post("/resume")
async def resume(
    body: PauseActiveSessionRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Resume the paused active session."""
    command = _make_command(body, space_id=None)
    view = await coordinator.resume(principal, command)
    return {"value": dict(view.value)}


@router.post("/takeover")
async def takeover(
    body: TakeoverRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Take over the active session from another device/tab."""
    command = _make_command(body, space_id=None)
    view = await coordinator.takeover(principal, command)
    return {"value": dict(view.value)}


@router.post("/end")
async def end(
    body: EndActiveSessionRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """End the active session."""
    command = _make_command(body, space_id=None)
    view = await coordinator.end(principal, command)
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Note update
# --------------------------------------------------------------------------- #


@router.put("/note")
async def update_note(
    body: UpdateActiveSessionNoteRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Update the session note."""
    command = _make_command(body, space_id=None)
    view = await coordinator.update_note(principal, command)
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Plan mutations
# --------------------------------------------------------------------------- #


@router.post("/plan/current")
async def set_current_plan_item(
    body: SetCurrentPlanItemRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Set the current plan item."""
    command = _make_command(body, space_id=None)
    view = await coordinator.set_current_plan_item(principal, command)
    return {"value": dict(view.value)}


@router.post("/plan/completion-draft")
async def set_completion_draft(
    body: SetCompletionDraftRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Set the completion draft for a plan item."""
    command = _make_command(body, space_id=None)
    view = await coordinator.set_completion_draft(principal, command)
    return {"value": dict(view.value)}


@router.post("/plan/add")
async def add_plan_item(
    body: AddPlanItemRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Add a plan item to the session."""
    command = _make_command(body, space_id=None)
    view = await coordinator.add_plan_item(principal, command)
    return {"value": dict(view.value)}


@router.post("/plan/remove")
async def remove_plan_item(
    body: RemovePlanItemRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Remove a plan item from the session."""
    command = _make_command(body, space_id=None)
    view = await coordinator.remove_plan_item(principal, command)
    return {"value": dict(view.value)}


# --------------------------------------------------------------------------- #
# Conflict resolution
# --------------------------------------------------------------------------- #


@router.post("/resolve-activation-conflict")
async def resolve_activation_conflict(
    body: ResolveActivationConflictRequest,
    coordinator=Depends(get_active_session_coordinator),
    principal=Depends(get_contract_master_principal),
) -> dict[str, Any]:
    """Resolve an activation conflict between two sessions."""
    command = _make_command(body, space_id=None)
    view = await coordinator.resolve_activation_conflict(principal, command)
    return {"value": dict(view.value)}
