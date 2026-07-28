"""TS1 Task 2: Project command interface and definition queries."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError
from app.models.work_item_definition import (
    Label,
    StatusDefinition,
    TypeDefinition,
    WorkItemLabel,
)
from app.mutation.types import canonical_payload_hash
from app.task_space.compiler import (
    READ_ONLY_SYNC_TYPES,
    TASK_SPACE_POLICY_ENTITY_TYPES,
    _stable_id,
)
from app.task_space.contracts import (
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    NoteCommandKind,
    TaskSpaceAccepted,
    TaskSpaceCommand,
    TaskSpaceCommandModule,
    TaskSpaceOutcome,
    TaskSpacePageQuery,
    TaskSpaceQueryModule,
    TaskSpaceRejected,
    WorkItemNoteCommand,
)
from app.task_space.module import (
    DefaultTaskSpaceCommandModule,
    _business_payload,
    build_task_space_request,
)


def test_task_space_policy_owns_virtual_and_real_catalog_types() -> None:
    assert TASK_SPACE_POLICY_ENTITY_TYPES == {
        "task_space", "project", "status_definition", "type_definition",
        "label", "work_item_label", "work_item", "work_item_note",
    }


READ_ONLY_SYNC_WIRE_TYPES = {
    "project": "project",
    "status_definition": "statusDefinition",
    "type_definition": "typeDefinition",
    "label": "label",
    "work_item_label": "workItemLabel",
}


@pytest.mark.parametrize("entity_type", sorted(READ_ONLY_SYNC_TYPES))
@pytest.mark.parametrize("action", ("create", "update", "delete"))
@pytest.mark.asyncio
async def test_every_read_only_sync_action_is_policy_owned_and_zero_effect(
    task_space_fixture,
    monkeypatch,
    entity_type: str,
    action: str,
) -> None:
    operation_id = f"sync-{entity_type}-{action}"
    before = task_space_fixture.overlay_snapshot()
    event = task_space_fixture.sync_event(
        entity_type=READ_ONLY_SYNC_WIRE_TYPES[entity_type],
        entity_id=f"{entity_type}-candidate",
        action=action,
        payload={},
        expected_version=None if action == "create" else 1,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("Task Space real entity reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )

    assert caught.value.rejection.code == "offline_formal_creation_forbidden"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id=operation_id) == ()


@pytest.mark.asyncio
async def test_project_key_is_uppercased_and_definitions_are_seeded(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(
        command_id="project-create-alpha", key=" px1 ", name="Alpha"
    )
    definitions = await task_space_fixture.queries.list_definitions(task_space_fixture.scope)

    assert project.value["id"] == _stable_id("project", "project-create-alpha")
    assert project.value["key"] == "PX1"
    assert project.value["next_work_item_number"] == 1
    fetched = await task_space_fixture.queries.get_project(
        task_space_fixture.scope, project.value["id"]
    )
    assert fetched.value == project.value
    assert {row["category"] for row in definitions.statuses} == {
        "not_started", "in_progress", "paused", "waiting", "completed", "cancelled"
    }
    assert sum(bool(row["system"]) for row in definitions.types) == 1


@pytest.mark.asyncio
async def test_invalid_and_duplicate_project_keys_are_stable_rejections(task_space_fixture) -> None:
    await task_space_fixture.create_project(command_id="p-one", key="PX")

    invalid = await task_space_fixture.create_project(command_id="p-bad", key="1bad")
    duplicate = await task_space_fixture.create_project(command_id="p-two", key="px")

    assert isinstance(invalid, TaskSpaceRejected)
    assert isinstance(duplicate, TaskSpaceRejected)
    assert invalid.code == "invalid_project_key"
    assert duplicate.code == "project_key_conflict"


@pytest.mark.asyncio
async def test_work_item_allocation_is_atomic_and_retry_returns_same_key(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="p-alloc", key="TS")
    command = task_space_fixture.create_work_item_command(
        command_id="wi-first", project_id=project.value["id"], title="First"
    )

    first = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    second = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    stored_project = await task_space_fixture.read_project(project.value["id"])
    project_create_events = await task_space_fixture.visible_events(
        operation_id="p-alloc"
    )
    allocation_events = await task_space_fixture.visible_events(
        operation_id="wi-first"
    )

    assert first.value == second.value
    assert isinstance(first, TaskSpaceAccepted)
    assert first.value["display_key"] == "TS-1"
    assert stored_project["next_work_item_number"] == 2
    assert stored_project["version"] == project.value["version"] + 1
    assert stored_project["updated_at"] >= project.value["updated_at"]
    assert len(project_create_events) == 1
    assert project_create_events[0].payload == project.value
    assert {event.entity_type for event in allocation_events} == {
        "project",
        "workItem",
    }
    allocation_by_type = {
        event.entity_type: event.payload for event in allocation_events
    }
    # Project updated_at is server-managed via DB onupdate trigger on UPDATE;
    # compare all semantic fields and verify event timestamp <= DB timestamp.
    assert {
        k: v for k, v in allocation_by_type["project"].items() if k != "updated_at"
    } == {k: v for k, v in stored_project.items() if k != "updated_at"}
    assert allocation_by_type["project"]["updated_at"] <= stored_project["updated_at"]
    assert allocation_by_type["workItem"] == first.value


def test_ts1_consumes_ts0_contracts_without_shadow_types() -> None:
    assert TaskSpaceCommand.__args__
    assert TaskSpaceOutcome.__args__ == (TaskSpaceAccepted, TaskSpaceRejected)
    assert TaskSpaceCommandModule.__module__ == "app.task_space.contracts"
    assert TaskSpaceQueryModule.__module__ == "app.task_space.contracts"
    assert TaskSpacePageQuery.__module__ == "app.task_space.contracts"
    assert {CreateProject, CreateWorkItem, MutateWorkItem, WorkItemNoteCommand} <= set(
        TaskSpaceCommand.__args__
    )
    assert {
        model.__module__
        for model in (StatusDefinition, TypeDefinition, Label, WorkItemLabel)
    } == {"app.models.work_item_definition"}


def test_business_hash_excludes_envelope_but_request_hash_covers_it() -> None:
    business_payload = {
        "title": "Same payload",
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    payload_hash = canonical_payload_hash(business_payload)
    first = CreateWorkItem(
        command_id="create-one",
        space_id="space-one",
        project_id="project-one",
        payload_hash=payload_hash,
        **business_payload,
    )
    second = CreateWorkItem(
        command_id="create-two",
        space_id="space-two",
        project_id="project-two",
        payload_hash=payload_hash,
        **business_payload,
    )

    assert _business_payload(first) == _business_payload(second) == business_payload
    assert build_task_space_request(first).request_hash != build_task_space_request(second).request_hash


def test_typed_requests_keep_the_virtual_task_space_envelope() -> None:
    payload = {"key": "PX", "name": "Project", "description": None}
    command = CreateProject(
        command_id="virtual-project-command",
        space_id="space-a",
        payload_hash=canonical_payload_hash(payload),
        payload=payload,
    )

    request = build_task_space_request(command)

    assert request.entity_type == "task_space"
    assert request.name == "task_space.CreateProject"


def test_project_adapter_normalizes_before_payload_hash(task_space_fixture) -> None:
    command = task_space_fixture.create_project_command(
        command_id="normalized-project",
        key=" px1 ",
        name="Normalized",
    )

    assert command.payload["key"] == "PX1"
    assert command.payload_hash == canonical_payload_hash(command.payload)


def test_move_hash_excludes_project_guard_but_request_hash_covers_it() -> None:
    business_payload = {"new_parent_id": "parent-a", "child_rank": 3}
    payload_hash = canonical_payload_hash(business_payload)

    def command(project_id: str) -> MutateWorkItem:
        return MutateWorkItem(
            command_id="move-hash",
            space_id="space-a",
            work_item_id="work-item-a",
            expected_version=7,
            payload_hash=payload_hash,
            payload={
                "operation": "move",
                "project_id": project_id,
                **business_payload,
            },
        )

    first = command("project-a")
    second = command("project-b")
    first_request = build_task_space_request(first)
    second_request = build_task_space_request(second)

    assert _business_payload(first) == _business_payload(second) == business_payload
    assert first_request.payload["project_id"] == "project-a"
    assert second_request.payload["project_id"] == "project-b"
    assert first_request.request_hash != second_request.request_hash


@pytest.mark.asyncio
async def test_payload_hash_mismatch_rejects_before_uow(task_space_fixture) -> None:
    class NeverCalledUow:
        async def execute(self, *args, **kwargs):
            raise AssertionError("invalid payload hash reached the UoW")

    command = CreateProject(
        command_id="bad-payload-hash",
        space_id=task_space_fixture.scope.scope.space_id,
        payload_hash="0" * 64,
        payload={"key": "PH", "name": "Payload hash", "description": None},
    )
    outcome = await DefaultTaskSpaceCommandModule(NeverCalledUow()).execute(
        task_space_fixture.scope, command
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "invalid_payload_hash"
    assert outcome.retryable is False


def test_task_space_fixture_uses_constructor_policy_injection(
    mutation_fixture_factory,
) -> None:
    parameter = inspect.signature(mutation_fixture_factory).parameters["policies"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    fixture_sources = "\n".join(
        Path(path).read_text(encoding="utf-8")
        for path in ("tests/conftest.py", "tests/task_space_fixture.py")
    )
    assert "mutation_fixture.clock" not in fixture_sources
    assert ".register_domain_policy(" not in fixture_sources
    assert ".with_domain(" not in fixture_sources
    assert "MutationCompiler(" not in fixture_sources
    assert "MutationUnitOfWork(" not in fixture_sources
    assert "tests.test_mutation_recovery" not in fixture_sources

    mutation = mutation_fixture_factory(policies=())
    assert type(mutation).__module__ == "tests.mutation_fixture"
    with pytest.raises(ValueError, match="unknown mutation fixture fault"):
        mutation.inject_fault("unknown")


@pytest.mark.asyncio
async def test_mutation_fixture_snapshot_includes_database_authority(task_space_fixture) -> None:
    before = task_space_fixture.overlay_snapshot()

    await task_space_fixture.create_project(
        command_id="snapshot-project",
        key="SP",
    )

    assert task_space_fixture.overlay_snapshot() != before


@pytest.mark.asyncio
async def test_concrete_modules_are_used_through_ts0_protocols(task_space_fixture) -> None:
    commands: TaskSpaceCommandModule = task_space_fixture.module
    queries: TaskSpaceQueryModule = task_space_fixture.queries
    command = task_space_fixture.create_project_command(
        command_id="protocol-project",
        key="PP",
    )

    created = await commands.execute(task_space_fixture.scope, command)
    fetched = await queries.get_project(task_space_fixture.scope, created.value["id"])
    definitions = await queries.list_definitions(task_space_fixture.scope)
    page = await queries.list_projects(
        task_space_fixture.scope,
        TaskSpacePageQuery(cursor=None, limit=10, filters={}),
    )

    public_writes = {
        name
        for name, member in inspect.getmembers(
            DefaultTaskSpaceCommandModule,
            predicate=inspect.isfunction,
        )
        if not name.startswith("_")
    }
    assert fetched.value == created.value
    assert definitions.statuses
    assert page.items == (created.value,)
    assert public_writes == {"execute"}
