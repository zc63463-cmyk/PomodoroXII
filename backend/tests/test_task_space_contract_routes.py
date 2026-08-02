"""Task Space contract route tests.

Verifies that thin contract routers:
1. Parse camelCase wire schemas correctly.
2. Delegate exactly one call to the injected provider.
3. Map responses back to camelCase.
4. Are NOT mounted in the production v1 router.
5. Fail closed when providers are not installed.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.deps import get_space_runtime_handle
from app.errors import register_exception_handlers
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
)
from app.routes.v1.projects import router as projects_router
from app.routes.v1.work_item_notes import router as notes_router
from app.routes.v1.work_items import router as work_items_router
from app.schemas.task_space import (
    ProjectCreate,
    ProjectResponse,
    WorkItemCreate,
    WorkItemResponse,
)
from app.schemas.work_item_note import WorkItemNoteDocumentV1
from app.task_space.contracts import (
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    NoteCommandKind,
    TaskSpaceAccepted,
    TaskSpaceDefinitionsView,
    TaskSpacePage,
    TaskSpaceView,
    WorkItemNoteCommand,
)

# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #


class FakeTaskSpaceQueryModule:
    """Records every call for assertion."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def list_projects(self, scope: Any, query: Any) -> TaskSpacePage:
        self.calls.append(("list_projects", scope, query))
        return TaskSpacePage(
            items=({"id": "p1", "key": "TEST", "name": "Test"},),
            next_cursor=None,
        )

    async def get_project(self, scope: Any, project_id: str) -> TaskSpaceView:
        self.calls.append(("get_project", scope, project_id))
        return TaskSpaceView(
            value={"id": project_id, "key": "TEST", "name": "Test",
                   "nextWorkItemNumber": 1}
        )

    async def list_definitions(self, scope: Any) -> TaskSpaceDefinitionsView:
        self.calls.append(("list_definitions", scope))
        return TaskSpaceDefinitionsView(statuses=(), types=(), labels=())

    async def list_work_items(self, scope: Any, query: Any) -> TaskSpacePage:
        self.calls.append(("list_work_items", scope, query))
        return TaskSpacePage(items=(), next_cursor=None)

    async def get_work_item(self, scope: Any, work_item_id: str) -> TaskSpaceView:
        self.calls.append(("get_work_item", scope, work_item_id))
        return TaskSpaceView(
            value={"id": work_item_id, "displayKey": "TEST-1"}
        )

    async def read_note(self, scope: Any, work_item_id: str) -> TaskSpaceView | None:
        self.calls.append(("read_note", scope, work_item_id))
        return TaskSpaceView(value={"workItemId": work_item_id})


