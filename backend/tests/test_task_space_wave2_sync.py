"""Wave 2 Task B — Task Space sync/concurrency verification.

Covers:
- Authoritative max+1 rank allocation under the single-writer mutation
  pipeline: sequential and same-batch creates to the same parent never
  produce a duplicate rank.
- Sync replay applies the source post-image rank verbatim even when the
  target sibling ranks differ (holes), never recomputing.
- Fail-closed on incomplete post-image / wrong payload hash, with zero
  side effects (no rows, no events).
- Outbox duplicate delivery is idempotent: replaying the same operation
  id returns the same post-image and records no duplicate event.

Concurrency note: each space DB is single-writer under the mutation lease;
true cross-device parallel writes are not possible against one DB.  These
tests prove the authoritative-allocation property within that constraint.
"""

from __future__ import annotations

from collections.abc import Mapping

import pytest

from app.errors import MutationRejectedError
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import MutateWorkItem, TaskSpaceRejected
from app.task_space.module import build_task_space_request


def _wire_value(value):
    """Deep-convert frozen mutation values to plain JSON-equivalent dicts."""
    if isinstance(value, Mapping):
        return {str(key): _wire_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_wire_value(item) for item in value]
    return value


# ★ 2026-09-12（ADR-0003）：pre_waiting_status_definition_id 是**只出站**的列。
#   入站 push 仍按 WORK_ITEM_SYNC_FIELDS 精确相等 —— 客户端构造 post-image 时
#   必须剔除它；而服务端落库行 / sync 事件 / 返回值必须携带它（完整行形状）。
PRE_WAITING_FIELD = "pre_waiting_status_definition_id"


def _sync_candidate(item: Mapping[str, object], /, **changes: object) -> dict:
    """Client outbound workItem post-image (inbound contract stays exact)."""
    candidate = {**item, **changes}
    candidate.pop(PRE_WAITING_FIELD, None)
    return candidate


@pytest.mark.asyncio
async def test_same_batch_creates_under_one_parent_get_distinct_authoritative_ranks(
    task_space_fixture,
) -> None:
    """Two creates in one batch (same transaction/authority) targeting the
    same parent must receive ranks 0 and 1 — the authoritative max+1 rule is
    evaluated against the in-batch overlay, so no duplicate rank can occur.
    """
    project = await task_space_fixture.create_project(
        command_id="batch-rank-proj", key="BR"
    )
    root = await task_space_fixture.create_work_item(
        project.value["id"], "Root", None, "batch-rank-root"
    )
    request_a = build_task_space_request(
        task_space_fixture.create_work_item_command(
            command_id="batch-rank-a",
            project_id=project.value["id"],
            title="A",
            parent_id=root.value["id"],
        )
    )
    request_b = build_task_space_request(
        task_space_fixture.create_work_item_command(
            command_id="batch-rank-b",
            project_id=project.value["id"],
            title="B",
            parent_id=root.value["id"],
        )
    )

    result = await task_space_fixture.uow.execute_batch(
        task_space_fixture.scope,
        (request_a, request_b),
        "batch-rank-op",
    )

    assert not result.rejected
    assert len(result.applied) == 2
    assert sorted(item.value["child_rank"] for item in result.applied) == [0, 1]
    # Both post-images are persisted in full, including the assigned rank.
    assert all(set(item.value) == set(root.value) for item in result.applied)


@pytest.mark.asyncio
async def test_sequential_two_devices_creating_under_same_parent_never_duplicate_rank(
    task_space_fixture,
) -> None:
    """Two sequential clients (single-writer pipeline) creating under the same
    parent receive distinct append-only ranks; holes from moves are not reused.
    """
    project = await task_space_fixture.create_project(
        command_id="seq-rank-proj", key="SR"
    )
    parent = await task_space_fixture.create_work_item(
        project.value["id"], "Parent", None, "seq-rank-parent"
    )
    device_a_one = await task_space_fixture.create_work_item(
        project.value["id"], "A1", parent.value["id"], "seq-rank-a1"
    )
    device_a_two = await task_space_fixture.create_work_item(
        project.value["id"], "A2", parent.value["id"], "seq-rank-a2"
    )
    # Device A moves A1 away, leaving a hole at 0 under the parent.
    await task_space_fixture.move(
        device_a_one.value["id"], project.value["id"], None, "seq-rank-move-a1"
    )
    device_b = await task_space_fixture.create_work_item(
        project.value["id"], "B1", parent.value["id"], "seq-rank-b1"
    )

    assert device_a_two.value["child_rank"] == 1
    # The freed rank 0 is never reused: max(existing, -1) + 1 = max(1, -1) + 1 = 2.
    assert device_b.value["child_rank"] == 2


