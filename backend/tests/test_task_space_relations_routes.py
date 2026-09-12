"""Relation REST contract: camelCase parsing, delegation, minimal projection.

Phase D 防护重点：
- 跨 Project 的对端一律是 ``WorkItemMinimalProjection``（5 个字段），
  **绝不能**带上 note 正文或 Session 历史；
- ``extra="forbid"`` 拒收 snake_case 与任何额外字段；
- 跨 Space 的 body 在触达命令模块前就被 403 拦下。
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
from app.routes.v1.relations import router as relations_router
from app.task_space.contracts import RelationCommand, TaskSpaceAccepted, relation_id

CANONICAL_ACCEPT = "application/vnd.pomodoroxii.error+json;version=2"

_TIMESTAMP = "2026-01-01T00:00:00.000Z"
_FROM = "work-from"
_TO = "work-to"
_RELATION_ID = relation_id("s1", _FROM, _TO, "depends_on")


def _relation_row(*, resolution: str | None = None) -> dict[str, object]:
    return {
        "id": _RELATION_ID,
        "space_id": "s1",
        "from_work_item_id": _FROM,
        "to_work_item_id": _TO,
        "relation_type": "depends_on",
        # ★ 2026-09-12（D2 / ADR-0004）：DB 行 / 命令后像恒携带确认两列。
        "resolution": resolution,
        "resolved_at": _TIMESTAMP if resolution is not None else None,
        "version": 1,
        "created_at": _TIMESTAMP,
        "updated_at": _TIMESTAMP,
    }


class FakeRelationQueryModule:
    async def list_relations(self, scope: Any, work_item_id: str | None):
        return (_relation_row(),)

    async def blocked_map(self, scope: Any, project_id: str | None):
        return {"work-from": {"blockedByDependency": True, "isBlocked": True}}


class FakeRelationCommandModule:
    def __init__(self) -> None:
        self.last_command: Any = None
        self.calls: list[Any] = []

    async def execute(self, scope: Any, command: Any) -> TaskSpaceAccepted:
        self.calls.append(command)
        self.last_command = command
        # ★ D2：resolve 的后像携带确认两列（服务端打戳）。
        row = _relation_row(
            resolution=(
                "confirmed_not_required"
                if getattr(command, "operation", None) == "resolve"
                else None
            )
        )
        return TaskSpaceAccepted(
            command_id=command.command_id,
            entity_type="relation",
            entity_id=command.relation_id,
            version=1,
            value=row,
        )


@pytest.fixture()
def fake_commands() -> FakeRelationCommandModule:
    return FakeRelationCommandModule()


@pytest.fixture()
def client(fake_commands: FakeRelationCommandModule) -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(relations_router, prefix="/api/v1/relations")

    # A minimal WorkItem stand-in for the minimal-projection query.
    class _WorkItem:
        id = _TO
        display_key = "OTHER-7"
        project_id = "project-2"
        title = "Foreign upstream"
        status_definition_id = "sys-status-in-progress"

    class _Result:
        def scalars(self):
            return [_WorkItem()]

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args: object) -> bool:
            return False

        async def execute(self, statement: Any) -> _Result:
            return _Result()

    def _scope() -> SimpleNamespace:
        def session_factory() -> _Session:
            return _Session()

        return SimpleNamespace(
            scope=SimpleNamespace(space_id="s1"),
            session_factory=session_factory,
        )

    app.dependency_overrides[get_task_space_command_module] = lambda: fake_commands
    app.dependency_overrides[get_task_space_query_module] = lambda: FakeRelationQueryModule()
    app.dependency_overrides[get_space_runtime_handle] = _scope
    return TestClient(app)


def _create_body(command_id: str, space_id: str = "s1") -> dict[str, object]:
    return {
        "commandId": command_id,
        "spaceId": space_id,
        "payloadHash": "a" * 64,
        "fromWorkItemId": _FROM,
        "toWorkItemId": _TO,
        "relationType": "depends_on",
    }


def test_create_route_delegates_a_canonical_relation_command(client, fake_commands) -> None:
    resp = client.post(
        "/api/v1/relations",
        json=_create_body("rel-create-r1"),
        headers={"Idempotency-Key": "rel-create-r1"},
    )

    assert resp.status_code == 201, resp.text
    command = fake_commands.last_command
    assert isinstance(command, RelationCommand)
    assert command.operation == "create"
    assert command.from_work_item_id == _FROM
    assert command.to_work_item_id == _TO
    # relation_id is derived, never client-supplied.
    assert command.relation_id == _RELATION_ID
    assert command.expected_version is None
    assert resp.json()["value"]["relationType"] == "depends_on"


def test_create_route_rejects_snake_case(client) -> None:
    resp = client.post(
        "/api/v1/relations",
        json={
            "command_id": "rel-create-r2",
            "space_id": "s1",
            "payload_hash": "a" * 64,
            "from_work_item_id": _FROM,
            "to_work_item_id": _TO,
            "relation_type": "depends_on",
        },
        headers={"Idempotency-Key": "rel-create-r2"},
    )
    assert resp.status_code == 422


def test_create_route_rejects_a_client_supplied_relation_id(client) -> None:
    resp = client.post(
        "/api/v1/relations",
        json={**_create_body("rel-create-r3"), "relationId": "rel_forged"},
        headers={"Idempotency-Key": "rel-create-r3"},
    )
    assert resp.status_code == 422


def test_create_route_refuses_a_cross_space_body(client, fake_commands) -> None:
    resp = client.post(
        "/api/v1/relations",
        json=_create_body("rel-create-r4", space_id="s2"),
        headers={"Idempotency-Key": "rel-create-r4", "Accept": CANONICAL_ACCEPT},
    )

    assert resp.status_code == 403, resp.text
    assert resp.json()["code"] == "space_scope_mismatch"
    assert fake_commands.calls == []


def test_remove_route_requires_matching_path_and_body_identity(client, fake_commands) -> None:
    body = {
        **_create_body("rel-remove-r1"),
        "expectedVersion": 1,
    }
    ok = client.request(
        "DELETE",
        f"/api/v1/relations/{_RELATION_ID}",
        json=body,
        headers={"Idempotency-Key": "rel-remove-r1"},
    )
    assert ok.status_code == 200, ok.text
    command = fake_commands.last_command
    assert isinstance(command, RelationCommand)
    assert command.operation == "remove"
    assert command.expected_version == 1

    mismatched = client.request(
        "DELETE",
        "/api/v1/relations/rel_something_else",
        json={**_create_body("rel-remove-r2"), "expectedVersion": 1},
        headers={"Idempotency-Key": "rel-remove-r2", "Accept": CANONICAL_ACCEPT},
    )
    assert mismatched.status_code == 422
    assert mismatched.json()["code"] == "entity_id_mismatch"


def test_list_route_projects_the_far_endpoint_minimally(client) -> None:
    """Phase D leak guard: a cross-Project endpoint carries 5 fields only."""
    resp = client.get("/api/v1/relations", params={"workItemId": _FROM})

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["blockers"], payload
    projected = payload["blockers"][0]["workItem"]
    assert set(projected) == {
        "id", "displayKey", "projectId", "title", "statusDefinitionId",
    }
    # The foreign work item belongs to another project — that is allowed.
    assert projected["projectId"] == "project-2"
    # A downstream view (someone waits for _FROM) is empty for this fixture
    # because the single row has _FROM as its blocked side.
    assert payload["blocking"] == []


def test_blocked_map_route_returns_derived_state_only(client) -> None:
    resp = client.get("/api/v1/relations/blocked-map", params={"projectId": "project-1"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["items"] == {
        "work-from": {"blockedByDependency": True, "isBlocked": True},
    }


def test_relation_wire_schemas_are_alias_only() -> None:
    from pydantic import ValidationError

    from app.schemas.relation import CreateRelationRequest

    with pytest.raises(ValidationError):
        CreateRelationRequest.model_validate({
            "command_id": "x",
            "space_id": "s1",
            "payload_hash": "a" * 64,
            "from_work_item_id": _FROM,
            "to_work_item_id": _TO,
            "relation_type": "depends_on",
        })
    parsed = CreateRelationRequest.model_validate({
        "commandId": "x",
        "spaceId": "s1",
        "payloadHash": "a" * 64,
        "fromWorkItemId": _FROM,
        "toWorkItemId": _TO,
        "relationType": "depends_on",
    })
    assert parsed.relation_type == "depends_on"


def test_resolve_route_delegates_the_confirmation_command(client, fake_commands) -> None:
    """★ D2（ADR-0004）：POST /relations/{id}/resolve 委托 resolve 命令，后像带确认列。"""
    body = {
        "commandId": "rel-resolve-r1",
        "spaceId": "s1",
        "expectedVersion": 1,
        "payloadHash": "b" * 64,
        "fromWorkItemId": _FROM,
        "toWorkItemId": _TO,
        "relationType": "depends_on",
    }
    resp = client.post(
        f"/api/v1/relations/{_RELATION_ID}/resolve",
        json=body,
        headers={"Idempotency-Key": "rel-resolve-r1"},
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, RelationCommand)
    assert command.operation == "resolve"
    assert command.relation_id == _RELATION_ID
    assert command.expected_version == 1
    value = resp.json()["value"]
    assert value["resolution"] == "confirmed_not_required"
    assert value["resolvedAt"] == _TIMESTAMP


def test_resolve_route_rejects_caller_supplied_resolution_or_timestamp(client) -> None:
    """resolved_at / resolution 由服务端自持：extra="forbid" 一律 422 拒收。"""
    base = {
        "commandId": "rel-resolve-r2",
        "spaceId": "s1",
        "expectedVersion": 1,
        "payloadHash": "b" * 64,
        "fromWorkItemId": _FROM,
        "toWorkItemId": _TO,
        "relationType": "depends_on",
    }
    for extra in (
        {"resolvedAt": _TIMESTAMP},
        {"resolution": "confirmed_not_required"},
    ):
        resp = client.post(
            f"/api/v1/relations/{_RELATION_ID}/resolve",
            json={**base, **extra},
            headers={"Idempotency-Key": "rel-resolve-r2"},
        )
        assert resp.status_code == 422, resp.text
