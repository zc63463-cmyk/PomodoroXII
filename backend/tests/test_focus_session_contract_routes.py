"""FocusSession and ActiveSession contract route tests.

Verifies that thin contract routers:
1. Parse camelCase wire schemas correctly.
2. Delegate exactly one call to the injected provider.
3. Map responses back to camelCase.
4. Are NOT mounted in the production v1 router.
5. Fail closed when providers are not installed.
"""
from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth.authority import Principal
from app.deps import get_space_runtime_handle, require_master_token
from app.errors import register_exception_handlers
from app.focus_session.contracts import (
    ActiveSessionCommand,
    ActiveSessionView,
    FocusSessionCommand,
    FocusSessionView,
)
from app.routes.v1.active_session import router as active_session_router
from app.routes.v1.contract_dependencies import (
    get_active_session_coordinator,
    get_focus_session_module,
)
from app.routes.v1.focus_sessions import _map_review_outcome
from app.routes.v1.focus_sessions import router as focus_sessions_router
from app.schemas.focus_session import (
    ActivateProvisionalRequest,
    HeartbeatRequest,
    ReviewOutcomePayload,
)

# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #


def test_review_outcome_mapping_preserves_optional_persona_field_presence() -> None:
    required = ReviewOutcomePayload.model_validate({
        "workItemId": "l3-a", "touched": True, "result": "completed",
        "stateCommand": "complete", "expectedWorkItemVersion": 2,
    })
    explicit_null = ReviewOutcomePayload.model_validate({
        "workItemId": "l3-a", "touched": True, "result": "completed",
        "executionPersona": None, "personaSwitched": None, "personaNote": None,
        "stateCommand": "complete", "expectedWorkItemVersion": 2,
    })

    omitted = _map_review_outcome(required)
    present = _map_review_outcome(explicit_null)
    assert "execution_persona" not in omitted
    assert "persona_switched" not in omitted
    assert "persona_note" not in omitted
    assert present["execution_persona"] is None
    assert present["persona_switched"] is None
    assert present["persona_note"] is None


def _focus_value(session_id: str) -> dict[str, Any]:
    timestamp = "2026-07-15T08:00:00Z"
    return {
        "session": {
            "id": session_id,
            "spaceId": "space-a",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "version": 1,
            "sessionRevision": 1,
            "startedAt": timestamp,
            "endedAt": None,
            "pauseStartedAt": None,
            "plannedSeconds": 1500,
            "grossSeconds": 0,
            "pausedSeconds": 0,
            "breakSeconds": 0,
            "focusedSeconds": 0,
            "timerCompletion": None,
            "validity": "pending",
            "validityReason": None,
            "overallProgress": None,
            "mood": None,
            "sessionNote": "",
            "reviewState": "not_required",
            "ownershipState": "authoritative",
        },
        "context": None,
        "attribution": {
            "id": f"attr-{session_id}",
            "spaceId": "space-a",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "version": 1,
            "sessionId": session_id,
            "revision": 1,
            "projectId": "project-a",
            "level2WorkItemId": "l2-a",
            "reason": None,
            "correctedFromRevision": None,
            "effective": True,
        },
        "plan": [],
        "outcomes": [],
        "commandEnvelopes": [],
        "commandReceipts": [],
    }


def _locator_value(session_id: str) -> dict[str, Any]:
    return {
        "spaceId": "space-a",
        "sessionId": session_id,
        "operationId": "operation-a",
        "state": "active",
        "ownerDeviceId": "device-a",
        "ownerTabId": "tab-a",
        "ownershipEpoch": 3,
        "leaseExpiresAt": "2026-07-15T09:00:00Z",
        "updatedAt": "2026-07-15T08:00:00Z",
    }


def _active_value(session_id: str) -> dict[str, Any]:
    return {**_locator_value(session_id), "session": _focus_value(session_id)}