@pytest.mark.asyncio
async def test_sync_move_replay_applies_source_rank_against_diverged_target(
    task_space_fixture,
) -> None:
    """A sync move carries the source device's authoritative rank; replay must
    apply it verbatim even though the target parent's sibling ranks differ, so
    recomputing max+1 would produce a different number.
    """
    item = await task_space_fixture.seed_level2("sync-replay-diverged")
    project_id = str(item["project_id"])
    new_parent = await task_space_fixture.create_work_item(
        project_id, "Parent", None, "sync-rd-parent"
    )
    # Target already has children ranked 1 and 2 (hole at 0 from a prior move).
    first = await task_space_fixture.create_work_item(
        project_id, "C1", new_parent.value["id"], "sync-rd-c1"
    )
    second = await task_space_fixture.create_work_item(
        project_id, "C2", new_parent.value["id"], "sync-rd-c2"
    )
    await task_space_fixture.move(
        first.value["id"], project_id, None, "sync-rd-move-c1"
    )
    assert second.value["child_rank"] == 1

    # The source device's post-image carries rank 0 for its moved item.
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        parent_id=str(new_parent.value["id"]),
        child_rank=0,
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
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
        task_space_fixture.scope, request, "sync-replay-diverged-op"
    )

    # Applied verbatim (0), not recomputed (max(1, -1) + 1 = 2).
    assert result.value["child_rank"] == 0
    assert result.value["parent_id"] == str(new_parent.value["id"])
    events = await task_space_fixture.visible_events(
        operation_id="sync-replay-diverged-op"
    )
    assert len(events) == 1
    assert events[0].payload == _wire_value(result.value)


@pytest.mark.asyncio
async def test_sync_work_item_incomplete_post_image_is_fail_closed(
    task_space_fixture,
) -> None:
    """A sync update with an incomplete post-image (missing a required field)
    must be rejected with zero side effects."""
    item = await task_space_fixture.seed_level2("sync-incomplete-post-image")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        title="Incomplete",
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
    del candidate["description"]  # required full post-image field removed
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
            task_space_fixture.scope, request, "sync-incomplete-post-image-op"
        )

    assert caught.value.rejection.code == "work_item_structure_changed"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(
        operation_id="sync-incomplete-post-image-op"
    ) == ()


@pytest.mark.asyncio
async def test_online_move_with_wrong_payload_hash_is_rejected(task_space_fixture) -> None:
    """The online Move module must reject a payload hash mismatch before any
    side effect — a client cannot smuggle fields through the hash."""
    item = await task_space_fixture.seed_level2("move-bad-hash")
    command = MutateWorkItem(
        command_id="move-bad-hash-op",
        space_id=task_space_fixture.space_id,
        work_item_id=str(item["id"]),
        expected_version=int(item["version"]),
        payload_hash="0" * 64,  # does not match the canonical business payload
        payload={
            "operation": "move",
            "project_id": str(item["project_id"]),
            "new_parent_id": None,
        },
    )
    before = task_space_fixture.overlay_snapshot()

    outcome = await task_space_fixture.module.execute(task_space_fixture.scope, command)

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "invalid_payload_hash"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="move-bad-hash-op") == ()


@pytest.mark.asyncio
async def test_outbox_duplicate_delivery_replays_idempotently(task_space_fixture) -> None:
    """Replaying the same sync event under the same operation id must be
    idempotent: the same post-image is returned and no duplicate outbox row is
    recorded."""
    item = await task_space_fixture.seed_level2("sync-dup-delivery")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        title="Synced exactly once",
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
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
    operation_id = "sync-dup-delivery-op"

    first = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, operation_id
    )
    second = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, operation_id
    )

    assert second.value == first.value
    assert second.value["title"] == "Synced exactly once"
    events = await task_space_fixture.visible_events(operation_id=operation_id)
    assert len(events) == 1
    assert events[0].payload == _wire_value(first.value)


