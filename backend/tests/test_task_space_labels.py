"""D5 Decision Y: label definitions and work-item label junctions.

Scenario coverage (TDD spec for the labels family):
- Label definition CRUD (CreateLabel / UpdateLabel / ArchiveLabel) compiles
  typed ``task_space.*`` commands into generic ``label`` sync events.
- AddWorkItemLabels / RemoveWorkItemLabels compile junction mutations plus one
  workItem post-image carrying the sorted ``label_ids`` projection inside a
  single mutation command, while ``work_items`` rows stay label-free.
- Idempotent set semantics with work_item CAS: a stale expected_version is
  never silently merged (``version_conflict``); a retry with the target
  union converges to the server-authoritative joined set.
- Sync replay of the labels family diffs the junction table and adopts the
  work_item candidate verbatim (without the label_ids column).
- Query projections expose ``labelIds`` on work item reads and lists.
- Composite-primary-key mutation plans survive restart (no row collapse).
"""

from __future__ import annotations

from dataclasses import fields
from typing import get_type_hints

import pytest

from app.mutation.types import canonical_payload_hash
from app.task_space.compiler import _stable_id
from app.task_space.contracts import (
    LabelCommand,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpacePageQuery,
    TaskSpaceRejected,
)


def label_command(
    *,
    space_id: str,
    operation: str,
    command_id: str,
    name: str | None = None,
    color: str | None = None,
    label_id: str | None = None,
    expected_version: int | None = None,
) -> LabelCommand:
    payload: dict[str, object] = {}
    if operation == "create":
        payload = {"name": name, "color": color}
    elif operation == "update":
        if name is not None:
            payload["name"] = name
        if color is not None:
            payload["color"] = color
    return LabelCommand(
        operation=operation,
        command_id=command_id,
        space_id=space_id,
        label_id=label_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(payload),
        payload=payload,
    )


def add_labels_command(
    *,
    space_id: str,
    command_id: str,
    work_item_id: str,
    expected_version: int,
    label_ids: list[str],
) -> MutateWorkItem:
    business = {"label_ids": sorted(label_ids)}
    return MutateWorkItem(
        command_id=command_id,
        space_id=space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": "add_labels", **business},
    )


def remove_labels_command(
    *,
    space_id: str,
    command_id: str,
    work_item_id: str,
    expected_version: int,
    label_ids: list[str],
) -> MutateWorkItem:
    business = {"label_ids": sorted(label_ids)}
    return MutateWorkItem(
        command_id=command_id,
        space_id=space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": "remove_labels", **business},
    )


async def create_label(fixture, *, command_id: str, name: str, color: str | None = None):
    command = label_command(
        space_id=fixture.space_id,
        operation="create",
        command_id=command_id,
        name=name,
        color=color,
    )
    return await fixture.module.execute(fixture.scope, command)


# --------------------------------------------------------------------------- #
# Label definition CRUD
# --------------------------------------------------------------------------- #


def test_label_command_carries_operation_identity_and_cas() -> None:
    assert {field.name for field in fields(LabelCommand)} == {
        "operation",
        "command_id",
        "space_id",
        "label_id",
        "expected_version",
        "payload_hash",
        "payload",
    }
    assert get_type_hints(LabelCommand)["expected_version"] == int | None


@pytest.mark.asyncio
async def test_create_label_persists_definition_and_label_event(task_space_fixture) -> None:
    outcome = await create_label(
        task_space_fixture, command_id="label-create-1", name="Focused", color="#ff0000"
    )

    assert isinstance(outcome, TaskSpaceAccepted)
    assert outcome.entity_type == "label"
    assert outcome.entity_id == _stable_id("label", "label-create-1")
    assert outcome.value["name"] == "Focused"
    assert outcome.value["color"] == "#ff0000"
    assert outcome.value["archived_at"] is None
    events = await task_space_fixture.visible_events(operation_id="label-create-1")
    assert len(events) == 1
    assert events[0].entity_type == "label"
    assert events[0].action == "create"
    assert events[0].payload["name"] == "Focused"
    assert events[0].payload["color"] == "#ff0000"


@pytest.mark.asyncio
async def test_create_label_rejects_duplicate_name(task_space_fixture) -> None:
    await create_label(task_space_fixture, command_id="label-create-a", name="Focus")

    duplicate = await create_label(
        task_space_fixture, command_id="label-create-b", name="Focus"
    )

    assert isinstance(duplicate, TaskSpaceRejected)
    assert duplicate.code == "label_name_conflict"
    assert duplicate.retryable is False


