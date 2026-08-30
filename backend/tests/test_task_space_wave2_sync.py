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
    candidate = {
        **item,
        "parent_id": str(new_parent.value["id"]),
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
    assert events[0].payload == result.value


@pytest.mark.asyncio
async def test_sync_work_item_incomplete_post_image_is_fail_closed(
    task_space_fixture,
) -> None:
    """A sync update with an incomplete post-image (missing a required field)
    must be rejected with zero side effects."""
    item = await task_space_fixture.seed_level2("sync-incomplete-post-image")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "title": "Incomplete",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
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
    candidate = {
        **item,
        "title": "Synced exactly once",
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
    assert events[0].payload == first.value


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
    assert events[0].payload == moved.value
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

    return {field: mapping[field] for field in sorted(WORK_ITEM_SYNC_FIELDS)}


async def _replay_scalar_update(task_space_fixture, prefix: str, title: str) -> dict:
    item = await task_space_fixture.seed_level2(prefix)
    client_updated_at = task_space_fixture.clock.tick(7)
    candidate = {
        **item,
        "title": title,
        "description": "Replayed description",
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
    assert data["result"].value == candidate
    assert set(data["result"].value) == set(candidate)
    row = await task_space_fixture.read_work_item(str(data["item"]["id"]))
    assert _sync_fields_subset(row) == expected
    assert row["updated_at"] == client_updated_at  # NOT overwritten by server
    assert row["version"] == int(data["item"]["version"]) + 1

    events = await task_space_fixture.visible_events(operation_id="scalar-fidelity-op")
    assert len(events) == 1
    assert events[0].payload == candidate


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
    candidate = {
        **item,
        "parent_id": str(new_parent.value["id"]),
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
    # Server now_iso_ms() must differ from client_updated_at (see scalar note).
    task_space_fixture.clock.tick(13)
    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "move-fidelity-op"
    )

    assert result.value == candidate
    assert result.value["child_rank"] == 0  # verbatim, not max(1,-1)+1 = 2
    row = await task_space_fixture.read_work_item(str(item["id"]))
    assert _sync_fields_subset(row) == _sync_fields_subset(candidate)
    assert row["child_rank"] == 0
    assert row["updated_at"] == client_updated_at
    events = await task_space_fixture.visible_events(operation_id="move-fidelity-op")
    assert len(events) == 1
    assert events[0].payload == candidate


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
    candidate = {
        **item,
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
    # Server now_iso_ms() must differ from client_updated_at (see scalar note).
    task_space_fixture.clock.tick(17)
    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "status-fidelity-op"
    )

    assert result.value == candidate
    row = await task_space_fixture.read_work_item(str(item["id"]))
    assert _sync_fields_subset(row) == _sync_fields_subset(candidate)
    assert row["status_definition_id"] == completed_id
    assert row["completed_at"] == client_updated_at
    assert row["cancelled_at"] is None  # not re-derived by the status machine
    assert row["updated_at"] == client_updated_at
    events = await task_space_fixture.visible_events(operation_id="status-fidelity-op")
    assert len(events) == 1
    assert events[0].payload == candidate


@pytest.mark.asyncio
async def test_sync_replay_wrong_candidate_version_is_fail_closed(task_space_fixture) -> None:
    """candidate.version != before + 1 must be rejected with zero side effects."""
    item = await task_space_fixture.seed_level2("wrong-version")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "title": "Bad version",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 2,  # wrong
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
    candidate = {
        **item,
        "title": "Bad ts",
        "version": int(item["version"]) + 1,
        # updated_at intentionally left at the seed value (not client_updated_at)
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
    candidate = {
        **item,
        "title": "Bad cas",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
    }
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
    candidate = {
        **item,
        "title": "Tampered",
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