@pytest.mark.asyncio
async def test_outbox_post_image_carries_authoritative_rank_after_move(
    task_space_fixture,
) -> None:
    """The outbox event for an online Move must carry the full post-image
    including the authoritative rank assigned in the transaction."""
    project = await task_space_fixture.create_project(
        command_id="post-image-proj", key="PI"
    )
    root_a = await task_space_fixture.create_work_item(
        project.value["id"], "Root A", None, "pi-root-a"
    )
    root_b = await task_space_fixture.create_work_item(
        project.value["id"], "Root B", None, "pi-root-b"
    )
    moved = await task_space_fixture.move(
        root_b.value["id"], project.value["id"], root_a.value["id"], "pi-move"
    )

    # root_a previously had no children -> authoritative rank 0.
    assert moved.value["child_rank"] == 0
    events = await task_space_fixture.visible_events(operation_id="pi-move")
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].payload == _wire_value(moved.value)
    assert events[0].payload["child_rank"] == 0
    assert events[0].payload["parent_id"] == root_a.value["id"]


# --------------------------------------------------------------------------- #
# Wave 2C Task A: sync replay must preserve the validated candidate verbatim.
# The online typed commands generate authoritative server timestamps; replay
# must adopt every WORK_ITEM_SYNC_FIELDS value (updated_at / completed_at /
# cancelled_at / child_rank) exactly as the source device produced it.
# --------------------------------------------------------------------------- #


def _sync_fields_subset(mapping: Mapping[str, object]) -> dict[str, object]:
    from app.task_space.compiler import WORK_ITEM_SYNC_FIELDS

    return {
        field: _wire_value(mapping[field])
        for field in sorted(WORK_ITEM_SYNC_FIELDS)
    }


async def _replay_scalar_update(task_space_fixture, prefix: str, title: str) -> dict:
    item = await task_space_fixture.seed_level2(prefix)
    client_updated_at = task_space_fixture.clock.tick(7)
    candidate = _sync_candidate(
        item,
        title=title,
        description="Replayed description",
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
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
    # Advance the frozen clock AFTER the client timestamp was minted so the
    # server's now_iso_ms() differs from client_updated_at — otherwise a
    # server-side regeneration of updated_at would be masked by the shared clock.
    task_space_fixture.clock.tick(9)
    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, f"{prefix}-op"
    )
    return {"item": item, "candidate": candidate, "result": result}


@pytest.mark.asyncio
async def test_sync_scalar_replay_preserves_every_sync_field_verbatim(
    task_space_fixture,
) -> None:
    """Scalar replay: final DB row, outbox post-image and returned value all
    equal the candidate for every WORK_ITEM_SYNC_FIELDS — and updated_at is the
    source client timestamp, never a regenerated server time."""
    data = await _replay_scalar_update(task_space_fixture, "scalar-fidelity", "Scalar fidelity")
    candidate = data["candidate"]
    client_updated_at = candidate["updated_at"]

    expected = _sync_fields_subset(candidate)
    # ★ 2026-09-12（ADR-0003）：pre_waiting 列是服务端自持、只出站的列，入站
    #   candidate 不含它 —— 「verbatim」断言限定在 WORK_ITEM_SYNC_FIELDS 范围内；
    #   服务端返回值 / 事件额外携带该列（完整 post-image 不变量）。
    assert _sync_fields_subset(data["result"].value) == expected
    assert set(data["result"].value) == set(candidate) | {PRE_WAITING_FIELD}
    row = await task_space_fixture.read_work_item(str(data["item"]["id"]))
    assert _sync_fields_subset(row) == expected
    assert row["updated_at"] == client_updated_at  # NOT overwritten by server
    assert row["version"] == int(data["item"]["version"]) + 1

    events = await task_space_fixture.visible_events(operation_id="scalar-fidelity-op")
    assert len(events) == 1
    assert _sync_fields_subset(_wire_value(events[0].payload)) == expected
    assert set(events[0].payload) == set(candidate) | {PRE_WAITING_FIELD}


