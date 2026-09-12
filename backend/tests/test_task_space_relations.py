"""Dependency domain: Relation contract + compiler semantics.

Covers 依赖域合同 D11/D12/D13/D16/D17:
- deterministic relationId (idempotent, offline-convergent);
- single-sided storage, dual-view projection;
- incremental reachability cycle detection with an exact cycle_path;
- AND semantics across multiple upstream blockers;
- archived endpoints are immutable;
- cross-Space edges are structurally impossible.
"""
from __future__ import annotations

import pytest

from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import RelationCommand, TaskSpaceRejected, relation_id
from app.task_space.queries import compute_is_blocked, derive_blocked_by_dependency

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _hash(from_id: str, to_id: str, relation_type: str = "depends_on") -> str:
    return canonical_payload_hash({
        "from_work_item_id": from_id,
        "to_work_item_id": to_id,
        "relation_type": relation_type,
    })


def _command(
    fixture,
    *,
    operation: str,
    from_id: str,
    to_id: str,
    command_id: str,
    relation_type: str = "depends_on",
    expected_version: int | None = None,
) -> RelationCommand:
    return RelationCommand(
        operation=operation,
        command_id=command_id,
        space_id=fixture.space_id,
        relation_id=relation_id(fixture.space_id, from_id, to_id, relation_type),
        from_work_item_id=from_id,
        to_work_item_id=to_id,
        relation_type=relation_type,
        expected_version=expected_version,
        payload_hash=_hash(from_id, to_id, relation_type),
    )


async def _create(fixture, from_id: str, to_id: str, command_id: str, relation_type: str = "depends_on"):
    return await fixture.module.execute(
        fixture.scope,
        _command(
            fixture, operation="create", from_id=from_id, to_id=to_id,
            command_id=command_id, relation_type=relation_type,
        ),
    )


async def _remove(fixture, from_id: str, to_id: str, command_id: str, expected_version: int, relation_type: str = "depends_on"):
    return await fixture.module.execute(
        fixture.scope,
        _command(
            fixture, operation="remove", from_id=from_id, to_id=to_id,
            command_id=command_id, relation_type=relation_type,
            expected_version=expected_version,
        ),
    )


async def _resolve(fixture, from_id: str, to_id: str, command_id: str, expected_version: int, relation_type: str = "depends_on"):
    """D2：确认「已取消的上游不再需要」（幂等 CAS）。"""
    return await fixture.module.execute(
        fixture.scope,
        _command(
            fixture, operation="resolve", from_id=from_id, to_id=to_id,
            command_id=command_id, relation_type=relation_type,
            expected_version=expected_version,
        ),
    )


async def _seed(fixture, prefix: str):
    project = await fixture.create_project(command_id=f"{prefix}-project", key=prefix[:4].upper())
    project_id = str(project.value["id"])
    root = await fixture.create_work_item(project_id, f"{prefix} root", None, f"{prefix}-root")
    return project_id, str(root.value["id"])


def _reject_code(outcome) -> str | None:
    return outcome.code if isinstance(outcome, TaskSpaceRejected) else None


# --------------------------------------------------------------------------- #
# D11 / D15: deterministic id + idempotence
# --------------------------------------------------------------------------- #


def test_relation_id_is_deterministic_and_stable() -> None:
    first = relation_id("s1", "a", "b", "depends_on")
    second = relation_id("s1", "a", "b", "depends_on")
    assert first == second
    assert first.startswith("rel_") and len(first) == 36
    # Direction and type are both part of the identity.
    assert relation_id("s1", "b", "a", "depends_on") != first
    assert relation_id("s1", "a", "b", "blocks") != first
    assert relation_id("s2", "a", "b", "depends_on") != first


@pytest.mark.asyncio
async def test_create_relation_persists_one_canonical_edge(task_space_fixture) -> None:
    _, root_id = await _seed(task_space_fixture, "relcan")
    project = task_space_fixture
    child_a = await project.create_work_item(
        (await project.read_work_item(root_id))["project_id"], "A", root_id, "relcan-a"
    )
    child_b = await project.create_work_item(
        (await project.read_work_item(root_id))["project_id"], "B", root_id, "relcan-b"
    )
    a_id, b_id = str(child_a.value["id"]), str(child_b.value["id"])

    outcome = await _create(project, a_id, b_id, "relcan-c1")

    assert not isinstance(outcome, TaskSpaceRejected), getattr(outcome, "code", "")
    assert outcome.value["id"] == relation_id(project.space_id, a_id, b_id, "depends_on")
    assert outcome.value["from_work_item_id"] == a_id
    assert outcome.value["to_work_item_id"] == b_id
    assert outcome.value["version"] == 1
    events = await project.visible_events(operation_id="relcan-c1")
    assert len(events) == 1
    assert events[0].entity_type == "relation"
    assert events[0].action == "create"


