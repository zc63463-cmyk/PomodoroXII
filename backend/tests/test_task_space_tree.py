"""TS1 Task 3: WorkItem allocation, tree moves, formal status, and sync fence."""

from __future__ import annotations

import json

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError
from app.mutation.journal import MutationJournal
from app.mutation.types import MutationState, canonical_payload_hash
from app.task_space.compiler import WORK_ITEM_SYNC_FIELDS, _stable_id
from app.task_space.contracts import TaskSpacePageQuery, TaskSpaceRejected

WORK_ITEM_POST_IMAGE_FIELDS = {
    "id",
    "project_id",
    "display_key",
    "title",
    "description",
    "type_definition_id",
    "status_definition_id",
    "priority",
    "parent_id",
    "child_rank",
    "completion_window_start",
    "completion_window_end",
    "review_point",
    "hard_deadline",
    "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds",
    "effort_actual_seconds",
    "confidence",
    "completed_at",
    "cancelled_at",
    "archived_at",
    "marked_as_attention",
    "created_at",
    "updated_at",
    "version",
}


def test_work_item_sync_candidate_shape_matches_every_ts0_post_image_field() -> None:
    assert WORK_ITEM_SYNC_FIELDS == WORK_ITEM_POST_IMAGE_FIELDS


@pytest.mark.asyncio
async def test_project_counter_allocates_monotonic_display_keys(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="tree-project", key="TREE")
    one = await task_space_fixture.create_work_item(project.value["id"], "Root one", None, "root-one")
    two = await task_space_fixture.create_work_item(project.value["id"], "Root two", None, "root-two")

    assert one.value["display_key"] == "TREE-1"
    assert two.value["display_key"] == "TREE-2"
    assert (await task_space_fixture.read_project(project.value["id"]))["next_work_item_number"] == 3


@pytest.mark.parametrize(
    ("category", "has_completed_at", "has_cancelled_at"),
    (("completed", True, False), ("cancelled", False, True)),
)
@pytest.mark.asyncio
async def test_create_work_item_projects_explicit_terminal_status_timestamp(
    task_space_fixture,
    category: str,
    has_completed_at: bool,
    has_cancelled_at: bool,
) -> None:
    project = await task_space_fixture.create_project(
        command_id=f"terminal-project-{category}", key=f"T{category[0].upper()}"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"],
        f"Initially {category}",
        None,
        f"terminal-item-{category}",
        status_definition_id=task_space_fixture.status_id(category),
    )

    assert (item.value["completed_at"] is not None) is has_completed_at
    assert (item.value["cancelled_at"] is not None) is has_cancelled_at


@pytest.mark.asyncio
async def test_root_child_rank_is_scoped_to_its_project(task_space_fixture) -> None:
    first_project = await task_space_fixture.create_project(
        command_id="rank-project-a", key="RA"
    )
    second_project = await task_space_fixture.create_project(
        command_id="rank-project-b", key="RB"
    )
    first_root = await task_space_fixture.create_work_item(
        first_project.value["id"], "First root", None, "rank-root-a"
    )
    second_root = await task_space_fixture.create_work_item(
        second_project.value["id"], "Second root", None, "rank-root-b"
    )

    assert first_root.value["child_rank"] == second_root.value["child_rank"] == 0


@pytest.mark.asyncio
async def test_same_payload_with_distinct_command_ids_allocates_distinct_work_items(
    task_space_fixture,
) -> None:
    project = await task_space_fixture.create_project(command_id="identity-project", key="IDENT")
    second_command_id = "i" * 128
    first = await task_space_fixture.create_work_item(
        project.value["id"], "Same payload", None, "identity-one"
    )
    second = await task_space_fixture.create_work_item(
        project.value["id"], "Same payload", None, second_command_id
    )

    assert first.value["id"] == _stable_id("work_item", "identity-one")
    assert second.value["id"] == _stable_id("work_item", second_command_id)
    assert first.value["id"] != second.value["id"]
    assert len(first.value["id"]) == len(second.value["id"]) == 32
    assert (first.value["display_key"], second.value["display_key"]) == (
        "IDENT-1",
        "IDENT-2",
    )
    events = await task_space_fixture.visible_events(operation_id=second_command_id)
    work_item_events = [event for event in events if event.entity_type == "workItem"]
    assert len(work_item_events) == 1
    assert work_item_events[0].payload == second.value
    assert set(work_item_events[0].payload) == WORK_ITEM_POST_IMAGE_FIELDS