@pytest.mark.asyncio
async def test_sync_move_replay_preserves_source_rank_and_timestamp_verbatim(
    task_space_fixture,
) -> None:
    """Move replay against diverged target ranks applies the source rank AND
    the source updated_at verbatim — never recomputing rank or regenerating
    the timestamp."""
    item = await task_space_fixture.seed_level2("move-fidelity")
    project_id = str(item["project_id"])
    new_parent = await task_space_fixture.create_work_item(
        project_id, "Parent", None, "mf-parent"
    )
    first = await task_space_fixture.create_work_item(
        project_id, "C1", new_parent.value["id"], "mf-c1"
    )
    second = await task_space_fixture.create_work_item(
        project_id, "C2", new_parent.value["id"], "mf-c2"
    )
    await task_space_fixture.move(first.value["id"], project_id, None, "mf-move-c1")
    assert second.value["child_rank"] == 1

    client_updated_at = task_space_fixture.clock.tick(11)
    candidate = _sync_candidate(
        item,
        parent_id=str(new_parent.value["id"]),
        child_rank=0,
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
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
    # Server now_iso_ms() must differ from client_updated_at (see scalar note).
    task_space_fixture.clock.tick(13)
    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "move-fidelity-op"
    )

    # ★ 2026-09-12（ADR-0003）：verbatim 语义限定在 WORK_ITEM_SYNC_FIELDS 范围内
    #   （pre_waiting 列由服务端自持，入站 candidate 不含它）。
    assert _sync_fields_subset(result.value) == _sync_fields_subset(candidate)
    assert set(result.value) == set(candidate) | {PRE_WAITING_FIELD}
    assert result.value["child_rank"] == 0  # verbatim, not max(1,-1)+1 = 2
    row = await task_space_fixture.read_work_item(str(item["id"]))
    assert _sync_fields_subset(row) == _sync_fields_subset(candidate)
    assert row["child_rank"] == 0
    assert row["updated_at"] == client_updated_at
    events = await task_space_fixture.visible_events(operation_id="move-fidelity-op")
    assert len(events) == 1
    assert _sync_fields_subset(_wire_value(events[0].payload)) == _sync_fields_subset(candidate)
    assert set(events[0].payload) == set(candidate) | {PRE_WAITING_FIELD}


@pytest.mark.asyncio
async def test_sync_status_replay_preserves_completed_at_cancelled_at_verbatim(
    task_space_fixture,
) -> None:
    """Status replay to completed: completed_at/updated_at are the source
    timestamps, cancelled_at stays None — the state machine must not re-derive
    any of them."""
    item = await task_space_fixture.seed_level2("status-fidelity")
    completed_id = task_space_fixture.status_id("completed")
    client_updated_at = task_space_fixture.clock.tick(5)
    candidate = _sync_candidate(
        item,
        status_definition_id=completed_id,
        completed_at=client_updated_at,
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
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
    # Server now_iso_ms() must differ from client_updated_at (see scalar note).
    task_space_fixture.clock.tick(17)
    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "status-fidelity-op"
    )

    # ★ 2026-09-12（ADR-0003）：verbatim 语义限定在 WORK_ITEM_SYNC_FIELDS 范围内
    #   （pre_waiting 列由服务端自持，入站 candidate 不含它）。
    assert _sync_fields_subset(result.value) == _sync_fields_subset(candidate)
    assert set(result.value) == set(candidate) | {PRE_WAITING_FIELD}
    row = await task_space_fixture.read_work_item(str(item["id"]))
    assert _sync_fields_subset(row) == _sync_fields_subset(candidate)
    assert row["status_definition_id"] == completed_id
    assert row["completed_at"] == client_updated_at
    assert row["cancelled_at"] is None  # not re-derived by the status machine
    assert row["updated_at"] == client_updated_at
    events = await task_space_fixture.visible_events(operation_id="status-fidelity-op")
    assert len(events) == 1
    assert _sync_fields_subset(_wire_value(events[0].payload)) == _sync_fields_subset(candidate)
    assert set(events[0].payload) == set(candidate) | {PRE_WAITING_FIELD}


