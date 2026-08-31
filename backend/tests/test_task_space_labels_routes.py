"""D5 Y: Label CRUD + work-item label junction route contract tests.

Verifies the thin routers:
1. Parse camelCase wire schemas (snake_case rejected by extra=forbid).
2. Delegate exactly one LabelCommand / add|remove_labels MutateWorkItem.
3. Map responses back to camelCase (labelIds read-only projection on work
   item reads).
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.deps import get_space_runtime_handle
from app.errors import register_exception_handlers
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
)
from app.routes.v1.labels import router as labels_router
from app.routes.v1.work_items import router as work_items_router
from app.task_space.contracts import (
    LabelCommand,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpacePage,
    TaskSpacePageQuery,
    TaskSpaceView,
)

_WIRE_TIMESTAMP = "2026-01-01T00:00:00Z"


def _label_row(label_id: str = "l1") -> dict[str, object]:
    return {
        "id": label_id,
        "name": "Focus",
        "color": "#ff0000",
        "archived_at": None,
        "version": 1,
        "created_at": _WIRE_TIMESTAMP,
        "updated_at": _WIRE_TIMESTAMP,
    }


def _work_item_row(work_item_id: str = "w1") -> dict[str, object]:
    return {
        "id": work_item_id,
        "display_key": "TEST-1",
        "project_id": "p1",
        "title": "Test work item",
        "description": None,
        "type_definition_id": "type-1",
        "status_definition_id": "status-1",
        "priority": None,
        "parent_id": None,
        "child_rank": 0,
        "depth": 1,
        "completion_window_start": None,
        "completion_window_end": None,
        "review_point": None,
        "hard_deadline": None,
        "effort_estimate_lower_seconds": None,
        "effort_estimate_upper_seconds": None,
        "effort_actual_seconds": 0,
        "confidence": None,
        "completed_at": None,
        "cancelled_at": None,
        "archived_at": None,
        "marked_as_attention": False,
        "label_ids": ["l1", "l2"],
        "version": 3,
        "created_at": _WIRE_TIMESTAMP,
        "updated_at": _WIRE_TIMESTAMP,
    }


class FakeTaskSpaceQueryModule:
    async def get_work_item(self, scope: Any, work_item_id: str) -> TaskSpaceView:
        return TaskSpaceView(value=_work_item_row(work_item_id))

    async def list_work_items(self, scope: Any, query: TaskSpacePageQuery) -> TaskSpacePage:
        return TaskSpacePage(items=(_work_item_row(),), next_cursor=None)


class FakeTaskSpaceCommandModule:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.last_command: Any = None

    async def execute(self, scope: Any, command: Any) -> TaskSpaceAccepted:
        self.calls.append((type(command).__name__, command))
        self.last_command = command
        if isinstance(command, LabelCommand):
            return TaskSpaceAccepted(
                command_id=command.command_id,
                entity_type="label",
                entity_id="l1",
                version=1,
                value=_label_row(),
            )
        return TaskSpaceAccepted(
            command_id=command.command_id,
            entity_type="work_item",
            entity_id="w1",
            version=1,
            value={},
        )


@pytest.fixture()
def fake_commands() -> FakeTaskSpaceCommandModule:
    return FakeTaskSpaceCommandModule()


@pytest.fixture()
def client(fake_commands: FakeTaskSpaceCommandModule) -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(labels_router, prefix="/api/v1/labels")
    app.include_router(work_items_router, prefix="/api/v1/work-items")
    app.dependency_overrides[get_task_space_command_module] = lambda: fake_commands
    app.dependency_overrides[get_task_space_query_module] = lambda: FakeTaskSpaceQueryModule()
    app.dependency_overrides[get_space_runtime_handle] = lambda: SimpleNamespace(
        scope=SimpleNamespace(space_id="s1")
    )
    return TestClient(app)


def _headers(command_id: str) -> dict[str, str]:
    return {"Idempotency-Key": command_id}


def test_create_label_route_parses_camel_case_and_delegates(client, fake_commands) -> None:
    command_id = "label-create-r1"
    resp = client.post(
        "/api/v1/labels",
        json={
            "commandId": command_id,
            "spaceId": "s1",
            "payloadHash": "a" * 64,
            "name": "Focus",
            "color": "#ff0000",
        },
        headers=_headers(command_id),
    )

    assert resp.status_code == 201, resp.text
    command = fake_commands.last_command
    assert isinstance(command, LabelCommand)
    assert command.operation == "create"
    assert command.payload == {"name": "Focus", "color": "#ff0000"}
    assert resp.json()["value"]["name"] == "Focus"


def test_create_label_route_rejects_snake_case(client) -> None:
    resp = client.post(
        "/api/v1/labels",
        json={
            "commandId": "label-create-r2",
            "spaceId": "s1",
            "payloadHash": "a" * 64,
            "name": "Focus",
            "color": "#ff0000",
        },
        headers=_headers("label-create-r2"),
    )
    assert resp.status_code == 201, resp.text
    snake = client.post(
        "/api/v1/labels",
        json={
            "command_id": "label-create-r3",
            "space_id": "s1",
            "payload_hash": "a" * 64,
            "name": "Focus",
        },
        headers=_headers("label-create-r3"),
    )
    assert snake.status_code == 422


def test_update_label_route_delegates_patch_fields(client, fake_commands) -> None:
    resp = client.patch(
        "/api/v1/labels/l1",
        json={
            "commandId": "label-upd-r1",
            "spaceId": "s1",
            "expectedVersion": 1,
            "payloadHash": "a" * 64,
            "name": "Renamed",
        },
        headers=_headers("label-upd-r1"),
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, LabelCommand)
    assert command.operation == "update"
    assert command.label_id == "l1"
    assert command.expected_version == 1
    assert command.payload == {"name": "Renamed"}


def test_archive_label_route_delegates_archive(client, fake_commands) -> None:
    resp = client.request(
        "DELETE",
        "/api/v1/labels/l1",
        json={
            "commandId": "label-arc-r1",
            "spaceId": "s1",
            "expectedVersion": 1,
            "payloadHash": "a" * 64,
        },
        headers=_headers("label-arc-r1"),
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, LabelCommand)
    assert command.operation == "archive"
    assert command.label_id == "l1"


def test_add_labels_route_delegates_full_target_set(client, fake_commands) -> None:
    resp = client.post(
        "/api/v1/work-items/w1/labels",
        json={
            "commandId": "labels-add-r1",
            "spaceId": "s1",
            "expectedVersion": 2,
            "payloadHash": "a" * 64,
            "labelIds": ["l2", "l1"],
        },
        headers=_headers("labels-add-r1"),
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, MutateWorkItem)
    assert command.payload["operation"] == "add_labels"
    assert command.payload["label_ids"] == ["l1", "l2"]
    assert command.expected_version == 2


def test_remove_labels_route_delegates_full_target_set(client, fake_commands) -> None:
    resp = client.request(
        "DELETE",
        "/api/v1/work-items/w1/labels/l1",
        json={
            "commandId": "labels-rm-r1",
            "spaceId": "s1",
            "expectedVersion": 3,
            "payloadHash": "a" * 64,
            "labelIds": ["l2"],
        },
        headers=_headers("labels-rm-r1"),
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, MutateWorkItem)
    assert command.payload["operation"] == "remove_labels"
    assert command.payload["label_ids"] == ["l2"]


def test_work_item_read_projects_label_ids(client) -> None:
    resp = client.get("/api/v1/work-items/w1")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["labelIds"] == ["l1", "l2"]


def test_label_wire_schemas_are_alias_only() -> None:
    from pydantic import ValidationError

    from app.schemas.task_space import AddWorkItemLabelsRequest

    with pytest.raises(ValidationError):
        AddWorkItemLabelsRequest.model_validate({
            "command_id": "x",
            "space_id": "s1",
            "expected_version": 1,
            "payload_hash": "a" * 64,
            "label_ids": ["l1"],
        })
    parsed = AddWorkItemLabelsRequest.model_validate({
        "commandId": "x",
        "spaceId": "s1",
        "expectedVersion": 1,
        "payloadHash": "a" * 64,
        "labelIds": ["l1"],
    })
    assert parsed.label_ids == ["l1"]