class FakeTaskSpaceCommandModule:
    """Records every execute() call as a descriptive tuple."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.last_command: Any = None

    async def execute(self, scope: Any, command: Any) -> TaskSpaceAccepted:
        self.last_command = command
        if isinstance(command, WorkItemNoteCommand):
            self.calls.append((
                command.kind.value,
                command.command_id,
                command.space_id,
                command.work_item_id,
                command.expected_version,
            ))
        elif isinstance(command, CreateProject):
            self.calls.append((
                "create_project", command.command_id, command.space_id,
            ))
        elif isinstance(command, CreateWorkItem):
            self.calls.append((
                "create_work_item", command.command_id, command.space_id,
                command.project_id,
            ))
        elif isinstance(command, MutateWorkItem):
            payload_keys = set(command.payload.keys())
            if "status_definition_id" in payload_keys and "title" not in payload_keys:
                kind = "transition"
            elif "parent_id" in payload_keys:
                kind = "move"
            else:
                kind = "update"
            self.calls.append((
                kind, command.command_id, command.space_id,
                command.work_item_id, command.expected_version,
            ))
        return TaskSpaceAccepted(
            command_id=command.command_id,
            entity_type="test",
            entity_id="fake-id",
            version=1,
            value={},
        )


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture()
def fake_task_query() -> FakeTaskSpaceQueryModule:
    return FakeTaskSpaceQueryModule()


@pytest.fixture()
def fake_task_commands() -> FakeTaskSpaceCommandModule:
    return FakeTaskSpaceCommandModule()


@pytest.fixture()
def sentinel_scope() -> object:
    return SimpleNamespace(scope=SimpleNamespace(space_id="s1"))


@pytest.fixture()
def task_space_app(
    fake_task_query: FakeTaskSpaceQueryModule,
    fake_task_commands: FakeTaskSpaceCommandModule,
    sentinel_scope: object,
) -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(projects_router, prefix="/api/v1/projects")
    app.include_router(notes_router, prefix="/api/v1/work-items")
    app.include_router(work_items_router, prefix="/api/v1/work-items")
    app.dependency_overrides[get_task_space_query_module] = lambda: fake_task_query
    app.dependency_overrides[get_task_space_command_module] = lambda: fake_task_commands
    app.dependency_overrides[get_space_runtime_handle] = lambda: sentinel_scope
    return app


@pytest.fixture()
def task_space_client(task_space_app: FastAPI) -> TestClient:
    return TestClient(task_space_app)


# --------------------------------------------------------------------------- #
# Schema ownership tests
# --------------------------------------------------------------------------- #


def test_project_and_work_item_wire_ownership() -> None:
    """ProjectCreate normalises key; response has extra fields."""
    assert ProjectCreate(key=" px12 ", name="Project").key == "PX12"
    assert "key" in ProjectCreate.model_fields
    assert "next_work_item_number" not in ProjectCreate.model_fields
    assert {"key", "next_work_item_number"} <= set(ProjectResponse.model_fields)
    assert "display_key" not in WorkItemCreate.model_fields
    assert "display_key" in WorkItemResponse.model_fields
    with pytest.raises(ValidationError):
        ProjectCreate(key="1px", name="Project")


def test_project_create_rejects_snake_case() -> None:
    """WireModel must reject snake_case aliases."""
    with pytest.raises(ValidationError):
        ProjectCreate.model_validate({"key": "TEST", "name": "T", "next_work_item_number": 1})


def test_work_item_create_rejects_display_key() -> None:
    """Create schemas must not accept response-only fields."""
    with pytest.raises(ValidationError):
        WorkItemCreate.model_validate({
            "projectId": "p1", "title": "T", "displayKey": "TEST-1",
        })


# --------------------------------------------------------------------------- #
# Route delegation tests
# --------------------------------------------------------------------------- #


def test_list_projects_delegates_to_query(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/projects")
    assert resp.status_code == 200
    assert len(fake_task_query.calls) == 1
    assert fake_task_query.calls[0][0] == "list_projects"


def test_create_project_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.post("/api/v1/projects", json={
        "commandId": "cmd-p1", "spaceId": "s1",
        "payloadHash": "a" * 64,
        "key": "PROJ", "name": "Project One",
    })
    assert resp.status_code == 201
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == ("create_project", "cmd-p1", "s1")


def test_get_project_delegates_to_query(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/projects/p1")
    assert resp.status_code == 200
    assert len(fake_task_query.calls) == 1
    assert fake_task_query.calls[0] == ("get_project", fake_task_query.calls[0][1], "p1")


def test_list_definitions_delegates_to_query(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/projects/definitions")
    assert resp.status_code == 200
    assert len(fake_task_query.calls) == 1
    assert fake_task_query.calls[0][0] == "list_definitions"


def test_list_work_items_delegates_to_query(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/work-items")
    assert resp.status_code == 200
    assert len(fake_task_query.calls) == 1
    assert fake_task_query.calls[0][0] == "list_work_items"


def test_list_work_items_with_project_filter(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/work-items?projectId=p1")
    assert resp.status_code == 200
    _, _, query = fake_task_query.calls[0]
    assert query.filters.get("project_id") == "p1"


def test_create_work_item_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.post("/api/v1/work-items", json={
        "commandId": "cmd-w1", "spaceId": "s1",
        "payloadHash": "b" * 64,
        "projectId": "p1", "title": "Task One",
    })
    assert resp.status_code == 201
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == ("create_work_item", "cmd-w1", "s1", "p1")


def test_get_work_item_delegates_to_query(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/work-items/w1")
    assert resp.status_code == 200
    assert len(fake_task_query.calls) == 1
    assert fake_task_query.calls[0] == ("get_work_item", fake_task_query.calls[0][1], "w1")


def test_update_work_item_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.patch("/api/v1/work-items/w1", json={
        "commandId": "cmd-u1", "spaceId": "s1",
        "expectedVersion": 2, "payloadHash": "c" * 64,
        "title": "Updated",
    })
    assert resp.status_code == 200
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == ("update", "cmd-u1", "s1", "w1", 2)


def test_move_work_item_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.post("/api/v1/work-items/w1/move", json={
        "commandId": "cmd-m1", "spaceId": "s1",
        "expectedVersion": 2, "payloadHash": "d" * 64,
        "parentId": "parent-1",
    })
    assert resp.status_code == 200
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == ("move", "cmd-m1", "s1", "w1", 2)


def test_transition_work_item_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.post("/api/v1/work-items/w1/transition", json={
        "commandId": "cmd-t1", "spaceId": "s1",
        "expectedVersion": 2, "payloadHash": "e" * 64,
        "statusDefinitionId": "sys-status-completed",
    })
    assert resp.status_code == 200
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == ("transition", "cmd-t1", "s1", "w1", 2)


def test_read_note_delegates_to_query(
    task_space_client: TestClient, fake_task_query: FakeTaskSpaceQueryModule,
) -> None:
    resp = task_space_client.get("/api/v1/work-items/w1/note")
    assert resp.status_code == 200
    assert len(fake_task_query.calls) == 1
    assert fake_task_query.calls[0] == ("read_note", fake_task_query.calls[0][1], "w1")


def test_replace_document_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.put("/api/v1/work-items/w1/note", json={
        "commandId": "cmd-r1", "spaceId": "s1",
        "expectedVersion": None, "payloadHash": "f" * 64,
        "document": {
            "contentVersion": 1,
            "blocks": [
                {"type": "paragraph", "blockId": "b1", "text": "Hello"},
            ],
        },
    })
    assert resp.status_code == 200
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == (
        NoteCommandKind.REPLACE_DOCUMENT.value, "cmd-r1", "s1", "w1", None,
    )


def test_append_blocks_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.post("/api/v1/work-items/w1/note/append-blocks", json={
        "commandId": "cmd-a1", "spaceId": "s1",
        "expectedVersion": 1, "payloadHash": "a" * 64,
        "blocks": [
            {"type": "paragraph", "blockId": "b2", "text": "Appended"},
        ],
    })
    assert resp.status_code == 200
    assert len(fake_task_commands.calls) == 1
    assert fake_task_commands.calls[0] == (
        NoteCommandKind.APPEND_BLOCKS.value, "cmd-a1", "s1", "w1", 1,
    )


def test_toggle_checklist_item_delegates_to_commands(
    task_space_client: TestClient, fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    resp = task_space_client.post(
        "/api/v1/work-items/w1/note/toggle-checklist-item",
        json={
            "commandId": "cmd-1", "spaceId": "s1",
            "expectedVersion": 2, "payloadHash": "a" * 64,
            "blockId": "b1", "itemId": "i1", "checked": True,
        },
    )
    assert resp.status_code == 200
    assert fake_task_commands.calls == [
        ("toggle_checklist_item", "cmd-1", "s1", "w1", 2),
    ]


def test_idempotency_key_mismatch_rejects_before_module(
    task_space_client: TestClient,
    fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    response = task_space_client.post(
        "/api/v1/projects",
        headers={
            "Idempotency-Key": "different-command",
            "Accept": "application/vnd.pomodoroxii.error+json;version=2",
        },
        json={
            "commandId": "create-project",
            "spaceId": "s1",
            "payloadHash": "a" * 64,
            "key": "PROJ",
            "name": "Project One",
        },
    )

    assert response.status_code == 409
    assert response.json()["code"] == "idempotency_conflict"
    assert fake_task_commands.calls == []


def test_space_id_mismatch_rejects_before_module(
    task_space_client: TestClient,
    fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    response = task_space_client.post(
        "/api/v1/projects",
        headers={"Accept": "application/vnd.pomodoroxii.error+json;version=2"},
        json={
            "commandId": "create-project",
            "spaceId": "other-space",
            "payloadHash": "a" * 64,
            "key": "PROJ",
            "name": "Project One",
        },
    )

    assert response.status_code == 403
    assert response.json()["code"] == "space_scope_mismatch"
    assert fake_task_commands.calls == []


def test_note_mapper_preserves_frozen_content_v1_aliases(
    task_space_client: TestClient,
    fake_task_commands: FakeTaskSpaceCommandModule,
) -> None:
    response = task_space_client.put(
        "/api/v1/work-items/w1/note",
        json={
            "commandId": "replace-note",
            "spaceId": "s1",
            "expectedVersion": 1,
            "payloadHash": "a" * 64,
            "document": {
                "contentVersion": 1,
                "blocks": [{"type": "paragraph", "blockId": "b1", "text": "Hello"}],
            },
        },
    )

    assert response.status_code == 200
    command = fake_task_commands.last_command
    assert command.payload == {
        "document": {
            "contentVersion": 1,
            "blocks": [{"type": "paragraph", "blockId": "b1", "text": "Hello"}],
        }
    }


@pytest.mark.parametrize(
    "document",
    (
        {
            "contentVersion": 1,
            "blocks": [
                {"type": "paragraph", "blockId": "duplicate", "text": "one"},
                {"type": "paragraph", "blockId": "duplicate", "text": "two"},
            ],
        },
        {
            "contentVersion": 1,
            "blocks": [
                {
                    "type": "checklist",
                    "blockId": "b1",
                    "items": [
                        {
                            "itemId": "i1",
                            "text": "one",
                            "checked": False,
                            "children": [
                                {
                                    "itemId": "i2",
                                    "text": "two",
                                    "checked": False,
                                    "children": [
                                        {
                                            "itemId": "i3",
                                            "text": "three",
                                            "checked": False,
                                            "children": [],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "contentVersion": 1,
            "blocks": [
                {
                    "type": "checklist",
                    "blockId": "b1",
                    "items": [
                        {"itemId": "i1", "text": "   ", "checked": False, "children": []}
                    ],
                }
            ],
        },
    ),
)
def test_note_document_rejects_cross_object_invariant_violations(
    document: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        WorkItemNoteDocumentV1.model_validate(document)


# --------------------------------------------------------------------------- #
# Route ordering tests
# --------------------------------------------------------------------------- #


def _flatten_route_paths(router_or_app: Any) -> list[str]:
    """Flatten all route paths, including those from _IncludedRouter objects.

    FastAPI 0.139+ wraps included routers in _IncludedRouter objects that
    lazily expose their routes via effective_candidates().
    """
    paths: list[str] = []
    for route in router_or_app.routes:
        if hasattr(route, "path"):
            paths.append(route.path)
        elif type(route).__name__ == "_IncludedRouter":
            try:
                for candidate in route.effective_candidates():
                    if hasattr(candidate, "path"):
                        paths.append(candidate.path)
            except Exception:
                pass
    return paths


def test_project_definitions_route_before_project_id(
    task_space_app: FastAPI,
) -> None:
    """/definitions must be declared before /{project_id}."""
    all_paths = _flatten_route_paths(task_space_app)
    routes = [p for p in all_paths if p.startswith("/api/v1/projects")]
    defs_idx = routes.index("/api/v1/projects/definitions")
    pid_idx = routes.index("/api/v1/projects/{project_id}")
    assert defs_idx < pid_idx, (
        f"/definitions (index {defs_idx}) must come before "
        f"/{{project_id}} (index {pid_idx})"
    )


def test_work_item_action_routes_before_mutation(
    task_space_app: FastAPI,
) -> None:
    """Action/note routes must be declared before /{work_item_id}."""
    all_paths = _flatten_route_paths(task_space_app)
    routes = [p for p in all_paths if p.startswith("/api/v1/work-items")]
    static_routes = [
        r for r in routes
        if not r.endswith("/{work_item_id}")
        and r != "/api/v1/work-items"
    ]
    mutation_idx = routes.index("/api/v1/work-items/{work_item_id}")
    for sr in static_routes:
        sr_idx = routes.index(sr)
        assert sr_idx < mutation_idx, (
            f"Static route {sr} (index {sr_idx}) must come before "
            f"/{{work_item_id}} (index {mutation_idx})"
        )


# --------------------------------------------------------------------------- #
# Fail-closed tests
# --------------------------------------------------------------------------- #


def test_task_space_provider_not_installed_raises() -> None:
    """Without provider override, the dependency must raise RuntimeError."""
    app = FastAPI()
    app.include_router(projects_router, prefix="/api/v1/projects")
    client = TestClient(app, raise_server_exceptions=True)
    with pytest.raises(RuntimeError, match="provider is not installed"):
        client.get("/api/v1/projects")


# --------------------------------------------------------------------------- #
# Not-mounted test
# --------------------------------------------------------------------------- #


def test_contract_routers_not_mounted_in_production_v1() -> None:
    """The production v1 router must NOT include contract routers."""
    from app.routes.v1 import build_v1_router

    router = build_v1_router()
    paths = set(_flatten_route_paths(router))
    assert "/api/v1/projects" not in paths
    assert "/api/v1/work-items" not in paths
    assert "/api/v1/active-session" not in paths
    assert "/api/v1/focus-sessions" not in paths