@pytest.mark.asyncio
async def test_update_label_bumps_version_and_emits_update_event(task_space_fixture) -> None:
    created = await create_label(
        task_space_fixture, command_id="label-upd-1", name="Old", color="#000000"
    )
    label_id = created.entity_id
    updated = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        label_command(
            space_id=task_space_fixture.space_id,
            operation="update",
            command_id="label-upd-2",
            label_id=label_id,
            expected_version=int(created.value["version"]),
            name="New",
        ),
    )

    assert isinstance(updated, TaskSpaceAccepted)
    assert updated.value["name"] == "New"
    assert updated.value["version"] == int(created.value["version"]) + 1
    events = await task_space_fixture.visible_events(operation_id="label-upd-2")
    assert len(events) == 1
    assert events[0].action == "update"
    assert events[0].payload["name"] == "New"


@pytest.mark.asyncio
async def test_archive_label_sets_archived_at_and_keeps_junction(task_space_fixture) -> None:
    created = await create_label(task_space_fixture, command_id="label-arc-1", name="Keep")
    label_id = created.entity_id
    project = await task_space_fixture.create_project(
        command_id="label-arc-proj", key="LK"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-arc-item"
    )
    await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-arc-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_id],
        ),
    )

    archived = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        label_command(
            space_id=task_space_fixture.space_id,
            operation="archive",
            command_id="label-arc-do",
            label_id=label_id,
            expected_version=int(created.value["version"]),
        ),
    )

    assert isinstance(archived, TaskSpaceAccepted)
    assert archived.value["archived_at"] is not None
    assert archived.value["version"] == int(created.value["version"]) + 1
    # Junction rows are preserved; archiving a definition never hard-deletes
    # and never bumps the work_item version.
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == [label_id]
    assert read["version"] == 2
    events = await task_space_fixture.visible_events(operation_id="label-arc-do")
    assert len(events) == 1
    assert events[0].action == "update"
    assert events[0].payload["archived_at"] is not None


# --------------------------------------------------------------------------- #
# Add / Remove labels (junction + workItem post-image projection)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_add_labels_is_one_atomic_command_with_projected_ids(task_space_fixture) -> None:
    label = await create_label(task_space_fixture, command_id="label-add-1", name="Focus")
    project = await task_space_fixture.create_project(
        command_id="label-add-proj", key="AD"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-add-item"
    )
    before = item.value["version"]

    outcome = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-add-do",
            work_item_id=item.value["id"],
            expected_version=before,
            label_ids=[label.entity_id],
        ),
    )

    assert isinstance(outcome, TaskSpaceAccepted)
    assert outcome.entity_type == "work_item"
    assert outcome.value["version"] == before + 1
    events = await task_space_fixture.visible_events(operation_id="label-add-do")
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].action == "update"
    assert events[0].payload["label_ids"] == [label.entity_id]
    # The work_item sync event is a full post-image: it still carries the
    # whole work_item row plus the projection, without a label_ids column.
    assert events[0].payload["title"] == "Item"
    assert set(events[0].payload) >= {
        "id", "project_id", "title", "label_ids", "version", "updated_at",
    }


@pytest.mark.asyncio
async def test_add_labels_is_idempotent_noop_on_unchanged_set(task_space_fixture) -> None:
    label = await create_label(task_space_fixture, command_id="label-idem-1", name="Idem")
    project = await task_space_fixture.create_project(
        command_id="label-idem-proj", key="ID"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-idem-item"
    )
    await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-idem-a",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label.entity_id],
        ),
    )
    current = await task_space_fixture.read_work_item(item.value["id"])

    again = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-idem-b",
            work_item_id=item.value["id"],
            expected_version=int(current["version"]),
            label_ids=[label.entity_id],
        ),
    )

    assert isinstance(again, TaskSpaceAccepted)
    # Idempotent set semantics: no version bump, no visible event, single row.
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["version"] == current["version"]
    assert await task_space_fixture.visible_events(operation_id="label-idem-b") == ()


@pytest.mark.asyncio
async def test_add_labels_requires_existing_label_definition(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(
        command_id="label-miss-proj", key="MS"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-miss-item"
    )

    outcome = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-miss-do",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=["label-does-not-exist"],
        ),
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "not_found"
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["version"] == int(item.value["version"])