@pytest.mark.asyncio
async def test_create_and_move_enforce_three_levels_same_project_and_no_cycle(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="tree-a", key="TA")
    other = await task_space_fixture.create_project(command_id="tree-b", key="TB")
    level1 = await task_space_fixture.create_work_item(project.value["id"], "L1", None, "l1")
    level2 = await task_space_fixture.create_work_item(project.value["id"], "L2", level1.value["id"], "l2")
    level3 = await task_space_fixture.create_work_item(project.value["id"], "L3", level2.value["id"], "l3")

    fourth = await task_space_fixture.create_work_item(
        project.value["id"], "L4", level3.value["id"], "l4"
    )
    cross_project = await task_space_fixture.move(
        level2.value["id"], other.value["id"], None, "move-cross"
    )
    cycle = await task_space_fixture.move(
        level1.value["id"], project.value["id"], level3.value["id"], "move-cycle"
    )

    assert isinstance(fourth, TaskSpaceRejected)
    assert isinstance(cross_project, TaskSpaceRejected)
    assert isinstance(cycle, TaskSpaceRejected)
    assert fourth.code == cross_project.code == cycle.code == "invalid_work_item_tree"
    assert await task_space_fixture.visible_events(operation_id="move-cross") == ()
    assert (await task_space_fixture.read_work_item(level2.value["id"]))["project_id"] == project.value["id"]


@pytest.mark.asyncio
async def test_completed_and_cancelled_projection_timestamps_follow_status_category(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("status-item")
    completed = task_space_fixture.status_id("completed")
    active = task_space_fixture.status_id("in_progress")

    done = await task_space_fixture.transition_work_item(
        "status-done", item["id"], item["version"], completed
    )
    reopened = await task_space_fixture.transition_work_item(
        "status-reopen", item["id"], done.value["version"], active
    )

    assert done.value["completed_at"] is not None
    assert done.value["cancelled_at"] is None
    assert reopened.value["completed_at"] is None
    assert reopened.value["cancelled_at"] is None


@pytest.mark.asyncio
async def test_completing_level2_with_active_level3_is_rejected(task_space_fixture) -> None:
    level2 = await task_space_fixture.seed_level2("active-child-parent")
    await task_space_fixture.create_work_item(
        level2["project_id"], "Still active", level2["id"], "active-child"
    )

    outcome = await task_space_fixture.transition_work_item(
        "complete-with-active-child",
        level2["id"],
        level2["version"],
        task_space_fixture.status_id("completed"),
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "active_child_conflict"


@pytest.mark.asyncio
async def test_list_work_items_is_a_stable_flat_project_page(task_space_fixture) -> None:
    tree = await task_space_fixture.seed_out_of_order_tree()
    page = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(None, 100, {"project_id": tree.project_id}),
    )

    assert [row["id"] for row in page.items] == list(tree.ids_in_parent_child_rank_id_order)
    assert page.next_cursor is None

    first = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(None, 2, {"project_id": tree.project_id}),
    )
    second = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(first.next_cursor, 100, {"project_id": tree.project_id}),
    )
    assert first.next_cursor is not None
    assert [row["id"] for row in (*first.items, *second.items)] == list(
        tree.ids_in_parent_child_rank_id_order
    )


@pytest.mark.asyncio
async def test_update_and_detail_query_share_the_same_post_image(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("update-detail")
    updated = await task_space_fixture.update_work_item(
        "update-detail-command",
        item["id"],
        item["version"],
        {"title": "Renamed"},
    )
    fetched = await task_space_fixture.queries.get_work_item(
        task_space_fixture.scope, item["id"]
    )
    events = await task_space_fixture.visible_events(
        operation_id="update-detail-command"
    )

    assert fetched.value == updated.value
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].payload == updated.value
    assert set(events[0].payload) == WORK_ITEM_POST_IMAGE_FIELDS


# -- WorkItem Sync action matrix ---------------------------------------------


@pytest.mark.parametrize("action", ("create", "update", "delete"))
@pytest.mark.asyncio
async def test_sync_work_item_action_matrix_is_policy_owned(
    task_space_fixture,
    monkeypatch,
    action: str,
) -> None:
    item = await task_space_fixture.seed_level2(f"sync-work-item-{action}")
    client_updated_at = task_space_fixture.clock.tick()
    payload = (
        {
            **item,
            "title": "Accepted Sync scalar update",
            "updated_at": client_updated_at,
            "version": int(item["version"]) + 1,
        }
        if action == "update"
        else {}
    )
    entity_id = str(item["id"]) if action != "create" else "offline-work-item"
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=entity_id,
        action=action,
        payload=payload,
        expected_version=None if action == "create" else int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    operation_id = f"sync-work-item-{action}-matrix"
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItem reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    if action == "update":
        result = await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )
        assert result.value["title"] == "Accepted Sync scalar update"
        events = await task_space_fixture.visible_events(operation_id=operation_id)
        assert len(events) == 1
        assert events[0].entity_type == "workItem"
        assert events[0].payload == result.value
    else:
        with pytest.raises(MutationRejectedError) as caught:
            await task_space_fixture.uow.execute(
                task_space_fixture.scope, request, operation_id
            )
        assert caught.value.rejection.code == "offline_formal_creation_forbidden"
        assert task_space_fixture.overlay_snapshot() == before
        assert await task_space_fixture.visible_events(operation_id=operation_id) == ()


