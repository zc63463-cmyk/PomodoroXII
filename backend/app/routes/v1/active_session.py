"""Thin contract router for the global ActiveSession.

Every route depends on the master principal only and delegates to
the ActiveSessionCoordinator.  Start and provisional activation
pass their validated ``space_id`` to the Coordinator; every later
action resolves ``space_id`` from Meta or persisted conflict state.

Mounted in the production v1 app under ``/api/v1/active-session``
(``app.routes.v1.build_v1_router``); every route requires the master
principal and an optional Idempotency-Key bound to ``command_id``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import TypeAdapter

from app.auth.authority import Principal
from app.deps import require_master_token
from app.focus_session.contracts import ActiveSessionCommand
from app.focus_session.coordinator import ActiveSessionCoordinationError
from app.routes.v1.contract_dependencies import (
    get_active_session_coordinator,
    require_idempotency_key,
)
from app.schemas.focus_session import (
    ActivateProvisionalPayload,
    ActivateProvisionalRequest,
    ActiveSessionLocatorResponse,
    ActiveSessionOperationResponse,
    ActiveSessionResponse,
    AddPlanItemPayload,
    AddPlanItemRequest,
    EndActiveSessionPayload,
    EndActiveSessionRequest,
    EndActiveSessionResponse,
    HeartbeatPayload,
    HeartbeatRequest,
    OwnedClockPayload,
    PauseActiveSessionRequest,
    ProvisionalPlanItemSnapshot,
    ProvisionalSessionSnapshot,
    ProvisionalTaskContextSnapshot,
    RemovePlanItemRequest,
    ResolveActivationConflictPayload,
    ResolveActivationConflictRequest,
    ResumeActiveSessionRequest,
    SetCompletionDraftPayload,
    SetCompletionDraftRequest,
    SetCurrentPlanItemPayload,
    SetCurrentPlanItemRequest,
    StartActiveSessionPayload,
    StartActiveSessionRequest,
    TakeoverPayload,
    TakeoverRequest,
    UpdateActiveSessionNotePayload,
    UpdateActiveSessionNoteRequest,
)

router = APIRouter()
_ACTIVE_OPERATION_RESPONSE = TypeAdapter(ActiveSessionOperationResponse)


def _flatten_session_response(value: dict[str, Any]) -> dict[str, Any]:
    """Flatten the coordinator view contract into the wire model: locator
    fields are spread at the top level next to the real ``session`` aggregate;
    the ``operation`` detail is intentionally dropped (not part of
    ``ActiveSessionResponse``)."""
    locator = dict(value["locator"])
    session = value["session"]
    kind = value.get("kind")
    result = {**locator, "session": session}
    if kind is not None:
        result["kind"] = kind
    return result


def _map_active_operation_response(value: Any) -> ActiveSessionOperationResponse:
    if isinstance(value, Mapping) and value.get("kind") == "activation_conflict":
        # The coordinator's conflict view spreads the locator fields at the
        # top level of ``active`` (no nested ``locator`` key).
        active = dict(value["active"])
        active.pop("operation", None)
        conflict = {
            "kind": "activation_conflict",
            "active": active,
            "candidate": dict(value["candidate"]),
        }
        return _ACTIVE_OPERATION_RESPONSE.validate_python(conflict)
    return _ACTIVE_OPERATION_RESPONSE.validate_python(
        _flatten_session_response(dict(value))
    )


def _master_principal(value: Principal | dict[str, Any]) -> Principal:
    if isinstance(value, Principal):
        return value
    return Principal(
        subject=str(value["sub"]),
        token_type="master",
        epoch=int(value["epoch"]),
        expires_at=value.get("exp") if isinstance(value.get("exp"), int) else None,
    )


def _make_command(
    body: Any,
    *,
    space_id: str | None,
    payload: dict[str, object],
) -> ActiveSessionCommand:
    return ActiveSessionCommand(
        command_id=body.command_id,
        space_id=space_id,
        session_id=body.session_id,
        ownership_epoch=body.ownership_epoch,
        payload_hash=body.payload_hash,
        payload=payload,
    )


def _map_start_payload(payload: StartActiveSessionPayload) -> dict[str, object]:
    return {
        "level2_work_item_id": payload.level2_work_item_id,
        "level3_work_item_ids": list(payload.level3_work_item_ids),
        "planned_seconds": payload.planned_seconds,
        "started_at": payload.started_at,
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "expected_work_item_versions": dict(payload.expected_work_item_versions),
    }


def _map_session_snapshot(payload: ProvisionalSessionSnapshot) -> dict[str, object]:
    return {
        "session_revision": payload.session_revision,
        "started_at": payload.started_at,
        "pause_started_at": payload.pause_started_at,
        "planned_seconds": payload.planned_seconds,
        "gross_seconds": payload.gross_seconds,
        "paused_seconds": payload.paused_seconds,
        "break_seconds": payload.break_seconds,
        "focused_seconds": payload.focused_seconds,
        "validity": payload.validity,
        "validity_reason": payload.validity_reason,
        "review_state": payload.review_state,
        "ownership_state": payload.ownership_state,
        "session_note": payload.session_note,
    }


def _map_context_snapshot(payload: ProvisionalTaskContextSnapshot) -> dict[str, object]:
    return {
        "project_id": payload.project_id,
        "project_title_snapshot": payload.project_title_snapshot,
        "level2_work_item_id": payload.level2_work_item_id,
        "level2_title_snapshot": payload.level2_title_snapshot,
        "level2_parent_id_snapshot": payload.level2_parent_id_snapshot,
        "level2_status_definition_id_snapshot": payload.level2_status_definition_id_snapshot,
        "level2_version_snapshot": payload.level2_version_snapshot,
        "level2_effort_lower_seconds_snapshot": payload.level2_effort_lower_seconds_snapshot,
        "level2_effort_upper_seconds_snapshot": payload.level2_effort_upper_seconds_snapshot,
        "linked_at": payload.linked_at,
        "link_method": payload.link_method,
    }


def _map_plan_snapshot(payload: ProvisionalPlanItemSnapshot) -> dict[str, object]:
    return {
        "id": payload.id,
        "work_item_id": payload.work_item_id,
        "title_snapshot": payload.title_snapshot,
        "level2_work_item_id_snapshot": payload.level2_work_item_id_snapshot,
        "work_item_version_snapshot": payload.work_item_version_snapshot,
        "plan_rank": payload.plan_rank,
        "source": payload.source,
        "added_at": payload.added_at,
        "removed_at": payload.removed_at,
        "removal_reason": payload.removal_reason,
        "current_during_session": payload.current_during_session,
        "completion_draft": payload.completion_draft,
    }


def _map_activate_payload(payload: ActivateProvisionalPayload) -> dict[str, object]:
    return {
        "cached_at": payload.cached_at,
        "cached_ownership_epoch": payload.cached_ownership_epoch,
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "pair": {
            "active": {
                "space_id": payload.pair.active.space_id,
                "session_id": payload.pair.active.session_id,
            },
            "candidate": {
                "space_id": payload.pair.candidate.space_id,
                "session_id": payload.pair.candidate.session_id,
            },
        },
        "snapshot": {
            "session": _map_session_snapshot(payload.snapshot.session),
            "context": _map_context_snapshot(payload.snapshot.context),
            "plan": [_map_plan_snapshot(item) for item in payload.snapshot.plan],
        },
        "expected_work_item_versions": dict(payload.expected_work_item_versions),
    }


def _validate_activate_anchor(
    body: ActivateProvisionalRequest,
    payload: ActivateProvisionalPayload,
) -> None:
    """The active side of the conflict pair must anchor to the request's own
    Space/Session identity; the caller cannot fabricate an arbitrary anchor."""
    if (
        payload.pair.active.space_id != body.space_id
        or payload.pair.active.session_id != body.session_id
    ):
        raise HTTPException(
            status_code=422,
            detail="conflict pair active anchor must match the request Space/Session",
        )


def _map_heartbeat_payload(payload: HeartbeatPayload) -> dict[str, object]:
    return {
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "heartbeat_at": payload.heartbeat_at,
    }


def _map_owned_clock_payload(payload: OwnedClockPayload) -> dict[str, object]:
    return {
        "expected_version": payload.expected_version,
        "occurred_at": payload.occurred_at,
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
    }


def _map_end_payload(payload: EndActiveSessionPayload) -> dict[str, object]:
    return {
        **_map_owned_clock_payload(payload),
        "timer_completion": payload.timer_completion,
        "validity": payload.validity,
        "validity_reason": payload.validity_reason,
    }


def _map_takeover_payload(payload: TakeoverPayload) -> dict[str, object]:
    return {
        "new_owner_device_id": payload.new_owner_device_id,
        "new_owner_tab_id": payload.new_owner_tab_id,
    }


def _map_note_payload(payload: UpdateActiveSessionNotePayload) -> dict[str, object]:
    return {
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "expected_version": payload.expected_version,
        "session_note": payload.session_note,
    }


def _map_current_plan_payload(payload: SetCurrentPlanItemPayload) -> dict[str, object]:
    return {
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "work_item_id": payload.work_item_id,
        "expected_plan_versions": dict(payload.expected_plan_versions),
    }


def _map_completion_payload(payload: SetCompletionDraftPayload) -> dict[str, object]:
    return {
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "plan_item_id": payload.plan_item_id,
        "expected_plan_version": payload.expected_plan_version,
        "completion_draft": payload.completion_draft,
    }


def _map_add_plan_payload(payload: AddPlanItemPayload) -> dict[str, object]:
    return {
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "work_item_id": payload.work_item_id,
        "expected_work_item_version": payload.expected_work_item_version,
        "plan_rank": payload.plan_rank,
        "added_at": payload.added_at,
    }


def _map_remove_plan_payload(payload: Any) -> dict[str, object]:
    return {
        "owner_device_id": payload.owner_device_id,
        "owner_tab_id": payload.owner_tab_id,
        "plan_item_id": payload.plan_item_id,
        "expected_plan_version": payload.expected_plan_version,
        "removed_at": payload.removed_at,
        "removal_reason": payload.removal_reason,
    }


def _map_resolution_payload(payload: ResolveActivationConflictPayload) -> dict[str, object]:
    return {
        "winner_role": payload.winner_role,
        "decision_at": payload.decision_at,
        "validity_correction": {
            "loser_validity": payload.validity_correction.loser_validity,
            "loser_validity_reason": payload.validity_correction.loser_validity_reason,
        },
    }


# --------------------------------------------------------------------------- #
# Locate
# --------------------------------------------------------------------------- #


@router.get("", response_model=ActiveSessionOperationResponse, response_model_exclude_none=True)
async def locate(
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionOperationResponse:
    """Locate the current active session for the master principal."""
    view = await coordinator.locate(_master_principal(claims))
    if view is None:
        raise HTTPException(status_code=404, detail="active_session_not_found")
    return _map_active_operation_response(view.value)


# --------------------------------------------------------------------------- #
# Start / activate-provisional — carry root space_id
# --------------------------------------------------------------------------- #


@router.post(
    "/start",
    status_code=201,
    response_model=ActiveSessionResponse,
    response_model_exclude_none=True,
)
async def start(
    body: StartActiveSessionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Start a new active session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=body.space_id, payload=_map_start_payload(body.payload)
    )
    view = await coordinator.start(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post(
    "/activate-provisional",
    response_model=ActiveSessionOperationResponse,
    response_model_exclude_none=True,
)
async def activate_provisional(
    body: ActivateProvisionalRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionOperationResponse:
    """Activate a provisional session as the global active session."""
    require_idempotency_key(body.command_id, idempotency_key)
    _validate_activate_anchor(body, body.payload)
    command = _make_command(
        body, space_id=body.space_id, payload=_map_activate_payload(body.payload)
    )
    view = await coordinator.activate_provisional(_master_principal(claims), command)
    return _map_active_operation_response(view.value)


# --------------------------------------------------------------------------- #
# Locator-bound lifecycle — space_id resolved by Coordinator
# --------------------------------------------------------------------------- #


@router.post("/heartbeat", response_model=ActiveSessionLocatorResponse)
async def heartbeat(
    body: HeartbeatRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionLocatorResponse:
    """Send a heartbeat for the active session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_heartbeat_payload(body.payload)
    )
    view = await coordinator.heartbeat(_master_principal(claims), command)
    return ActiveSessionLocatorResponse.model_validate(dict(view.value))