class FakeFocusSessionModule:
    """Records every call for assertion."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def get(self, scope: Any, session_id: str) -> FocusSessionView:
        self.calls.append(("get", scope, session_id))
        return FocusSessionView(value=_focus_value(session_id))

    async def start(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("start", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def pause(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("pause", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def resume(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("resume", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def end(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("end", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def update_note(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("update_note", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def set_current_plan_item(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("set_current_plan_item", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def set_completion_draft(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("set_completion_draft", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def add_plan_item(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("add_plan_item", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def remove_plan_item(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("remove_plan_item", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def submit_review(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("submit_review", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))

    async def reconcile_commands(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("reconcile_commands", scope, command))
        return FocusSessionView(value=_focus_value(str(command.session_id)))


class FakeActiveSessionCoordinator:
    """Records every call for assertion."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def locate(self, principal: Any) -> ActiveSessionView | None:
        self.calls.append(("locate", principal))
        return ActiveSessionView(value=_active_value("session-a"))

    async def start(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("start", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def activate_provisional(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("activate_provisional", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def heartbeat(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("heartbeat", principal, command))
        return ActiveSessionView(value=_locator_value(command.session_id))

    async def pause(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("pause", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def resume(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("resume", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def takeover(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("takeover", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def end(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("end", principal, command))
        return ActiveSessionView(
            value={"session": _focus_value(command.session_id), "locator": None}
        )

    async def update_note(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("update_note", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def set_current_plan_item(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("set_current_plan_item", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def set_completion_draft(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("set_completion_draft", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def add_plan_item(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("add_plan_item", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def remove_plan_item(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("remove_plan_item", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))

    async def resolve_activation_conflict(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("resolve_activation_conflict", principal, command))
        return ActiveSessionView(value=_active_value(command.session_id))


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture()
def fake_focus_session_module() -> FakeFocusSessionModule:
    return FakeFocusSessionModule()


@pytest.fixture()
def fake_active_session_coordinator() -> FakeActiveSessionCoordinator:
    return FakeActiveSessionCoordinator()


@pytest.fixture()
def master_principal() -> Principal:
    return Principal(
        subject="admin",
        token_type="master",
        epoch=1,
        expires_at=None,
    )


@pytest.fixture()
def space_runtime_handle() -> object:
    return SimpleNamespace(scope=SimpleNamespace(space_id="space-a"))


@pytest.fixture()
def contract_app(
    fake_focus_session_module: FakeFocusSessionModule,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
    master_principal: Principal,
    space_runtime_handle: object,
) -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(focus_sessions_router, prefix="/api/v1/focus-sessions")
    app.include_router(active_session_router, prefix="/api/v1/active-session")
    app.dependency_overrides[get_focus_session_module] = lambda: fake_focus_session_module
    app.dependency_overrides[get_active_session_coordinator] = lambda: fake_active_session_coordinator
    app.dependency_overrides[require_master_token] = lambda: master_principal
    app.dependency_overrides[get_space_runtime_handle] = lambda: space_runtime_handle
    return app


@pytest.fixture()
def master_client(contract_app: FastAPI) -> TestClient:
    return TestClient(contract_app)


@pytest.fixture()
def space_client(contract_app: FastAPI) -> TestClient:
    return TestClient(contract_app)


# --------------------------------------------------------------------------- #
# Helper: valid request body for each active-session route
# --------------------------------------------------------------------------- #


_HEX64 = "a" * 64

_PROVISIONAL_PAYLOAD: dict[str, Any] = {
    "cachedAt": "2026-07-15T08:05:00Z",
    "cachedOwnershipEpoch": None,
    "ownerDeviceId": "device-a",
    "ownerTabId": "tab-a",
    "snapshot": {
        "session": {
            "sessionRevision": 0,
            "startedAt": "2026-07-15T08:00:00Z",
            "pauseStartedAt": None,
            "plannedSeconds": 1500,
            "grossSeconds": 300,
            "pausedSeconds": 0,
            "breakSeconds": 0,
            "focusedSeconds": 300,
            "validity": "pending",
            "validityReason": None,
            "reviewState": "not_required",
            "ownershipState": "local_provisional",
            "sessionNote": "",
        },
        "context": {
            "projectId": "project-a",
            "projectTitleSnapshot": "Project A",
            "level2WorkItemId": "l2-a",
            "level2TitleSnapshot": "Deliver A",
            "level2ParentIdSnapshot": "l1-a",
            "level2StatusDefinitionIdSnapshot": "sys-status-in-progress",
            "level2VersionSnapshot": 4,
            "level2EffortLowerSecondsSnapshot": 1200,
            "level2EffortUpperSecondsSnapshot": 2400,
            "linkedAt": "2026-07-15T08:00:00Z",
            "linkMethod": "explicit",
        },
        "plan": [{
            "id": "plan-a",
            "workItemId": "l3-a",
            "titleSnapshot": "Outcome A",
            "level2WorkItemIdSnapshot": "l2-a",
            "workItemVersionSnapshot": 2,
            "planRank": 0,
            "source": "before_start",
            "addedAt": "2026-07-15T08:00:00Z",
            "removedAt": None,
            "removalReason": None,
            "currentDuringSession": True,
            "completionDraft": False,
        }],
    },
    "expectedWorkItemVersions": {"l2-a": 4, "l3-a": 2},
}

_RESOLUTION_PAYLOAD: dict[str, Any] = {
    "winnerRole": "candidate",
    "decisionAt": "2026-07-15T08:06:00Z",
    "validityCorrection": {
        "loserValidity": "invalid",
        "loserValidityReason": "activation_conflict_loser",
    },
}


def valid_active_request(
    path: str,
    command_id: str,
    session_id: str = "session-a",
    space_id: str | None = None,
    ownership_epoch: int | None = None,
) -> dict[str, Any]:
    """Build the exact strict schema for the selected active-session route."""
    if path == "start":
        return {
            "commandId": command_id,
            "spaceId": space_id or "space-a",
            "sessionId": session_id,
            "ownershipEpoch": None,
            "payloadHash": _HEX64,
            "payload": {
                "level2WorkItemId": "l2-a",
                "level3WorkItemIds": ["l3-a"],
                "plannedSeconds": 1500,
                "startedAt": "2026-07-15T08:00:00Z",
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "expectedWorkItemVersions": {"l2-a": 1, "l3-a": 1},
            },
        }
    if path == "activate-provisional":
        return {
            "commandId": command_id,
            "spaceId": space_id or "space-a",
            "sessionId": session_id,
            "ownershipEpoch": None,
            "payloadHash": _HEX64,
            "payload": deepcopy(_PROVISIONAL_PAYLOAD),
        }
    if path == "heartbeat":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "heartbeatAt": "2026-07-15T08:05:00Z",
            },
        }
    if path in ("pause", "resume"):
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "expectedVersion": 1,
                "occurredAt": "2026-07-15T08:05:00Z",
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
            },
        }
    if path == "end":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "expectedVersion": 1,
                "occurredAt": "2026-07-15T08:25:00Z",
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "timerCompletion": "completed",
                "validity": "valid",
                "validityReason": None,
            },
        }
    if path == "takeover":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "newOwnerDeviceId": "device-b",
                "newOwnerTabId": "tab-b",
            },
        }
    if path == "note":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "expectedVersion": 1,
                "sessionNote": "Updated note",
            },
        }
    if path == "plan/current":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "workItemId": "l3-a",
                "expectedPlanVersions": {"plan-a": 1},
            },
        }
    if path == "plan/completion-draft":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "planItemId": "plan-a",
                "expectedPlanVersion": 1,
                "completionDraft": True,
            },
        }
    if path == "plan/add":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "workItemId": "l3-b",
                "expectedWorkItemVersion": 1,
                "planRank": 1,
                "addedAt": "2026-07-15T08:10:00Z",
            },
        }
    if path == "plan/remove":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": {
                "ownerDeviceId": "device-a",
                "ownerTabId": "tab-a",
                "planItemId": "plan-a",
                "expectedPlanVersion": 1,
                "removedAt": "2026-07-15T08:15:00Z",
                "removalReason": "Done",
            },
        }
    if path == "resolve-activation-conflict":
        return {
            "commandId": command_id,
            "sessionId": session_id,
            "ownershipEpoch": ownership_epoch or 3,
            "payloadHash": _HEX64,
            "payload": _RESOLUTION_PAYLOAD,
        }
    raise ValueError(f"unknown path: {path}")