# -- WorkItem Sync server-managed tamper matrix ------------------------------


@pytest.mark.parametrize(
    ("field", "replacement"),
    (
        ("display_key", "FORGED-99"),
        ("created_at", "2025-01-01T00:00:00.000Z"),
        ("updated_at", "2025-01-01T00:00:00.000Z"),
        ("effort_actual_seconds", 999),
        ("completed_at", "2025-01-01T00:00:00.000Z"),
        ("version", 999),
    ),
)
@pytest.mark.asyncio
async def test_sync_work_item_server_managed_tamper_is_zero_effect(
    task_space_fixture,
    monkeypatch,
    field: str,
    replacement,
) -> None:
    item = await task_space_fixture.seed_level2(f"sync-tamper-{field}")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "title": f"Accepted scalar shape for {field}",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
        field: replacement,
    }
    operation_id = f"sync-tamper-{field}"
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItem reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )

    assert caught.value.rejection.code == "work_item_structure_changed"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id=operation_id) == ()


# -- WorkItem Sync cross-project and depth rejection -------------------------


@pytest.mark.asyncio
async def test_sync_work_item_cross_project_move_is_rejected(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("sync-cross-project")
    other_project = await task_space_fixture.create_project(
        command_id="sync-other-project", key="SCP"
    )
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "project_id": other_project.value["id"],
        "parent_id": None,
        "child_rank": 0,
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-cross-project-move"
        )

    assert caught.value.rejection.code == "invalid_work_item_tree"
    assert task_space_fixture.overlay_snapshot() == before


