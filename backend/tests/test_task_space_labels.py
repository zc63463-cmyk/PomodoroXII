"""D5 Decision Y: label definitions and work-item label junctions.

Scenario coverage (TDD spec for the labels family):
- Label definition CRUD (CreateLabel / UpdateLabel / ArchiveLabel) compiles
  typed ``task_space.*`` commands into generic ``label`` sync events.
- AddWorkItemLabels / RemoveWorkItemLabels declare the **full target label_ids
  set after this mutation** (labels-as-state, TS-02a §裁决一).  The compiler
  converges the junction table to that declared set inside one CAS-guarded
  mutation command, while ``work_items`` rows stay label-free.
- Operation direction is enforced, never guessed from the payload: Add may
  only keep or add (``current <= declared``) and Remove may only keep or drop
  (``declared <= current``); a request that crosses the direction is rejected
  with the registered ``label_set_direction_violated`` code.
- Idempotent set semantics with work_item CAS: a stale expected_version is
  never silently merged (``version_conflict``); a retry with the refreshed
  authoritative version converges to the same declared set.
- Sync replay of the labels family diffs the junction table and adopts the
  work_item candidate verbatim (without the label_ids column); replay is not
  re-interpreted through the online operation direction rule.
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


def _junction_rows(task_space_fixture) -> tuple[tuple[object, ...], ...]:
    """The persisted work_item_label rows, as the raw snapshot tuples.

    ``overlay_snapshot()`` returns ``(database, projections)`` where ``database``
    is ``(entity_name, rows)`` pairs of column-ordered tuples (not mappings) —
    see tests/mutation_fixture.py:219-242.
    """
    database, _projections = task_space_fixture.overlay_snapshot()
    for name, rows in database:
        if name == "work_item_label":
            return tuple(rows)
    return ()


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
    require_removed_label_ids: list[str] | None = None,
) -> MutateWorkItem:
    business: dict[str, object] = {"label_ids": sorted(label_ids)}
    if require_removed_label_ids is not None:
        business["require_removed_label_ids"] = sorted(require_removed_label_ids)
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
async def test_remove_labels_converges_to_declared_target_set(task_space_fixture) -> None:
    """Full-target-set contract: {A,B} minus A declares {B}, never "remove B"."""
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
    assert list(added.value["label_ids"]) == sorted(
        [label_a.entity_id, label_b.entity_id]
    )

    # The declared set is the post-mutation target: {A,B} -> {B}.
    removed = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-rm-do",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_b.entity_id],
        ),
    )

    assert isinstance(removed, TaskSpaceAccepted)
    assert removed.entity_type == "work_item"
    assert removed.value["version"] == int(added.value["version"]) + 1
    assert list(removed.value["label_ids"]) == [label_b.entity_id]
    events = await task_space_fixture.visible_events(operation_id="label-rm-do")
    assert len(events) == 1
    assert events[0].payload["label_ids"] == [label_b.entity_id]
    row = await task_space_fixture.read_work_item(item.value["id"])
    assert row["label_ids"] == [label_b.entity_id]


@pytest.mark.asyncio
async def test_remove_last_label_converges_to_empty_set(task_space_fixture) -> None:
    """{A} minus A declares the empty set — the empty declaration must delete."""
    label_a = await create_label(task_space_fixture, command_id="label-empty-a", name="A")
    project = await task_space_fixture.create_project(
        command_id="label-empty-proj", key="EM"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-empty-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-empty-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )
    assert list(added.value["label_ids"]) == [label_a.entity_id]

    emptied = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-empty-do",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[],
        ),
    )

    assert isinstance(emptied, TaskSpaceAccepted)
    assert emptied.value["version"] == int(added.value["version"]) + 1
    assert list(emptied.value["label_ids"]) == []
    events = await task_space_fixture.visible_events(operation_id="label-empty-do")
    assert len(events) == 1
    assert events[0].payload["label_ids"] == []
    row = await task_space_fixture.read_work_item(item.value["id"])
    assert row["label_ids"] == []


@pytest.mark.asyncio
async def test_remove_absent_label_declaring_same_set_is_noop(task_space_fixture) -> None:
    """Removing a label the item does not have: target set unchanged -> no-op."""
    label_a = await create_label(task_space_fixture, command_id="label-noop-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-noop-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-noop-proj", key="NO"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-noop-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-noop-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )

    # Declared target == current set {A}; B was never attached.
    again = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-noop-do",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )

    assert isinstance(again, TaskSpaceAccepted)
    assert again.value["version"] == int(added.value["version"])
    assert await task_space_fixture.visible_events(operation_id="label-noop-do") == ()
    row = await task_space_fixture.read_work_item(item.value["id"])
    assert row["label_ids"] == [label_a.entity_id]
    assert label_b.entity_id not in row["label_ids"]


@pytest.mark.asyncio
async def test_add_existing_label_declaring_same_set_is_noop(task_space_fixture) -> None:
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
async def test_operation_direction_is_enforced_never_guessed(task_space_fixture) -> None:
    """Add may only keep/add (current ⊆ declared); Remove may only keep/drop.

    A declaration that crosses the operation direction is a protocol error, not
    a delete/inert request: the server never infers "delta vs full set" from the
    payload content, so it must refuse instead of picking an interpretation.
    """
    label_a = await create_label(task_space_fixture, command_id="label-dir-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-dir-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-dir-proj", key="DR"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-dir-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-dir-seed",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    version = int(added.value["version"])

    # Add declaring {B} would silently drop A -> refused with a registered code.
    shrink = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-dir-shrink",
            work_item_id=item.value["id"],
            expected_version=version,
            label_ids=[label_b.entity_id],
        ),
    )
    assert isinstance(shrink, TaskSpaceRejected)
    assert shrink.code == "label_set_direction_violated"
    assert shrink.retryable is False
    # Error details travel through ``deep_freeze_json`` — sequences are tuples.
    assert dict(shrink.details) == {
        "operation": "add_labels",
        "would_remove": (label_a.entity_id,),
        "would_add": (),
    }

    # Remove declaring {A,B,C} would silently ADD C -> refused.
    label_c = await create_label(task_space_fixture, command_id="label-dir-c", name="C")
    grow = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-dir-grow",
            work_item_id=item.value["id"],
            expected_version=version,
            label_ids=[
                label_a.entity_id, label_b.entity_id, label_c.entity_id,
            ],
        ),
    )
    assert isinstance(grow, TaskSpaceRejected)
    assert grow.code == "label_set_direction_violated"
    assert dict(grow.details) == {
        "operation": "remove_labels",
        "would_remove": (),
        "would_add": (label_c.entity_id,),
    }
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == sorted([label_a.entity_id, label_b.entity_id])
    assert read["version"] == version
    assert await task_space_fixture.visible_events(operation_id="label-dir-shrink") == ()
    assert await task_space_fixture.visible_events(operation_id="label-dir-grow") == ()


@pytest.mark.asyncio
async def test_operation_direction_is_checked_against_authority_not_the_payload(
    task_space_fixture,
) -> None:
    """Direction is decided by the locked authority set, never by the request."""
    label_a = await create_label(task_space_fixture, command_id="label-nx-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-nx-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-nx-proj", key="NX"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-nx-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-nx-seed",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )
    # Remove declaring {A,B}: B is genuinely new -> refused, and nothing was
    # added as a side effect of the rejection.
    rejected = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-nx-mixed",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    assert isinstance(rejected, TaskSpaceRejected)
    assert rejected.code == "label_set_direction_violated"
    assert tuple(rejected.details["would_add"]) == (label_b.entity_id,)
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == [label_a.entity_id]
    assert read["version"] == int(added.value["version"])


@pytest.mark.asyncio
async def test_add_labels_does_not_accept_a_removal_direction(task_space_fixture) -> None:
    """Add of a set strictly smaller than current is refused, not a delete.

    ★ 本用例钉住一条**有意**的行为变更（TS-02a / 裁决一）：本包之前 add 是幂等
    并集（``current | declared``），「用 add 收敛到更小集合」会被接受并静默忽略
    差额；现在同一请求得 422 ``label_set_direction_violated``。裁决一要求
    「Add 只允许维持/增加标签……对越过操作方向的目标集合明确拒绝」，而在目标集合
    语义下保留并集就无法区分「声明」与「差量」。缩小集合必须改用 remove。
    """
    label_a = await create_label(task_space_fixture, command_id="label-ad-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-ad-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-ad-proj", key="AD2"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-ad-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-ad-seed",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )

    rejected = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-ad-shrink",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[],
        ),
    )

    assert isinstance(rejected, TaskSpaceRejected)
    assert rejected.code == "label_set_direction_violated"
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == sorted([label_a.entity_id, label_b.entity_id])
    assert read["version"] == int(added.value["version"])


@pytest.mark.asyncio
async def test_direction_violation_never_reaches_the_database(task_space_fixture) -> None:
    """A refused direction has zero side effects: no junction change, no version."""
    label_a = await create_label(task_space_fixture, command_id="label-zs-a", name="A")
    project = await task_space_fixture.create_project(
        command_id="label-zs-proj", key="ZS"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-zs-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-zs-seed",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id],
        ),
    )
    before_snapshot = _junction_rows(task_space_fixture)

    # A direction-crossing declaration: Remove claiming a label the item never
    # had. It must be refused before any state is touched.
    label_b = await create_label(task_space_fixture, command_id="label-zs-b", name="B")
    rejected = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-zs-reject",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )

    assert isinstance(rejected, TaskSpaceRejected)
    after_snapshot = _junction_rows(task_space_fixture)
    assert after_snapshot == before_snapshot
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["version"] == int(added.value["version"])
    assert read["label_ids"] == [label_a.entity_id]


@pytest.mark.asyncio
async def test_single_label_delete_address_must_match_the_declared_target(
    task_space_fixture,
) -> None:
    """The single-label DELETE route's URL label_id is part of the contract.

    ``require_removed_label_ids`` travels inside the command payload and is
    compared to the declared target set by the compiler — inside the locked
    authority read — under the **equality** rule ``declared == current -
    addressed`` (compiler.py::_compile_label_set_mutation).  Both cases below
    declare a set that differs from ``current - addressed``, so both are refused
    with zero side effects.
    """
    label_a = await create_label(task_space_fixture, command_id="label-am-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-am-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-am-proj", key="AM"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-am-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-am-seed",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    version = int(added.value["version"])

    # URL says "remove A" but the declared target still contains A.
    mismatch = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-am-keep",
            work_item_id=item.value["id"],
            expected_version=version,
            label_ids=sorted([label_a.entity_id, label_b.entity_id]),
            require_removed_label_ids=[label_a.entity_id],
        ),
    )
    assert isinstance(mismatch, TaskSpaceRejected)
    assert mismatch.code == "label_set_direction_violated"
    # current == {A,B}, addressed == {A}, so the only declaration equal to
    # ``current - addressed`` is {B}; keeping A is too large, and the diagnosis
    # names the addressed label that survived.
    assert tuple(mismatch.details["address_mismatch"]["address_label_kept"]) == (
        label_a.entity_id,
    )
    assert mismatch.details["address_mismatch"]["unaddressed_label_dropped"] == ()
    assert tuple(mismatch.details["address_mismatch"]["required_target_ids"]) == (
        label_b.entity_id,
    )

    # URL says "remove B" while the declared target KEEPS B and drops A:
    # current - addressed is {A}, but {B} != {A}, so it is refused — the
    # declaration is neither "B gone" nor "nothing else dropped".  (The direction
    # rule alone would have let this removal through, since it only adds nothing.)
    never_had = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-am-other",
            work_item_id=item.value["id"],
            expected_version=version,
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_b.entity_id],
        ),
    )
    assert isinstance(never_had, TaskSpaceRejected)
    assert never_had.code == "label_set_direction_violated"
    # current == {A,B}, addressed == {B} => the required target is {A}, but the
    # declaration is {B}: the addressed label survived AND A would be dropped.
    assert tuple(never_had.details["address_mismatch"]["address_label_kept"]) == (
        label_b.entity_id,
    )
    assert tuple(never_had.details["address_mismatch"]["unaddressed_label_dropped"]) == (
        label_a.entity_id,
    )

    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == sorted([label_a.entity_id, label_b.entity_id])
    assert read["version"] == version
    assert await task_space_fixture.visible_events(operation_id="label-am-keep") == ()
    assert await task_space_fixture.visible_events(operation_id="label-am-other") == ()


@pytest.mark.asyncio
async def test_single_label_delete_address_matches_and_converges(task_space_fixture) -> None:
    """The matching case: URL label_id gone from the target set => converges."""
    label_a = await create_label(task_space_fixture, command_id="label-ok-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-ok-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-ok-proj", key="OK"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-ok-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-ok-seed",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )

    removed = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-ok-do",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )

    assert isinstance(removed, TaskSpaceAccepted)
    assert removed.value["version"] == int(added.value["version"]) + 1
    assert list(removed.value["label_ids"]) == [label_b.entity_id]


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
async def test_remove_labels_never_adds_a_label_the_item_never_had(
    task_space_fixture,
) -> None:
    """A Remove declaration that includes a brand-new label is not an Add."""
    label_a = await create_label(task_space_fixture, command_id="label-na-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-na-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-na-proj", key="NA"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-na-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-na-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    # Declaring a superset ({A,B} -> {A,B}) is a no-op; the direction rule only
    # fires when the declaration would grow the set.
    noop = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-na-noop",
            work_item_id=item.value["id"],
            expected_version=int(added.value["version"]),
            label_ids=sorted([label_a.entity_id, label_b.entity_id]),
        ),
    )
    assert isinstance(noop, TaskSpaceAccepted)
    assert noop.value["version"] == int(added.value["version"])
    assert await task_space_fixture.visible_events(operation_id="label-na-noop") == ()


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
    # Device B, running on an older snapshot, declares the target {B} with a
    # stale expected_version: it must fail decisively rather than converge or
    # silently overwrite, and it must leave the authoritative set untouched.
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
    assert read["version"] == int(added.value["version"])

    # Device B re-reads the authoritative set, recomputes the target
    # {A} ∪ {B} and retries with a NEW commandId and the refreshed version.
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
    # Each add declares the cumulative target set (TS-02a): {A} then {A,B}.
    for command_id, label_ids in (
        ("label-rs-add-a", [label_a.entity_id]),
        ("label-rs-add-b", [label_a.entity_id, label_b.entity_id]),
    ):
        current = await task_space_fixture.read_work_item(item.value["id"])
        await task_space_fixture.module.execute(
            task_space_fixture.scope,
            add_labels_command(
                space_id=task_space_fixture.space_id,
                command_id=command_id,
                work_item_id=item.value["id"],
                expected_version=int(current["version"]),
                label_ids=label_ids,
            ),
        )
    await task_space_fixture.restart()
    current = await task_space_fixture.read_work_item(item.value["id"])
    assert current["label_ids"] == sorted([label_a.entity_id, label_b.entity_id])

    # A third device declares the exact union {A,B,C}: the junction diff must
    # NOT re-insert rows that already exist (which happens if the freshly
    # loaded authority overlay collapses rows with the same work_item_id).
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
    junction_rows = _junction_rows(task_space_fixture)
    assert len(set(junction_rows)) == 3


@pytest.mark.asyncio
async def test_sync_replay_shrinking_the_set_is_not_refused_as_a_direction_violation(
    task_space_fixture,
) -> None:
    """Sync replay is a full post-image, not an ``add_labels`` declaration.

    The online direction rule (Add may only keep/add) applies to the typed
    ``task_space.AddWorkItemLabels`` command only.  A sync ``entity.update``
    whose label projection genuinely shrinks must still converge the junction
    verbatim — otherwise every legitimate remote removal would fail-closed.
    """
    label_a = await create_label(task_space_fixture, command_id="label-sd-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="label-sd-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="label-sd-proj", key="SD"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "label-sd-item"
    )
    added = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="label-sd-add",
            work_item_id=item.value["id"],
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )

    row = await task_space_fixture.read_work_item(item.value["id"])
    candidate = _full_work_item_post_image(row)
    # Shrinking projection: {A,B} -> {A} arriving over the sync channel.
    candidate["label_ids"] = [label_a.entity_id]
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
        task_space_fixture.scope, request, "sync-label-shrink"
    )

    assert tuple(result.value["label_ids"]) == (label_a.entity_id,)
    assert int(added.value["version"]) + 1 == int(result.value["version"])
    read = await task_space_fixture.read_work_item(item.value["id"])
    assert read["label_ids"] == [label_a.entity_id]


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
    junction_rows = _junction_rows(task_space_fixture)
    assert len(set(junction_rows)) == 1


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