# --------------------------------------------------------------------------- #
# ActiveSession locate test
# --------------------------------------------------------------------------- #


def test_active_session_locate_delegates_to_coordinator(
    master_client: TestClient,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
    master_principal: Principal,
) -> None:
    """GET /api/v1/active-session calls coordinator.locate with master principal."""
    resp = master_client.get("/api/v1/active-session")
    assert resp.status_code == 200
    assert len(fake_active_session_coordinator.calls) == 1
    method, principal = fake_active_session_coordinator.calls[0]
    assert method == "locate"
    assert principal == master_principal


# --------------------------------------------------------------------------- #
# ActiveSession mutation tests (parametrized)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("path", "http_method", "coordinator_method", "space_id", "ownership_epoch", "status_code"),
    (
        ("start", "POST", "start", "space-a", None, 201),
        ("activate-provisional", "POST", "activate_provisional", "space-a", None, 200),
        ("heartbeat", "POST", "heartbeat", None, 3, 200),
        ("pause", "POST", "pause", None, 3, 200),
        ("resume", "POST", "resume", None, 3, 200),
        ("takeover", "POST", "takeover", None, 3, 200),
        ("end", "POST", "end", None, 3, 200),
        ("note", "PUT", "update_note", None, 3, 200),
        ("plan/current", "POST", "set_current_plan_item", None, 3, 200),
        ("plan/completion-draft", "POST", "set_completion_draft", None, 3, 200),
        ("plan/add", "POST", "add_plan_item", None, 3, 200),
        ("plan/remove", "POST", "remove_plan_item", None, 3, 200),
        ("resolve-activation-conflict", "POST", "resolve_activation_conflict", None, 3, 200),
    ),
)
def test_active_session_mutations_delegate_one_generic_command(
    master_client: TestClient,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
    path: str,
    http_method: str,
    coordinator_method: str,
    space_id: str | None,
    ownership_epoch: int | None,
    status_code: int,
    master_principal: Principal,
) -> None:
    body = valid_active_request(
        path,
        command_id=f"{coordinator_method}-1",
        session_id="session-a",
        space_id=space_id,
        ownership_epoch=ownership_epoch,
    )
    resp = master_client.request(http_method, f"/api/v1/active-session/{path}", json=body)
    assert resp.status_code == status_code
    called_method, principal, command = fake_active_session_coordinator.calls[-1]
    assert called_method == coordinator_method
    assert principal == master_principal
    assert isinstance(command, ActiveSessionCommand)
    assert command.space_id == space_id
    assert command.ownership_epoch == ownership_epoch