@router.post("/pause", response_model=ActiveSessionResponse, response_model_exclude_none=True)
async def pause(
    body: PauseActiveSessionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Pause the active session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_owned_clock_payload(body.payload)
    )
    view = await coordinator.pause(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post("/resume", response_model=ActiveSessionResponse, response_model_exclude_none=True)
async def resume(
    body: ResumeActiveSessionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Resume the paused active session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_owned_clock_payload(body.payload)
    )
    view = await coordinator.resume(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post("/takeover", response_model=ActiveSessionResponse, response_model_exclude_none=True)
async def takeover(
    body: TakeoverRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Take over the active session from another device/tab."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(body, space_id=None, payload=_map_takeover_payload(body.payload))
    view = await coordinator.takeover(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post("/end", response_model=EndActiveSessionResponse)
async def end(
    body: EndActiveSessionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> EndActiveSessionResponse:
    """End the active session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(body, space_id=None, payload=_map_end_payload(body.payload))
    view = await coordinator.end(_master_principal(claims), command)
    flattened = _flatten_session_response(view.value)
    return EndActiveSessionResponse.model_validate(
        {"session": flattened["session"], "locator": None}
    )


# --------------------------------------------------------------------------- #
# Note update
# --------------------------------------------------------------------------- #


@router.put("/note", response_model=ActiveSessionResponse, response_model_exclude_none=True)
async def update_note(
    body: UpdateActiveSessionNoteRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Update the session note."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(body, space_id=None, payload=_map_note_payload(body.payload))
    view = await coordinator.update_note(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


# --------------------------------------------------------------------------- #
# Plan mutations
# --------------------------------------------------------------------------- #


@router.post(
    "/plan/current",
    response_model=ActiveSessionResponse,
    response_model_exclude_none=True,
)
async def set_current_plan_item(
    body: SetCurrentPlanItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Set the current plan item."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_current_plan_payload(body.payload)
    )
    view = await coordinator.set_current_plan_item(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post(
    "/plan/completion-draft",
    response_model=ActiveSessionResponse,
    response_model_exclude_none=True,
)
async def set_completion_draft(
    body: SetCompletionDraftRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Set the completion draft for a plan item."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_completion_payload(body.payload)
    )
    view = await coordinator.set_completion_draft(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post("/plan/add", response_model=ActiveSessionResponse, response_model_exclude_none=True)
async def add_plan_item(
    body: AddPlanItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Add a plan item to the session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(body, space_id=None, payload=_map_add_plan_payload(body.payload))
    view = await coordinator.add_plan_item(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


@router.post(
    "/plan/remove",
    response_model=ActiveSessionResponse,
    response_model_exclude_none=True,
)
async def remove_plan_item(
    body: RemovePlanItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Remove a plan item from the session."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_remove_plan_payload(body.payload)
    )
    view = await coordinator.remove_plan_item(_master_principal(claims), command)
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))


# --------------------------------------------------------------------------- #
# Conflict resolution
# --------------------------------------------------------------------------- #


@router.post(
    "/resolve-activation-conflict",
    response_model=ActiveSessionResponse,
    response_model_exclude_none=True,
)
async def resolve_activation_conflict(
    body: ResolveActivationConflictRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    coordinator=Depends(get_active_session_coordinator),
    claims=Depends(require_master_token),
) -> ActiveSessionResponse:
    """Resolve an activation conflict between two sessions."""
    require_idempotency_key(body.command_id, idempotency_key)
    command = _make_command(
        body, space_id=None, payload=_map_resolution_payload(body.payload)
    )
    try:
        view = await coordinator.resolve_activation_conflict(
            _master_principal(claims), command
        )
    except ActiveSessionCoordinationError as exc:
        # A lost CAS / idempotency conflict is a stable client-visible 409,
        # never a bare 500.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return ActiveSessionResponse.model_validate(_flatten_session_response(view.value))