@pytest.mark.asyncio
async def test_remove_labels_deletes_junction_row_and_updates_projection(task_space_fixture) -> None:
    label_a = await create_label(task_space_fixture, command_id="label-rm-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-rm-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-rm-proj", key="RM"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-rm-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-rm-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )

    removed = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-rm-do",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )

    assert isinstance(removed, TaskSpaceAccepted)
    assert removed.entity_type == "work_item"
    assert removed.value["version"] == int(added.value["version"]) + 1
    events = await task_space_fixture.visible_events(operation_id="label-rm-do")
    assert len(events) == 1
    assert events[0].payload["label_ids"] == [label_b.entity_id]
    # Remove of an absent label is a no-op at the set level: removing A again
    # keeps the same version and emits no event.
    again = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-rm-noop",
            work_item_id=item.value["id"],
            expected_version=int(removed.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )
    assert isinstance(again, TaskSpaceAccepted)
    assert again.value["version"] == int(removed.value["version"])
    assert await task_space_fixture.visible_events(operation_id="label-rm-noop") == ()


@pytest.mark.asyncio
async def test_stale_expected_version_is_never_silently_merged_and_retry_converges(
    task_space_fixture,
) -> None:
    label_a = await create_label(task_space_fixture, command_id="label-cv-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-cv-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-cv-proj", key="CV"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-cv-item"
    )
    # Device A adds label A targeting {A}.
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-cv-a-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )
    # Device B, running on an older snapshot, also adds label B with a stale
    # expected_version: it must fail decisively, not silently overwrite.
    stale = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-cv-b-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_b.entity_id],
        ),
    )
    assert isinstance(stale, TaskSpaceRejected)
    assert stale.code == "version_conflict"
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == [label_a.entity_id]

    # Device B refreshes and re-targets the union {A, B}: the server
    # read-modify-write converges to the joined set with no coverage loss.
    converged = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-cv-b-retry",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    assert isinstance(converged, TaskSpaceAccepted)
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == sorted([label_a.entity_id, label_b.entity_id])


@pytest.mark.asyncio
async def test_junction_rows_survive_restart_without_collapse(task_space_fixture) -> None:
    label_a = await create_label(task_space_fixture, command_id="label-rs-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-rs-b", name="B")
    label_c = await create_label(task_space_fixture, command_id="label-rs-c", name="C")
    project = await task_space_fixture.create_project(
        command_id="label-rs-proj", key="RS"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-rs-item"
    )
    for command_id, label_id in (
        ("label-rs-add-a", label_a.entity_id),
        ("label-rs-add-b", label_b.entity_id),
    ):
        current = await task_space_fixture.read_work_item(item.value["id"])
        await task_space_fixture.module.execute(
            task_space_fixture.scope,
            add_labels_command(
                space_id=task_space_fixture.space_id,
                command_id=command_id,
                work_item_id=item.value["id"],
                expected_version=int(current["version"]),
                label_ids=[label_id],
            ),
        )
    await task_space_fixture.restart()
    current = await task_space_fixture.read_work_item(item.value["id"])
    assert current["label_ids"] == sorted([label_a.entity_id, label_b.entity_id])

    # A third device targets the exact union: delta-diff replay must NOT
    # re-insert rows that already exist (which happens if the freshly loaded
    # authority overlay collapses rows with the same work_item_id).
    outcome = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-rs-add-c",
            work_item_id=item.value["id"],
            expected_version=int(current["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id, label_c.entity_id],
        ),
    )
    assert isinstance(outcome, TaskSpaceAccepted)
    snapshot = task_space_fixture.overlay_snapshot()
    junction_rows = dict(snapshot[0]).get("work_item_label", ())
    assert len({tuple(row) for row in junction_rows}) == 3


# --------------------------------------------------------------------------- #
# Sync replay — labels family
# --------------------------------------------------------------------------- #


def _full_work_item_post_image(row: dict[str, object]) -> dict[str, object]:
    """Derive the deterministic sync candidate from a committed query row."""
    candidate = {
        key: value
        for key, value in row.items()
        if key in {
            "id", "project_id", "display_key", "title", "description",
            "type_definition_id", "status_definition_id", "priority",
            "parent_id", "child_rank", "completion_window_start",
            "completion_window_end", "review_point", "hard_deadline",
            "effort_estimate_lower_seconds", "effort_estimate_upper_seconds",
            "effort_actual_seconds", "confidence", "completed_at",
            "cancelled_at", "archived_at", "marked_as_attention",
            "created_at", "updated_at", "version", "label_ids",
        }
    }
    if "label_ids" not in candidate:
        candidate["label_ids"] = []
    return candidate