# --------------------------------------------------------------------------- #
# FocusSession delegation tests
# --------------------------------------------------------------------------- #


def test_focus_session_get_delegates_to_module(
    space_client: TestClient,
    fake_focus_session_module: FakeFocusSessionModule,
    space_runtime_handle: object,
) -> None:
    resp = space_client.get("/api/v1/focus-sessions/session-a")
    assert resp.status_code == 200
    assert len(fake_focus_session_module.calls) == 1
    method, scope, session_id = fake_focus_session_module.calls[0]
    assert method == "get"
    assert scope is space_runtime_handle
    assert session_id == "session-a"


def test_focus_session_review_delegates_to_module(
    space_client: TestClient,
    fake_focus_session_module: FakeFocusSessionModule,
    space_runtime_handle: object,
) -> None:
    resp = space_client.post(
        "/api/v1/focus-sessions/session-a/review",
        json={
            "commandId": "review-1",
            "spaceId": "space-a",
            "sessionId": "session-a",
            "ownershipEpoch": None,
            "payloadHash": _HEX64,
            "payload": {
                "expectedVersion": 1,
                "validity": "valid",
                "reviewState": "completed",
                "reviewedAt": "2026-07-15T08:30:00Z",
                "outcomes": [
                    {
                        "workItemId": "l3-a",
                        "touched": True,
                        "result": "completed",
                        "executionPersona": None,
                        "personaSwitched": None,
                        "personaNote": None,
                        "stateCommand": "complete",
                        "expectedWorkItemVersion": 2,
                    },
                ],
            },
        },
    )
    assert resp.status_code == 200
    method, scope, command = fake_focus_session_module.calls[0]
    assert method == "submit_review"
    assert scope is space_runtime_handle
    assert isinstance(command, FocusSessionCommand)
    assert command.space_id == "space-a"
    assert command.session_id == "session-a"