@pytest.mark.asyncio
async def test_sync_replay_wrong_candidate_version_is_fail_closed(task_space_fixture) -> None:
    """candidate.version != before + 1 must be rejected with zero side effects."""
    item = await task_space_fixture.seed_level2("wrong-version")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        title="Bad version",
        updated_at=client_updated_at,
        version=int(item["version"]) + 2,  # wrong
    )
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
            task_space_fixture.scope, request, "wrong-version-op"
        )
    assert caught.value.rejection.code == "work_item_structure_changed"
    assert caught.value.rejection.details["reason"] == "invalid_candidate_version"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="wrong-version-op") == ()


@pytest.mark.asyncio
async def test_sync_replay_wrong_timestamp_is_fail_closed(task_space_fixture) -> None:
    """candidate.updated_at != the source client timestamp must be rejected."""
    item = await task_space_fixture.seed_level2("wrong-ts")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        title="Bad ts",
        version=int(item["version"]) + 1,
        # updated_at intentionally left at the seed value (not client_updated_at)
    )
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
            task_space_fixture.scope, request, "wrong-ts-op"
        )
    assert caught.value.rejection.code == "work_item_structure_changed"
    assert caught.value.rejection.details["reason"] == "updated_at_not_client_timestamp"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="wrong-ts-op") == ()


@pytest.mark.asyncio
async def test_sync_replay_wrong_expected_version_cas_is_fail_closed(task_space_fixture) -> None:
    """CAS mismatch (expected_version != current version) must be rejected
    before any side effect, reusing the registered version_conflict code."""
    item = await task_space_fixture.seed_level2("wrong-cas")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        title="Bad cas",
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]) + 99,  # stale CAS
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "wrong-cas-op"
        )
    assert caught.value.rejection.code == "version_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="wrong-cas-op") == ()


@pytest.mark.asyncio
async def test_sync_replay_tampered_request_hash_is_rejected(task_space_fixture) -> None:
    """The replay request hash is tamper-evident: a payload mutation that does
    not match the computed request hash is rejected at the request boundary
    with zero side effects (no compiler run, no rows, no events)."""
    from app.mutation.types import MutationRequest

    item = await task_space_fixture.seed_level2("tampered-hash")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        item,
        title="Tampered",
        updated_at=client_updated_at,
        version=int(item["version"]) + 1,
    )
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
    with pytest.raises(ValueError):
        MutationRequest(
            request.name,
            request.entity_type,
            request.entity_id,
            request.payload,
            request.expected_version,
            request.client_updated_at,
            "0" * 64,  # does not match the canonical request hash
        )
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="tampered-hash-op") == ()


# --------------------------------------------------------------------------- #
# ★ 2026-09-11 WorkItem 枚举值域：sync post-image（外部客户端 / 离线行）也必须
#   在编译器层 fail-closed。原因：离线设备可能带着本地自由文本值来重放，
#   不能让越界值穿到 DB CHECK（那里只会得到不可读的 500 / 完整性错误）。
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sync_post_image_rejects_out_of_domain_priority_and_confidence(
    task_space_fixture,
) -> None:
    """越界 priority / confidence 的完整 post-image 必须被稳定拒绝且零副作用。"""
    item = await task_space_fixture.seed_level2("sync-enum-domain")
    for field, dirty in (("priority", "高"), ("confidence", "very_high")):
        operation_id = f"sync-enum-domain-{field}"
        client_updated_at = task_space_fixture.clock.tick()
        candidate = _sync_candidate(
            item,
            **{
                field: dirty,
                "updated_at": client_updated_at,
                "version": int(item["version"]) + 1,
            },
        )
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

        assert caught.value.rejection.code == "work_item_structure_changed"
        assert caught.value.rejection.details["reason"] == f"invalid_{field}"
        assert task_space_fixture.overlay_snapshot() == before
        assert await task_space_fixture.visible_events(operation_id=operation_id) == ()


@pytest.mark.asyncio
async def test_sync_post_image_accepts_canonical_priority_and_confidence(
    task_space_fixture,
) -> None:
    """规范英文值（low/medium/high/urgent + low/medium/high）必须能被重放。"""
    for index, (priority, confidence) in enumerate(
        (("urgent", "high"), ("low", "low"), ("medium", "medium"), ("high", "high"))
    ):
        item = await task_space_fixture.seed_level2(f"sync-enum-ok-{index}")
        operation_id = f"sync-enum-ok-{index}-op"
        client_updated_at = task_space_fixture.clock.tick()
        candidate = _sync_candidate(
            item,
            priority=priority,
            confidence=confidence,
            updated_at=client_updated_at,
            version=int(item["version"]) + 1,
        )
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

        result = await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )

        assert result.value["priority"] == priority
        assert result.value["confidence"] == confidence


