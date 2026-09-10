"""WorkItem Trash / Restore: thin-router contract + typed-command semantics.

Covers the two new ``archived_at`` lifecycle commands end to end:

* the routers parse camelCase, reject snake_case / forged timestamps, bind the
  idempotency key and refuse cross-Space bodies;
* ``_compile_TrashWorkItem`` / ``_compile_RestoreWorkItem`` stamp a server-owned
  ``archived_at``, bump the version once, emit exactly one update sync event
  carrying the ``label_ids`` projection, and stay idempotent in both
  directions (a repeated command is a zero-effect receipt, never a phantom
  version bump).

No database migration is involved: ``archived_at`` already exists on
``work_items`` and already travels in ``WORK_ITEM_SCALAR_FIELDS``.
"""
from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.deps import get_space_runtime_handle
from app.errors import register_exception_handlers
from app.mutation.types import canonical_payload_hash
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
)
from app.routes.v1.work_items import router as work_items_router
from app.task_space.contracts import (
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpacePage,
    TaskSpacePageQuery,
    TaskSpaceRejected,
    TaskSpaceView,
)

_WIRE_TIMESTAMP = "2026-01-01T00:00:00Z"

# Canonical error negotiation: without this Accept the backend emits the
# legacy envelope, which carries no machine-readable ``code``.
CANONICAL_ACCEPT = "application/vnd.pomodoroxii.error+json;version=2"

# The business payload of both commands is empty: archived_at is server-owned.
_EMPTY_PAYLOAD_HASH = canonical_payload_hash({})


def _work_item_row(
    work_item_id: str = "w1", archived_at: str | None = None, version: int = 3,
) -> dict[str, object]:
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
        "archived_at": archived_at,
        "marked_as_attention": False,
        "label_ids": ["l1"],
        "version": version,
        "created_at": _WIRE_TIMESTAMP,
        "updated_at": _WIRE_TIMESTAMP,
    }


# --------------------------------------------------------------------------- #
# Router contract tests (no database, no compiler)
# --------------------------------------------------------------------------- #


class FakeTaskSpaceQueryModule:
    def __init__(self, archived_at: str | None = None, version: int = 3) -> None:
        self.archived_at = archived_at
        self.version = version

    async def get_work_item(self, scope: Any, work_item_id: str) -> TaskSpaceView:
        return TaskSpaceView(value=_work_item_row(work_item_id, self.archived_at, self.version))

    async def list_work_items(self, scope: Any, query: TaskSpacePageQuery) -> TaskSpacePage:
        return TaskSpacePage(items=(_work_item_row(),), next_cursor=None)


class FakeTaskSpaceCommandModule:
    def __init__(self) -> None:
        self.last_command: Any = None
        self.calls: list[Any] = []

    async def execute(self, scope: Any, command: Any) -> TaskSpaceAccepted:
        self.calls.append(command)
        self.last_command = command
        return TaskSpaceAccepted(
            command_id=command.command_id,
            entity_type="work_item",
            entity_id="w1",
            version=4,
            value={},
        )


@pytest.fixture()
def fake_commands() -> FakeTaskSpaceCommandModule:
    return FakeTaskSpaceCommandModule()


@pytest.fixture()
def client(fake_commands: FakeTaskSpaceCommandModule) -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(work_items_router, prefix="/api/v1/work-items")
    app.dependency_overrides[get_task_space_command_module] = lambda: fake_commands
    app.dependency_overrides[get_task_space_query_module] = lambda: FakeTaskSpaceQueryModule()
    app.dependency_overrides[get_space_runtime_handle] = lambda: _scope("s1")
    return TestClient(app)


def _scope(space_id: str) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(scope=SimpleNamespace(space_id=space_id))


def _body(command_id: str, space_id: str = "s1", expected_version: int = 3) -> dict[str, object]:
    return {
        "commandId": command_id,
        "spaceId": space_id,
        "expectedVersion": expected_version,
        "payloadHash": _EMPTY_PAYLOAD_HASH,
    }


def test_trash_route_delegates_trash_operation(client, fake_commands) -> None:
    resp = client.post(
        "/api/v1/work-items/w1/trash",
        json=_body("trash-r1"),
        headers={"Idempotency-Key": "trash-r1"},
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, MutateWorkItem)
    assert command.payload == {"operation": "trash"}
    assert command.work_item_id == "w1"
    assert command.expected_version == 3
    # The response carries the complete authoritative read projection.
    assert resp.json()["value"]["archivedAt"] is None
    assert resp.json()["value"]["depth"] == 1


def test_restore_route_delegates_restore_operation(client, fake_commands) -> None:
    resp = client.post(
        "/api/v1/work-items/w1/restore",
        json=_body("restore-r1", expected_version=4),
        headers={"Idempotency-Key": "restore-r1"},
    )

    assert resp.status_code == 200, resp.text
    command = fake_commands.last_command
    assert isinstance(command, MutateWorkItem)
    assert command.payload == {"operation": "restore"}
    assert command.expected_version == 4