def test_focus_session_reconcile_delegates_to_module(
    space_client: TestClient,
    fake_focus_session_module: FakeFocusSessionModule,
    space_runtime_handle: object,
) -> None:
    resp = space_client.post(
        "/api/v1/focus-sessions/session-a/commands/reconcile",
        json={
            "commandId": "reconcile-1",
            "spaceId": "space-a",
            "sessionId": "session-a",
            "ownershipEpoch": None,
            "payloadHash": _HEX64,
            "payload": {
                "commandIds": ["child-1", "child-2"],
                "replaySafe": True,
                "abandonCommandIds": [],
            },
        },
    )
    assert resp.status_code == 200
    method, scope, command = fake_focus_session_module.calls[0]
    assert method == "reconcile_commands"
    assert scope is space_runtime_handle
    assert isinstance(command, FocusSessionCommand)
    assert command.space_id == "space-a"


def test_focus_session_path_body_mismatch_rejects_before_module(
    space_client: TestClient,
    fake_focus_session_module: FakeFocusSessionModule,
) -> None:
    body = {
        "commandId": "review-1",
        "spaceId": "space-a",
        "sessionId": "session-b",
        "ownershipEpoch": None,
        "payloadHash": _HEX64,
        "payload": {
            "expectedVersion": 1,
            "validity": "valid",
            "reviewState": "skipped",
            "reviewedAt": "2026-07-15T08:30:00Z",
            "outcomes": [],
        },
    }

    response = space_client.post(
        "/api/v1/focus-sessions/session-a/review",
        headers={"Accept": "application/vnd.pomodoroxii.error+json;version=2"},
        json=body,
    )

    assert response.status_code == 422
    assert fake_focus_session_module.calls == []


def test_focus_session_space_mismatch_rejects_before_module(
    space_client: TestClient,
    fake_focus_session_module: FakeFocusSessionModule,
) -> None:
    body = {
        "commandId": "review-1",
        "spaceId": "space-b",
        "sessionId": "session-a",
        "ownershipEpoch": None,
        "payloadHash": _HEX64,
        "payload": {
            "expectedVersion": 1,
            "validity": "valid",
            "reviewState": "skipped",
            "reviewedAt": "2026-07-15T08:30:00Z",
            "outcomes": [],
        },
    }

    response = space_client.post(
        "/api/v1/focus-sessions/session-a/review",
        headers={"Accept": "application/vnd.pomodoroxii.error+json;version=2"},
        json=body,
    )

    assert response.status_code == 403
    assert response.json()["code"] == "space_scope_mismatch"
    assert fake_focus_session_module.calls == []


def test_active_idempotency_mismatch_rejects_before_coordinator(
    master_client: TestClient,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
) -> None:
    response = master_client.post(
        "/api/v1/active-session/start",
        headers={
            "Idempotency-Key": "different-command",
            "Accept": "application/vnd.pomodoroxii.error+json;version=2",
        },
        json=valid_active_request("start", "start-command"),
    )

    assert response.status_code == 409
    assert response.json()["code"] == "idempotency_conflict"
    assert fake_active_session_coordinator.calls == []


def test_active_mapper_emits_snake_case_payload(
    master_client: TestClient,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
) -> None:
    response = master_client.post(
        "/api/v1/active-session/start",
        json=valid_active_request("start", "start-command"),
    )

    assert response.status_code == 201
    command = fake_active_session_coordinator.calls[0][2]
    assert command.payload == {
        "level2_work_item_id": "l2-a",
        "level3_work_item_ids": ["l3-a"],
        "planned_seconds": 1500,
        "started_at": "2026-07-15T08:00:00Z",
        "owner_device_id": "device-a",
        "owner_tab_id": "tab-a",
        "expected_work_item_versions": {"l2-a": 1, "l3-a": 1},
    }


def test_openapi_uses_operation_specific_active_session_models(
    contract_app: FastAPI,
) -> None:
    schema = contract_app.openapi()
    paths = schema["paths"]

    resume_request = paths["/api/v1/active-session/resume"]["post"]["requestBody"]
    heartbeat_response = paths["/api/v1/active-session/heartbeat"]["post"]["responses"]["200"]
    end_response = paths["/api/v1/active-session/end"]["post"]["responses"]["200"]
    pause_response = paths["/api/v1/active-session/pause"]["post"]["responses"]["200"]
    start_response = paths["/api/v1/active-session/start"]["post"]["responses"]["201"]

    assert "ResumeActiveSessionRequest" in str(resume_request)
    assert "ActiveSessionLocatorResponse" in str(heartbeat_response)
    assert "EndActiveSessionResponse" in str(end_response)
    assert "ActiveSessionResponse" in str(pause_response)
    assert "ActiveSessionResponse" in str(start_response)
    assert "ActivationConflictResponse" not in str(start_response)