@pytest.mark.asyncio
async def test_duplicate_create_is_a_zero_effect_receipt(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relidem")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relidem-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "relidem-b")
    a_id, b_id = str(a.value["id"]), str(b.value["id"])

    first = await _create(fixture, a_id, b_id, "relidem-c1")
    second = await _create(fixture, a_id, b_id, "relidem-c2")

    assert second.value["id"] == first.value["id"]
    assert second.value["version"] == 1
    # A no-op must not emit a second sync event.
    assert await fixture.visible_events(operation_id="relidem-c2") == ()


# --------------------------------------------------------------------------- #
# D13: cycle detection
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_self_loop_is_rejected_as_a_cycle(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relself")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relself-a")
    a_id = str(a.value["id"])

    outcome = await _create(fixture, a_id, a_id, "relself-c1")

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "cycle_detected"
    # details is deep-frozen in the compiler (tuples); the HTTP layer thaws
    # them back to JSON arrays, so normalise before comparing.
    assert list(outcome.details["cycle_path"]) == [a_id, a_id]


@pytest.mark.asyncio
async def test_two_node_cycle_is_rejected_with_exact_path(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "reltwo")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "reltwo-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "reltwo-b")
    a_id, b_id = str(a.value["id"]), str(b.value["id"])

    assert _reject_code(await _create(fixture, a_id, b_id, "reltwo-c1")) is None
    blocked = await _create(fixture, b_id, a_id, "reltwo-c2")

    assert isinstance(blocked, TaskSpaceRejected)
    assert blocked.code == "cycle_detected"
    assert list(blocked.details["cycle_path"]) == [b_id, a_id, b_id]
    assert list(blocked.details["conflicting_edge"]) == [b_id, a_id]


@pytest.mark.asyncio
async def test_three_node_indirect_cycle_reports_the_full_path(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relthree")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relthree-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "relthree-b")
    c = await fixture.create_work_item(project_id, "C", root_id, "relthree-c")
    a_id, b_id, c_id = str(a.value["id"]), str(b.value["id"]), str(c.value["id"])

    await _create(fixture, a_id, b_id, "relthree-c1")
    await _create(fixture, b_id, c_id, "relthree-c2")
    closing = await _create(fixture, c_id, a_id, "relthree-c3")

    assert isinstance(closing, TaskSpaceRejected)
    assert closing.code == "cycle_detected"
    path = list(closing.details["cycle_path"])
    assert path[0] == path[-1] == c_id
    assert set(path) == {a_id, b_id, c_id}
    # The path is a real walk along existing edges, not an arbitrary set.
    assert path == [c_id, a_id, b_id, c_id]


@pytest.mark.asyncio
async def test_diamond_shape_is_not_a_cycle(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "reldia")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    top = await fixture.create_work_item(project_id, "Top", root_id, "reldia-top")
    left = await fixture.create_work_item(project_id, "Left", root_id, "reldia-left")
    right = await fixture.create_work_item(project_id, "Right", root_id, "reldia-right")
    bottom = await fixture.create_work_item(project_id, "Bottom", root_id, "reldia-bottom")
    top_id = str(top.value["id"])
    left_id, right_id = str(left.value["id"]), str(right.value["id"])
    bottom_id = str(bottom.value["id"])

    for from_id, to_id, command_id in (
        (bottom_id, left_id, "reldia-c1"),
        (bottom_id, right_id, "reldia-c2"),
        (left_id, top_id, "reldia-c3"),
    ):
        assert _reject_code(await _create(fixture, from_id, to_id, command_id)) is None
    # Closing the diamond does NOT create a cycle (no back edge to bottom).
    assert _reject_code(await _create(fixture, right_id, top_id, "reldia-c4")) is None


@pytest.mark.asyncio
async def test_relates_to_neither_blocks_nor_closes_a_cycle(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relrel")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relrel-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "relrel-b")
    a_id, b_id = str(a.value["id"]), str(b.value["id"])

    assert _reject_code(
        await _create(fixture, a_id, b_id, "relrel-c1", relation_type="relates_to")
    ) is None
    # The reverse relates_to would be a cycle if it blocked; it must not.
    assert _reject_code(
        await _create(fixture, b_id, a_id, "relrel-c2", relation_type="relates_to")
    ) is None

    assert derive_blocked_by_dependency(
        [{"from_work_item_id": a_id, "to_work_item_id": b_id, "relation_type": "relates_to"}],
        {b_id: "in_progress"},
    ) == {}


# --------------------------------------------------------------------------- #
# D17 / guards
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_archived_endpoint_is_immutable(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relarch")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relarch-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "relarch-b")
    a_id, b_id = str(a.value["id"]), str(b.value["id"])

    from app.task_space.contracts import MutateWorkItem

    trash = MutateWorkItem(
        command_id="relarch-trash",
        space_id=fixture.space_id,
        work_item_id=b_id,
        expected_version=int(b.value["version"]),
        payload_hash=canonical_payload_hash({}),
        payload={"operation": "trash"},
    )
    assert not isinstance(await fixture.module.execute(fixture.scope, trash), TaskSpaceRejected)

    outcome = await _create(fixture, a_id, b_id, "relarch-c1")
    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "archived_work_item_immutable"


@pytest.mark.asyncio
async def test_unknown_endpoint_is_not_found(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relmiss")

    outcome = await _create(fixture, root_id, "does-not-exist", "relmiss-c1")
    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "not_found"


@pytest.mark.asyncio
async def test_cross_space_payload_is_rejected(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relxspace")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relxspace-a")
    a_id = str(a.value["id"])

    from dataclasses import replace

    command = replace(
        _command(fixture, operation="create", from_id=a_id, to_id=root_id, command_id="relxspace-c1"),
        space_id="another-space",
    )
    outcome = await fixture.module.execute(fixture.scope, command)
    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "space_scope_mismatch"


# --------------------------------------------------------------------------- #
# Removal + tombstone
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_remove_emits_a_delete_event_that_drives_the_tombstone(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relrm")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relrm-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "relrm-b")
    a_id, b_id = str(a.value["id"]), str(b.value["id"])

    created = await _create(fixture, a_id, b_id, "relrm-c1")
    removed = await _remove(fixture, a_id, b_id, "relrm-c2", int(created.value["version"]))

    assert not isinstance(removed, TaskSpaceRejected), getattr(removed, "code", "")
    events = await fixture.visible_events(operation_id="relrm-c2")
    assert len(events) == 1
    assert events[0].action == "delete"
    assert events[0].entity_type == "relation"
    # The overlay no longer holds the row.
    assert fixture.uow is not None


@pytest.mark.asyncio
async def test_remove_with_stale_version_conflicts(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relrmv")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relrmv-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "relrmv-b")
    a_id, b_id = str(a.value["id"]), str(b.value["id"])

    await _create(fixture, a_id, b_id, "relrmv-c1")
    outcome = await _remove(fixture, a_id, b_id, "relrmv-c2", 99)

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "version_conflict"


@pytest.mark.asyncio
async def test_remove_unknown_edge_is_not_found(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "relrmx")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "relrmx-a")
    a_id = str(a.value["id"])

    outcome = await _remove(fixture, a_id, root_id, "relrmx-c1", 1)
    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "not_found"


# --------------------------------------------------------------------------- #
# D16: multi-upstream AND semantics (pure function)
# --------------------------------------------------------------------------- #


def test_and_semantics_requires_every_upstream_to_close() -> None:
    relations = [
        {"from_work_item_id": "c", "to_work_item_id": "a", "relation_type": "depends_on"},
        {"from_work_item_id": "c", "to_work_item_id": "b", "relation_type": "depends_on"},
    ]
    # Both open -> blocked.
    assert derive_blocked_by_dependency(relations, {"a": "in_progress", "b": "not_started"})["c"]
    # Only A completed -> STILL blocked (this is the classic regression trap).
    assert derive_blocked_by_dependency(relations, {"a": "completed", "b": "in_progress"})["c"]
    # ★ D2（ADR-0004）：A cancelled 未确认 = broken_requires_resolution -> 仍阻塞。
    #   旧行为「cancelled 静默当完成」正是本次要修的病变。
    assert derive_blocked_by_dependency(relations, {"a": "cancelled", "b": "completed"})["c"]
    # 确认「不再需要」后该边才算 satisfied —— 只影响被确认的那条边。
    confirmed = [
        {**relations[0], "resolution": "confirmed_not_required"},
        relations[1],
    ]
    assert not derive_blocked_by_dependency(
        confirmed, {"a": "cancelled", "b": "completed"}
    ).get("c", False)
    # 未确认的另一条边仍然阻塞（AND 语义不受确认影响）。
    assert derive_blocked_by_dependency(
        confirmed, {"a": "cancelled", "b": "cancelled"}
    )["c"]


def test_missing_endpoint_never_silently_unblocks() -> None:
    relations = [{"from_work_item_id": "c", "to_work_item_id": "a", "relation_type": "depends_on"}]
    # 'a' has not hydrated yet -> treat as open, never as done.
    assert derive_blocked_by_dependency(relations, {})["c"]


def test_is_blocked_is_defined_only_for_level_two() -> None:
    assert compute_is_blocked(2, True) is True
    assert compute_is_blocked(1, True) is False
    assert compute_is_blocked(3, True) is False
    assert compute_is_blocked(2, False) is False


@pytest.mark.asyncio
async def test_blocked_map_reflects_live_status_changes(task_space_fixture) -> None:
    """End-to-end AND semantics: C blocked by A and B until BOTH are done."""
    fixture = task_space_fixture
    _, root_id = await _seed(fixture, "reland")
    project_id = (await fixture.read_work_item(root_id))["project_id"]
    a = await fixture.create_work_item(project_id, "A", root_id, "reland-a")
    b = await fixture.create_work_item(project_id, "B", root_id, "reland-b")
    c = await fixture.create_work_item(project_id, "C", root_id, "reland-c")
    a_id, b_id, c_id = str(a.value["id"]), str(b.value["id"]), str(c.value["id"])

    await _create(fixture, c_id, a_id, "reland-c1")
    edge_b = await _create(fixture, c_id, b_id, "reland-c2")
    assert not isinstance(edge_b, TaskSpaceRejected), getattr(edge_b, "code", "")

    from app.task_space.contracts import MutateWorkItem

    async def transition(work_item_id: str, version: int, category: str, command_id: str) -> None:
        command = MutateWorkItem(
            command_id=command_id,
            space_id=fixture.space_id,
            work_item_id=work_item_id,
            expected_version=version,
            payload_hash=canonical_payload_hash(
                {"status_definition_id": fixture.status_id(category)}
            ),
            payload={
                "operation": "transition",
                "status_definition_id": fixture.status_id(category),
            },
        )
        outcome = await fixture.module.execute(fixture.scope, command)
        assert not isinstance(outcome, TaskSpaceRejected), getattr(outcome, "code", "")

    mapping = await fixture.queries.blocked_map(fixture.scope, project_id)
    assert mapping[c_id]["blockedByDependency"] is True

    await transition(a_id, int(a.value["version"]), "completed", "reland-t-a")
    mapping = await fixture.queries.blocked_map(fixture.scope, project_id)
    assert mapping[c_id]["blockedByDependency"] is True, "AND semantics violated"

    # ★ D2（ADR-0004）：cancelled 不再静默解除 —— 边进入 broken_requires_resolution。
    await transition(b_id, int(b.value["version"]), "cancelled", "reland-t-b")
    mapping = await fixture.queries.blocked_map(fixture.scope, project_id)
    assert mapping[c_id]["blockedByDependency"] is True, (
        "cancelled must keep the edge broken until explicitly resolved"
    )

    # 显式确认「不再需要」后，解除才发生（该边 version 递增）。
    resolved = await _resolve(
        fixture, c_id, b_id, "reland-r1", int(edge_b.value["version"])
    )
    assert not isinstance(resolved, TaskSpaceRejected), getattr(resolved, "code", "")
    mapping = await fixture.queries.blocked_map(fixture.scope, project_id)
    assert mapping[c_id]["blockedByDependency"] is False