def test_trash_route_rejects_cross_space_identity(client, fake_commands) -> None:
    resp = client.post(
        "/api/v1/work-items/w1/trash",
        json=_body("trash-r2", space_id="s2"),
        headers={"Idempotency-Key": "trash-r2", "Accept": CANONICAL_ACCEPT},
    )

    assert resp.status_code == 403, resp.text
    assert resp.json()["code"] == "space_scope_mismatch"
    # The command module is never reached: the guard runs before delegation.
    assert fake_commands.calls == []


def test_trash_route_rejects_mismatched_idempotency_key(client) -> None:
    resp = client.post(
        "/api/v1/work-items/w1/trash",
        json=_body("trash-r3"),
        headers={"Idempotency-Key": "another-key", "Accept": CANONICAL_ACCEPT},
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "idempotency_conflict"


def test_trash_route_rejects_snake_case_and_forged_timestamp(client) -> None:
    snake = client.post(
        "/api/v1/work-items/w1/trash",
        json={
            "command_id": "trash-r4",
            "space_id": "s1",
            "expected_version": 3,
            "payload_hash": _EMPTY_PAYLOAD_HASH,
        },
        headers={"Idempotency-Key": "trash-r4"},
    )
    assert snake.status_code == 422

    # archived_at is server-owned: a caller may never supply one.
    forged = client.post(
        "/api/v1/work-items/w1/trash",
        json={**_body("trash-r5"), "archivedAt": _WIRE_TIMESTAMP},
        headers={"Idempotency-Key": "trash-r5"},
    )
    assert forged.status_code == 422


def test_trash_route_rejects_malformed_payload_hash(client) -> None:
    resp = client.post(
        "/api/v1/work-items/w1/trash",
        json={**_body("trash-r6"), "payloadHash": "not-a-hash"},
        headers={"Idempotency-Key": "trash-r6"},
    )
    assert resp.status_code == 422


def test_trash_and_restore_wire_schemas_are_alias_only() -> None:
    from pydantic import ValidationError

    from app.schemas.task_space import RestoreWorkItemRequest, TrashWorkItemRequest

    for model in (TrashWorkItemRequest, RestoreWorkItemRequest):
        with pytest.raises(ValidationError):
            model.model_validate({
                "command_id": "x",
                "space_id": "s1",
                "expected_version": 1,
                "payload_hash": _EMPTY_PAYLOAD_HASH,
            })
        parsed = model.model_validate({
            "commandId": "x",
            "spaceId": "s1",
            "expectedVersion": 1,
            "payloadHash": _EMPTY_PAYLOAD_HASH,
        })
        assert parsed.expected_version == 1


# --------------------------------------------------------------------------- #
# Typed-compiler semantics (real UoW, frozen clock)
# --------------------------------------------------------------------------- #


def _archived_at_command(
    fixture, *, operation: str, work_item_id: str, expected_version: int, command_id: str,
) -> MutateWorkItem:
    return MutateWorkItem(
        command_id=command_id,
        space_id=fixture.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=_EMPTY_PAYLOAD_HASH,
        payload={"operation": operation},
    )


async def _trash(fixture, work_item_id: str, expected_version: int, command_id: str):
    return await fixture.module.execute(
        fixture.scope,
        _archived_at_command(
            fixture, operation="trash", work_item_id=work_item_id,
            expected_version=expected_version, command_id=command_id,
        ),
    )


async def _restore(fixture, work_item_id: str, expected_version: int, command_id: str):
    return await fixture.module.execute(
        fixture.scope,
        _archived_at_command(
            fixture, operation="restore", work_item_id=work_item_id,
            expected_version=expected_version, command_id=command_id,
        ),
    )


@pytest.mark.asyncio
async def test_trash_stamps_server_archived_at_and_bumps_version(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="trash-project", key="TRSH")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Trash me", None, "trash-item"
    )
    item_id = str(item.value["id"])
    before_version = int(item.value["version"])

    outcome = await _trash(task_space_fixture, item_id, before_version, "trash-c1")

    assert not isinstance(outcome, TaskSpaceRejected), getattr(outcome, "code", "")
    assert outcome.value["archived_at"] is not None
    assert outcome.value["version"] == before_version + 1
    row = await task_space_fixture.read_work_item(item_id)
    assert row["archived_at"] == outcome.value["archived_at"]
    assert row["version"] == before_version + 1