def test_active_locate_serializes_activation_conflict_union(
    master_client: TestClient,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
) -> None:
    async def locate_conflict(principal: Any) -> ActiveSessionView:
        fake_active_session_coordinator.calls.append(("locate", principal))
        return ActiveSessionView(
            value={
                "kind": "activation_conflict",
                "active": _active_value("active-session"),
                "candidate": {
                    "spaceId": "space-b",
                    "sessionId": "candidate-session",
                    "session": _focus_value("candidate-session"),
                },
            }
        )

    fake_active_session_coordinator.locate = locate_conflict  # type: ignore[method-assign]

    response = master_client.get("/api/v1/active-session")

    assert response.status_code == 200
    assert response.json()["kind"] == "activation_conflict"


@pytest.mark.parametrize(
    "mutate",
    (
        lambda body: body["payload"].update(cachedAt="2026-07-15T07:59:00Z"),
        lambda body: body["payload"]["snapshot"]["context"].update(
            level2EffortLowerSecondsSnapshot=2500,
            level2EffortUpperSecondsSnapshot=2000,
        ),
        lambda body: body["payload"]["snapshot"]["plan"].append(
            deepcopy(body["payload"]["snapshot"]["plan"][0])
        ),
        lambda body: body["payload"].update(expectedWorkItemVersions={"l2-a": 4}),
        lambda body: body["payload"]["snapshot"]["session"].update(
            grossSeconds=299,
            focusedSeconds=299,
        ),
    ),
)
def test_activate_provisional_rejects_cross_object_invariant_violations(
    mutate: Any,
) -> None:
    body = valid_active_request("activate-provisional", "activate-command")
    mutate(body)

    with pytest.raises(ValidationError):
        ActivateProvisionalRequest.model_validate(body)


def test_canonical_utc_rejects_impossible_calendar_timestamp() -> None:
    body = valid_active_request("heartbeat", "heartbeat-command")
    body["payload"]["heartbeatAt"] = "2026-99-99T08:05:00Z"

    with pytest.raises(ValidationError):
        HeartbeatRequest.model_validate(body)


# --------------------------------------------------------------------------- #
# Fail-closed tests
# --------------------------------------------------------------------------- #


def test_focus_session_provider_not_installed_raises() -> None:
    """Without provider override, the dependency must raise RuntimeError."""
    app = FastAPI()
    app.include_router(focus_sessions_router, prefix="/api/v1/focus-sessions")
    client = TestClient(app, raise_server_exceptions=True)
    with pytest.raises(RuntimeError, match="SpaceRuntime is not installed"):
        client.get("/api/v1/focus-sessions/session-a")


def test_active_session_provider_not_installed_raises() -> None:
    """Without provider override, the dependency must raise RuntimeError."""
    app = FastAPI()
    app.include_router(active_session_router, prefix="/api/v1/active-session")
    client = TestClient(app, raise_server_exceptions=True)
    with pytest.raises(RuntimeError, match="provider is not installed"):
        client.get("/api/v1/active-session")


# --------------------------------------------------------------------------- #
# Not-mounted test
# --------------------------------------------------------------------------- #


def test_focus_session_contract_routers_not_mounted_in_production_v1() -> None:
    """The production v1 router must NOT include contract routers."""
    from app.routes.v1 import build_v1_router

    router = build_v1_router()
    paths: set[str] = set()
    for route in router.routes:
        if hasattr(route, "path"):
            paths.add(route.path)
        elif type(route).__name__ == "_IncludedRouter":
            try:
                for candidate in route.effective_candidates():
                    if hasattr(candidate, "path"):
                        paths.add(candidate.path)
            except Exception:
                pass
    assert "/api/v1/focus-sessions" not in paths
    assert "/api/v1/focus-sessions/{session_id}" not in paths
    assert "/api/v1/active-session" not in paths
    assert "/api/v1/active-session/start" not in paths