@pytest.fixture()
def _no_backup_scheduler(monkeypatch) -> None:
    """HTTP 生命周期测试需要关闭备份调度器（与 Task Space 路由测试同一原因）。"""
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", False)


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_sync_push_http_rejects_noncanonical_priority_post_image(
    _no_backup_scheduler, client
) -> None:
    """真实 HTTP `/sync/v2/push`：越界 priority 的 workItem post-image 必须被拒。

    这是「离线设备带脏值重放」的上游入口 —— 拒绝必须发生在编译期，响应里
    给出稳定的 work_item_structure_changed + reason=invalid_priority，而不是
    让 DB CHECK 以 500 / 完整性错误收场。
    """
    from tests.sync_v2_helpers import (
        make_sync_v2_event,
        push_sync_v2,
        ready_sync_v2_client,
    )

    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201, setup.text
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master = {"Authorization": f"Bearer {login.json()['access_token']}"}
    space = await client.post(
        "/api/v1/spaces", json={"name": "Sync Enum Space"}, headers=master
    )
    assert space.status_code == 201, space.text
    space_id = space.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master
    )
    assert token.status_code == 200, token.text
    headers = {"Authorization": f"Bearer {token.json()['space_token']}"}
    client_id = await ready_sync_v2_client(client, headers)

    project_payload = {"key": "SYNCENUM", "name": "Sync Enum", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "sync-enum-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            "key": "syncenum",
            "name": "Sync Enum",
        },
        headers={**headers, "Idempotency-Key": "sync-enum-project"},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["entityId"]

    business = {
        "title": "同步任务",
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    created = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": "sync-enum-item",
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(business),
            "title": business["title"],
        },
        headers={**headers, "Idempotency-Key": "sync-enum-item"},
    )
    assert created.status_code == 201, created.text
    item = created.json()["value"]

    # 权威 post-image 的 snake_case 形态（= sync 线协议形状）。
    post_image = {
        "project_id": item["projectId"],
        "display_key": item["displayKey"],
        "title": item["title"],
        "description": item["description"],
        "type_definition_id": item["typeDefinitionId"],
        "status_definition_id": item["statusDefinitionId"],
        "priority": item["priority"],
        "parent_id": item["parentId"],
        "child_rank": item["childRank"],
        "completion_window_start": item["completionWindowStart"],
        "completion_window_end": item["completionWindowEnd"],
        "review_point": item["reviewPoint"],
        "hard_deadline": item["hardDeadline"],
        "effort_estimate_lower_seconds": item["effortEstimateLowerSeconds"],
        "effort_estimate_upper_seconds": item["effortEstimateUpperSeconds"],
        "effort_actual_seconds": item["effortActualSeconds"],
        "confidence": item["confidence"],
        "completed_at": item["completedAt"],
        "cancelled_at": item["cancelledAt"],
        "archived_at": item["archivedAt"],
        "marked_as_attention": item["markedAsAttention"],
        "label_ids": item["labelIds"],
        "created_at": item["createdAt"],
        "updated_at": item["updatedAt"],
        "version": item["version"],
    }
    client_updated_at = "2026-09-11T00:00:00.000Z"
    dirty = {
        **post_image,
        "priority": "高",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }

    data = await push_sync_v2(
        client,
        headers,
        client_id,
        [
            make_sync_v2_event(
                entity_type="workItem",
                entity_id=item["id"],
                action="update",
                payload=dirty,
                expected_version=int(item["version"]),
                client_updated_at=client_updated_at,
            )
        ],
    )

    assert data["applied"] == [], data
    assert [error["code"] for error in data["errors"]] == [
        "work_item_structure_changed"
    ]
    assert data["errors"][0]["details"]["reason"] == "invalid_priority"

    # 零副作用：权威行仍是最初的 priority=None / 原版本。
    reread = await client.get(f"/api/v1/work-items/{item['id']}", headers=headers)
    assert reread.status_code == 200, reread.text
    assert reread.json()["priority"] is None
    assert reread.json()["version"] == item["version"]