@pytest.mark.asyncio
async def test_sync_work_item_fourth_level_move_is_rejected(task_space_fixture) -> None:
    level3 = await task_space_fixture.seed_level3("sync-fourth-level")
    root = await task_space_fixture.create_work_item(
        str(level3["project_id"]), "Movable root", None, "sync-fourth-root"
    )
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **root.value,
        "parent_id": str(level3["id"]),
        "child_rank": 0,
        "updated_at": client_updated_at,
        "version": int(root.value["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(root.value["id"]),
        action="update",
        payload=candidate,
        expected_version=int(root.value["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-fourth-level-move"
        )

    assert caught.value.rejection.code == "invalid_work_item_tree"
    assert task_space_fixture.overlay_snapshot() == before


@pytest.mark.asyncio
async def test_sync_work_item_move_plus_status_is_rejected(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("sync-move-status")
    completed_id = task_space_fixture.status_id("completed")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "parent_id": None,
        "child_rank": 0,
        "status_definition_id": completed_id,
        "completed_at": client_updated_at,
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-move-status"
        )

    assert caught.value.rejection.code == "work_item_structure_changed"
    assert task_space_fixture.overlay_snapshot() == before


# -- WorkItem Sync accepted move and transition ------------------------------


@pytest.mark.asyncio
async def test_sync_work_item_accepted_move_matches_typed_post_image(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("sync-accepted-move")
    project_id = str(item["project_id"])
    new_parent = await task_space_fixture.create_work_item(
        project_id, "New parent", None, "sync-move-new-parent"
    )
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "parent_id": str(new_parent.value["id"]),
        "child_rank": 1,
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "sync-accepted-move"
    )

    assert result.value["parent_id"] == str(new_parent.value["id"])
    assert result.value["child_rank"] == 1
    assert result.value["version"] == int(item["version"]) + 1
    events = await task_space_fixture.visible_events(operation_id="sync-accepted-move")
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].payload == result.value
    assert set(events[0].payload) == WORK_ITEM_POST_IMAGE_FIELDS


@pytest.mark.asyncio
async def test_sync_work_item_accepted_transition_matches_typed_post_image(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("sync-accepted-transition")
    completed_id = task_space_fixture.status_id("completed")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "status_definition_id": completed_id,
        "completed_at": client_updated_at,
        "cancelled_at": None,
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "sync-accepted-transition"
    )

    assert result.value["status_definition_id"] == completed_id
    assert result.value["completed_at"] is not None
    assert result.value["cancelled_at"] is None
    assert result.value["version"] == int(item["version"]) + 1
    events = await task_space_fixture.visible_events(operation_id="sync-accepted-transition")
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].payload == result.value


# -- WorkItem Sync version and client_updated_at validation ------------------


@pytest.mark.asyncio
async def test_sync_work_item_wrong_version_is_rejected(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("sync-wrong-version")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "title": "Wrong version",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 2,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-wrong-version"
        )

    assert caught.value.rejection.code == "work_item_structure_changed"


@pytest.mark.asyncio
async def test_sync_work_item_updated_at_not_client_timestamp_is_rejected(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("sync-bad-timestamp")
    client_updated_at = task_space_fixture.clock.tick()
    wrong_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "title": "Bad timestamp",
        "updated_at": wrong_updated_at,
        "version": int(item["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-bad-timestamp"
        )

    assert caught.value.rejection.code == "work_item_structure_changed"


# -- Session envelope fence for TransitionWorkItem ---------------------------


async def _seed_envelope(
    fixture,
    *,
    command_id: str,
    work_item_id: str,
    expected_version: int,
    target_transition: str,
    payload_hash: str,
) -> None:
    from app.models.session_command import SessionCommandEnvelope

    async with fixture.scope.session_factory() as session:
        session.add(
            SessionCommandEnvelope(
                command_id=command_id,
                space_id=fixture.space_id,
                session_id="00000000-0000-0000-0000-000000000000",
                session_revision=1,
                work_item_id=work_item_id,
                expected_version=expected_version,
                target_transition=target_transition,
                replay_safe=True,
                payload_hash=payload_hash,
                created_at=fixture.clock.now_iso_ms(),
            )
        )
        await session.commit()


async def _seed_receipt(
    fixture,
    *,
    command_id: str,
    state: str,
    result_json: str | None = None,
) -> None:
    from app.models.session_command import SessionCommandReceipt

    async with fixture.scope.session_factory() as session:
        session.add(
            SessionCommandReceipt(
                command_id=command_id,
                state=state,
                error_code=None,
                retryable=False,
                details_json=None,
                result_json=result_json,
                updated_at=fixture.clock.now_iso_ms(),
            )
        )
        await session.commit()


async def _assert_durable_rejection(
    fixture, *, operation_id: str, code: str
) -> None:
    batch = await MutationJournal(fixture.scope.session_factory).find_batch(operation_id)
    assert batch is not None
    assert batch.state is MutationState.ABORTED
    assert len(batch.result.rejected) == 1
    rejection = batch.result.rejected[0]
    assert rejection.operation_id == operation_id
    assert rejection.code == code
    assert await fixture.visible_events(operation_id=operation_id) == ()


def _transition_payload_hash(fixture, status_category: str) -> str:
    return canonical_payload_hash(
        {"status_definition_id": fixture.status_id(status_category)}
    )


@pytest.mark.asyncio
async def test_transition_without_envelope_succeeds(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-no-envelope")
    completed = task_space_fixture.status_id("completed")

    outcome = await task_space_fixture.transition_work_item(
        "fence-no-envelope-cmd", item["id"], item["version"], completed
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    assert outcome.value["status_definition_id"] == completed


@pytest.mark.asyncio
async def test_transition_with_exact_replay_claimed_succeeds(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-claimed")
    completed = task_space_fixture.status_id("completed")
    command_id = "fence-claimed-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")

    await _seed_envelope(
        task_space_fixture,
        command_id=command_id,
        work_item_id=item["id"],
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=command_id,
        state="pending",
        result_json=json.dumps(
            {
                "_reconcileCoordination": {
                    "kind": "replay_claimed",
                    "rootCommandId": "session-reconcile-root",
                }
            }
        ),
    )

    outcome = await task_space_fixture.transition_work_item(
        command_id, item["id"], item["version"], completed
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    assert outcome.value["status_definition_id"] == completed


@pytest.mark.asyncio
async def test_sync_transition_cannot_bypass_abandoned_session_envelope(
    task_space_fixture,
) -> None:
    item = await task_space_fixture.seed_level2("fence-sync-abandoned")
    completed = task_space_fixture.status_id("completed")
    operation_id = "fence-sync-abandoned-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")
    await _seed_envelope(
        task_space_fixture,
        command_id=operation_id,
        work_item_id=item["id"],
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=operation_id,
        state="abandoned",
    )
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "status_definition_id": completed,
        "completed_at": client_updated_at,
        "cancelled_at": None,
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope,
        task_space_fixture.sync_event(
            entity_type="workItem",
            entity_id=str(item["id"]),
            action="update",
            payload=candidate,
            expected_version=int(item["version"]),
            client_updated_at=client_updated_at,
        ),
    )
    before = task_space_fixture.overlay_snapshot()

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )

    assert caught.value.rejection.code == "idempotency_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    await _assert_durable_rejection(
        task_space_fixture, operation_id=operation_id, code="idempotency_conflict"
    )


@pytest.mark.asyncio
async def test_transition_with_pending_unclaimed_receipt_rejects(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-unclaimed")
    completed = task_space_fixture.status_id("completed")
    command_id = "fence-unclaimed-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")

    await _seed_envelope(
        task_space_fixture,
        command_id=command_id,
        work_item_id=item["id"],
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=command_id,
        state="pending",
        result_json=None,
    )

    before = task_space_fixture.overlay_snapshot()
    outcome = await task_space_fixture.transition_work_item(
        command_id, item["id"], item["version"], completed
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "idempotency_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    await _assert_durable_rejection(
        task_space_fixture, operation_id=command_id, code="idempotency_conflict"
    )


@pytest.mark.asyncio
async def test_transition_with_replay_finished_unknown_rejects(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-finished-unknown")
    completed = task_space_fixture.status_id("completed")
    command_id = "fence-finished-unknown-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")

    await _seed_envelope(
        task_space_fixture,
        command_id=command_id,
        work_item_id=item["id"],
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=command_id,
        state="unknown",
        result_json=json.dumps(
            {
                "_reconcileCoordination": {
                    "kind": "replay_finished_unknown",
                    "rootCommandId": command_id,
                }
            }
        ),
    )

    before = task_space_fixture.overlay_snapshot()
    outcome = await task_space_fixture.transition_work_item(
        command_id, item["id"], item["version"], completed
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "idempotency_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    await _assert_durable_rejection(
        task_space_fixture, operation_id=command_id, code="idempotency_conflict"
    )


@pytest.mark.asyncio
async def test_transition_with_abandoned_receipt_rejects(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-abandoned")
    completed = task_space_fixture.status_id("completed")
    command_id = "fence-abandoned-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")

    await _seed_envelope(
        task_space_fixture,
        command_id=command_id,
        work_item_id=item["id"],
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=command_id,
        state="abandoned",
        result_json=None,
    )

    before = task_space_fixture.overlay_snapshot()
    outcome = await task_space_fixture.transition_work_item(
        command_id, item["id"], item["version"], completed
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "idempotency_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    await _assert_durable_rejection(
        task_space_fixture, operation_id=command_id, code="idempotency_conflict"
    )


@pytest.mark.asyncio
async def test_transition_with_malformed_coordination_rejects(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-malformed")
    completed = task_space_fixture.status_id("completed")
    command_id = "fence-malformed-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")

    await _seed_envelope(
        task_space_fixture,
        command_id=command_id,
        work_item_id=item["id"],
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=command_id,
        state="pending",
        result_json=json.dumps(
            {
                "_reconcileCoordination": {
                    "kind": "bad_kind",
                    "rootCommandId": command_id,
                }
            }
        ),
    )

    before = task_space_fixture.overlay_snapshot()
    outcome = await task_space_fixture.transition_work_item(
        command_id, item["id"], item["version"], completed
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "idempotency_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    await _assert_durable_rejection(
        task_space_fixture, operation_id=command_id, code="idempotency_conflict"
    )


@pytest.mark.asyncio
async def test_transition_with_identity_mismatch_rejects(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("fence-mismatch")
    completed = task_space_fixture.status_id("completed")
    command_id = "fence-mismatch-cmd"
    payload_hash = _transition_payload_hash(task_space_fixture, "completed")

    await _seed_envelope(
        task_space_fixture,
        command_id=command_id,
        work_item_id="00000000-0000-0000-0000-000000000001",
        expected_version=item["version"],
        target_transition="complete",
        payload_hash=payload_hash,
    )
    await _seed_receipt(
        task_space_fixture,
        command_id=command_id,
        state="pending",
        result_json=json.dumps(
            {
                "_reconcileCoordination": {
                    "kind": "replay_claimed",
                    "rootCommandId": command_id,
                }
            }
        ),
    )

    before = task_space_fixture.overlay_snapshot()
    outcome = await task_space_fixture.transition_work_item(
        command_id, item["id"], item["version"], completed
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "idempotency_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    await _assert_durable_rejection(
        task_space_fixture, operation_id=command_id, code="idempotency_conflict"
    )