@pytest.mark.asyncio
async def test_sync_labels_family_replay_diffs_junction_and_adopts_candidate(
    task_space_fixture,
) -> None:
    label_a = await create_label(task_space_fixture, command_id="label-sr-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-sr-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-sr-proj", key="SR"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-sr-item"
    )
    row = await task_space_fixture.read_work_item(item.value["id"])
    candidate = _full_work_item_post_image(row)
    candidate["label_ids"] = sorted([label_a.entity_id, label_b.entity_id])
    candidate["version"] = int(row["version"]) + 1
    candidate["updated_at"] = task_space_fixture.clock.tick()

    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=item.value["id"],
        action="update",
        payload=candidate,
        expected_version=int(row["version"]),
        client_updated_at=candidate["updated_at"],
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "sync-label-replay"
    )

    assert tuple(result.value["label_ids"]) == tuple(
        sorted([label_a.entity_id, label_b.entity_id])
    )
    replayed_events = await task_space_fixture.visible_events(
        operation_id="sync-label-replay"
    )
    assert len(replayed_events) == 1
    assert replayed_events[0].entity_type == "workItem"
    assert replayed_events[0].payload["label_ids"] == sorted([
        label_a.entity_id, label_b.entity_id,
    ])
    # Replay again with a label removed: junction row disappears.
    candidate["version"] = int(candidate["version"]) + 1
    candidate["updated_at"] = task_space_fixture.clock.tick()
    candidate["label_ids"] = [label_a.entity_id]
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=item.value["id"],
        action="update",
        payload=candidate,
        expected_version=int(candidate["version"]) - 1,
        client_updated_at=candidate["updated_at"],
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    second = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "sync-label-replay-2"
    )
    assert tuple(second.value["label_ids"]) == tuple([label_a.entity_id])
    snapshot = task_space_fixture.overlay_snapshot()
    junction_rows = dict(snapshot[0]).get("work_item_label", ())
    assert len({tuple(row) for row in junction_rows}) == 1


@pytest.mark.asyncio
async def test_sync_labels_family_fails_closed_without_label_ids(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(
        command_id="label-fc-proj", key="FC"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-fc-item"
    )
    row = await task_space_fixture.read_work_item(item.value["id"])
    candidate = _full_work_item_post_image(row)
    candidate.pop("label_ids")
    candidate["version"] = int(row["version"]) + 1
    candidate["updated_at"] = task_space_fixture.clock.tick()

    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=item.value["id"],
        action="update",
        payload=candidate,
        expected_version=int(row["version"]),
        client_updated_at=candidate["updated_at"],
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    from app.errors import MutationRejectedError

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-label-fc"
        )
    assert caught.value.rejection.code == "work_item_structure_changed"
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["version"] == int(row["version"])


@pytest.mark.asyncio
async def test_sync_labels_family_requires_single_operation_family(task_space_fixture) -> None:
    label = await create_label(task_space_fixture, command_id="label-sf-a", name="A")
    project = await task_space_fixture.create_project(
        command_id="label-sf-proj", key="SF"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-sf-item"
    )
    row = await task_space_fixture.read_work_item(item.value["id"])
    candidate = _full_work_item_post_image(row)
    candidate["label_ids"] = [label.entity_id]
    candidate["title"] = "Renamed"
    candidate["version"] = int(row["version"]) + 1
    candidate["updated_at"] = task_space_fixture.clock.tick()

    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=item.value["id"],
        action="update",
        payload=candidate,
        expected_version=int(row["version"]),
        client_updated_at=candidate["updated_at"],
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    from app.errors import MutationRejectedError

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-label-sf"
        )
    assert caught.value.rejection.code == "work_item_structure_changed"


# --------------------------------------------------------------------------- #
# Query projections
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_queries_project_label_ids_on_work_item_reads(task_space_fixture) -> None:
    label = await create_label(task_space_fixture, command_id="label-qp-a", name="Query")
    project = await task_space_fixture.create_project(
        command_id="label-qp-proj", key="QP"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-qp-item"
    )
    await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-qp-do",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label.entity_id],
        ),
    )

    single = await task_space_fixture.queries.get_work_item(
        task_space_fixture.scope, item.value["id"]
    )
    assert single.value["label_ids"] == [label.entity_id]
    page = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(cursor=None, limit=10, filters={}),
    )
    assert page.items[0]["label_ids"] == [label.entity_id]
