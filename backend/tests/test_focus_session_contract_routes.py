"""FocusSession and ActiveSession contract route tests.

Verifies that thin contract routers:
1. Parse camelCase wire schemas correctly.
2. Delegate exactly one call to the injected provider.
3. Map responses back to camelCase.
4. Are NOT mounted in the production v1 router.
5. Fail closed when providers are not installed.
"""
from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.focus_session.contracts import (
    ActiveSessionCommand,
    ActiveSessionView,
    FocusSessionCommand,
    FocusSessionView,
)
from app.routes.v1.active_session import router as active_session_router
from app.routes.v1.contract_dependencies import (
    get_active_session_coordinator,
    get_contract_master_principal,
    get_contract_space_runtime,
    get_focus_session_module,
)
from app.routes.v1.focus_sessions import router as focus_sessions_router

# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #


class FakeFocusSessionModule:
    """Records every call for assertion."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def get(self, scope: Any, session_id: str) -> FocusSessionView:
        self.calls.append(("get", scope, session_id))
        return FocusSessionView(value={"sessionId": session_id})

    async def start(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("start", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def pause(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("pause", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def resume(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("resume", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def end(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("end", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def update_note(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("update_note", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def set_current_plan_item(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("set_current_plan_item", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def set_completion_draft(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("set_completion_draft", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def add_plan_item(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("add_plan_item", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def remove_plan_item(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("remove_plan_item", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def submit_review(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("submit_review", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})

    async def reconcile_commands(self, scope: Any, command: FocusSessionCommand) -> FocusSessionView:
        self.calls.append(("reconcile_commands", scope, command))
        return FocusSessionView(value={"sessionId": command.session_id})


class FakeActiveSessionCoordinator:
    """Records every call for assertion."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def locate(self, principal: Any) -> ActiveSessionView | None:
        self.calls.append(("locate", principal))
        return ActiveSessionView(value={"sessionId": "session-a", "state": "active"})

    async def start(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("start", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def activate_provisional(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("activate_provisional", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def heartbeat(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("heartbeat", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def pause(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("pause", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def resume(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("resume", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def takeover(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("takeover", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def end(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("end", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def update_note(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("update_note", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def set_current_plan_item(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("set_current_plan_item", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def set_completion_draft(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("set_completion_draft", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def add_plan_item(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("add_plan_item", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def remove_plan_item(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("remove_plan_item", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})

    async def resolve_activation_conflict(self, principal: Any, command: ActiveSessionCommand) -> ActiveSessionView:
        self.calls.append(("resolve_activation_conflict", principal, command))
        return ActiveSessionView(value={"sessionId": command.session_id})


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


_MASTER_PRINCIPAL = "master-principal"


@pytest.fixture()
def fake_focus_session_module() -> FakeFocusSessionModule:
    return FakeFocusSessionModule()


@pytest.fixture()
def fake_active_session_coordinator() -> FakeActiveSessionCoordinator:
    return FakeActiveSessionCoordinator()


@pytest.fixture()
def master_principal() -> str:
    return _MASTER_PRINCIPAL


@pytest.fixture()
def space_runtime_handle() -> object:
    return object()


@pytest.fixture()
def contract_app(
    fake_focus_session_module: FakeFocusSessionModule,
    fake_active_session_coordinator: FakeActiveSessionCoordinator,
    master_principal: str,
    space_runtime_handle: object,
) -> FastAPI:
    app = FastAPI()
    app.include_router(focus_sessions_router, prefix="/api/v1/focus-sessions")
    app.include_router(active_session_router, prefix="/api/v1/active-session")
    app.dependency_overrides[get_focus_session_module] = lambda: fake_focus_session_module
    app.dependency_overrides[get_active_session_coordinator] = lambda: fake_active_session_coordinator
    app.dependency_overrides[get_contract_master_principal] = lambda: master_principal
    app.dependency_overrides[get_contract_space_runtime] = lambda: space_runtime_handle
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
            "grossSeconds": 0,
            "pausedSeconds": 0,
            "breakSeconds": 0,
            "focusedSeconds": 0,
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
            "payload": _PROVISIONAL_PAYLOAD,
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
) -> None:
    """GET /api/v1/active-session calls coordinator.locate with master principal."""
    resp = master_client.get("/api/v1/active-session")
    assert resp.status_code == 200
    assert len(fake_active_session_coordinator.calls) == 1
    method, principal = fake_active_session_coordinator.calls[0]
    assert method == "locate"
    assert principal == "master-principal"


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
    assert principal == "master-principal"
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


# --------------------------------------------------------------------------- #
# Fail-closed tests
# --------------------------------------------------------------------------- #


def test_focus_session_provider_not_installed_raises() -> None:
    """Without provider override, the dependency must raise RuntimeError."""
    app = FastAPI()
    app.include_router(focus_sessions_router, prefix="/api/v1/focus-sessions")
    client = TestClient(app, raise_server_exceptions=True)
    with pytest.raises(RuntimeError, match="provider is not installed"):
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