@pytest.mark.asyncio
async def test_restore_clears_archived_at(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="restore-project", key="RSTR")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Restore me", None, "restore-item"
    )
    item_id = str(item.value["id"])
    trashed = await _trash(task_space_fixture, item_id, int(item.value["version"]), "restore-c1")
    assert trashed.value["archived_at"] is not None

    restored = await _restore(
        task_space_fixture, item_id, int(trashed.value["version"]), "restore-c2"
    )

    assert not isinstance(restored, TaskSpaceRejected), getattr(restored, "code", "")
    assert restored.value["archived_at"] is None
    assert restored.value["version"] == int(trashed.value["version"]) + 1
    row = await task_space_fixture.read_work_item(item_id)
    assert row["archived_at"] is None


@pytest.mark.asyncio
async def test_trash_twice_is_an_idempotent_zero_effect_receipt(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="idem-project", key="IDEM")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Trash twice", None, "idem-item"
    )
    item_id = str(item.value["id"])
    first = await _trash(task_space_fixture, item_id, int(item.value["version"]), "idem-c1")
    stamped = first.value["archived_at"]

    second = await _trash(
        task_space_fixture, item_id, int(first.value["version"]), "idem-c2"
    )

    # Zero-effect: same version, same timestamp — never a phantom bump that
    # would invalidate every other pending client CAS.
    assert second.value["version"] == first.value["version"]
    assert second.value["archived_at"] == stamped
    row = await task_space_fixture.read_work_item(item_id)
    assert row["archived_at"] == stamped
    assert row["version"] == int(first.value["version"])
    # The first trash emitted exactly one event; the no-op replay emitted none.
    assert len(await task_space_fixture.visible_events(operation_id="idem-c1")) == 1
    assert await task_space_fixture.visible_events(operation_id="idem-c2") == ()


@pytest.mark.asyncio
async def test_restore_of_live_item_is_an_idempotent_zero_effect_receipt(
    task_space_fixture,
) -> None:
    project = await task_space_fixture.create_project(command_id="idem2-project", key="IDM2")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Restore a live item", None, "idem2-item"
    )
    item_id = str(item.value["id"])

    noop = await _restore(
        task_space_fixture, item_id, int(item.value["version"]), "idem2-c1"
    )

    assert noop.value["version"] == int(item.value["version"])
    assert noop.value["archived_at"] is None
    events = await task_space_fixture.visible_events(entity_type="work_item")
    assert len([event for event in events if event.get("entity_id") == item_id]) == 0


@pytest.mark.asyncio
async def test_trash_rejects_stale_expected_version(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="stale-project", key="STAL")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Stale trash", None, "stale-item"
    )
    item_id = str(item.value["id"])

    outcome = await _trash(task_space_fixture, item_id, 99, "stale-c1")

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "version_conflict"


@pytest.mark.asyncio
async def test_trash_rejects_unknown_work_item(task_space_fixture) -> None:
    outcome = await _trash(task_space_fixture, "missing-item", 1, "missing-c1")

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "not_found"


@pytest.mark.asyncio
async def test_trash_rejects_wrong_payload_hash(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="hash-project", key="HASH")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Bad hash", None, "hash-item"
    )
    command = MutateWorkItem(
        command_id="hash-c1",
        space_id=task_space_fixture.space_id,
        work_item_id=str(item.value["id"]),
        expected_version=int(item.value["version"]),
        payload_hash=canonical_payload_hash({"unexpected": True}),
        payload={"operation": "trash"},
    )

    outcome = await task_space_fixture.module.execute(task_space_fixture.scope, command)

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "invalid_payload_hash"


@pytest.mark.asyncio
async def test_trash_sync_event_carries_archived_at_and_label_projection(
    task_space_fixture,
) -> None:
    project = await task_space_fixture.create_project(command_id="evt-project", key="EVNT")
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Emit me", None, "evt-item"
    )
    item_id = str(item.value["id"])
    outcome = await _trash(
        task_space_fixture, item_id, int(item.value["version"]), "evt-c1"
    )

    events = await task_space_fixture.visible_events(operation_id="evt-c1")
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].action == "update"
    assert events[0].entity_id == item_id
    payload = events[0].payload
    assert payload["archived_at"] == outcome.value["archived_at"]
    assert payload["label_ids"] == list(outcome.value["label_ids"])
    assert payload["version"] == outcome.value["version"]


@pytest.mark.asyncio
async def test_trash_and_restore_round_trip_preserves_tree_identity(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="tree-project", key="TREE")
    root = await task_space_fixture.create_work_item(
        project.value["id"], "Root", None, "tree-root"
    )
    child = await task_space_fixture.create_work_item(
        project.value["id"], "Child", str(root.value["id"]), "tree-child"
    )
    child_id = str(child.value["id"])

    trashed = await _trash(
        task_space_fixture, child_id, int(child.value["version"]), "tree-c1"
    )
    restored = await _restore(
        task_space_fixture, child_id, int(trashed.value["version"]), "tree-c2"
    )

    assert restored.value["parent_id"] == str(root.value["id"])
    assert restored.value["display_key"] == child.value["display_key"]
    assert restored.value["archived_at"] is None
