"""Wave 2 Task T4 tail — concurrent move conflict (CAS 409) recovery.

Single-writer baseline: each space DB serialises mutations through the
mutation lease, so "concurrent" means two clients holding the same item
with divergent local versions, not two parallel transactions.  These
tests prove the recovery path the offline outbox relies on:

1. Client A moves an item; client B still holds the pre-move version.
2. B's move is rejected with the registered ``version_conflict`` code
   BEFORE any side effect (overlay unchanged, zero sync events).
3. After refreshing, B's retry succeeds; the authoritative max+1 rank
   rule accounts for the winner's rank (holes never reused) and the
   tree stays structurally consistent.
4. A stale move whose target parent is ALSO structurally invalid keeps
   failing after refresh with the stable structural code — refresh can
   never turn an illegal move into a legal one.
"""

from __future__ import annotations

import pytest

from app.errors import MutationRejectedError
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import MutateWorkItem, TaskSpaceRejected


async def _move_with_version(
    fixture,
    command_id: str,
    work_item_id: str,
    project_id: str,
    new_parent_id: str | None,
    expected_version: int,
):
    # Mirrors the online Move contract: no client-supplied childRank.
    business = {"new_parent_id": new_parent_id}
    command = MutateWorkItem(
        command_id=command_id,
        space_id=fixture.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": "move", "project_id": project_id, **business},
    )
    return await fixture.module.execute(fixture.scope, command)


@pytest.mark.asyncio
async def test_stale_concurrent_move_is_rejected_then_refresh_retry_recovers(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="mv-conflict-p", key="MV409")
    project_id = str(project.value["id"])
    root = await fixture.create_work_item(project_id, "Root", None, "mv-root")
    a = await fixture.create_work_item(project_id, "A", root.value["id"], "mv-a")
    b = await fixture.create_work_item(project_id, "B", root.value["id"], "mv-b")
    x = await fixture.create_work_item(project_id, "X", a.value["id"], "mv-x")
    x_id = str(x.value["id"])

    # Client B snapshots X before A's move lands.
    stale_version = int(x.value["version"])

    # Client A wins: X moves under B, version bumps.
    winner = await fixture.move(x_id, project_id, str(b.value["id"]), "mv-winner")
    assert winner.value["parent_id"] == str(b.value["id"])
    assert int(winner.value["version"]) == stale_version + 1

    # Client B's concurrent move (still on the stale version) is rejected
    # fail-closed: no side effects, no sync events.  Local commands surface
    # rejection as a TaskSpaceRejected outcome (module.execute maps UoW
    # exceptions to rejections instead of raising).
    before = fixture.overlay_snapshot()
    rejected = await _move_with_version(
        fixture,
        "mv-loser-stale",
        x_id,
        project_id,
        None,  # B wants X back at the root
        stale_version,
    )
    assert isinstance(rejected, TaskSpaceRejected)
    assert rejected.code == "version_conflict"
    assert rejected.retryable is False
    assert fixture.overlay_snapshot() == before
    assert await fixture.visible_events(operation_id="mv-loser-stale") == ()

    # Recovery: refresh, then retry the same intent with the fresh version.
    refreshed = await fixture.read_work_item(x_id)
    assert int(refreshed["version"]) == stale_version + 1
    retry = await _move_with_version(
        fixture, "mv-loser-retry", x_id, project_id, None, int(refreshed["version"])
    )
    assert retry.value["parent_id"] is None
    assert int(retry.value["version"]) == stale_version + 2

    # Authoritative rank after recovery: X now sits at the top level next
    # to "Root" (the only other parentless item).  Ranks are per-parent,
    # so the top level must be Root(0) < X(1) — the winner's move did not
    # create a duplicate or reuse a hole; A/B keep their under-Root ranks.
    top_level = {
        str(row_id): int((await fixture.read_work_item(row_id))["child_rank"])
        for row_id in (str(root.value["id"]), x_id)
    }
    assert top_level == {str(root.value["id"]): 0, x_id: 1}
    assert int((await fixture.read_work_item(str(a.value["id"])))["child_rank"]) == 0
    assert int((await fixture.read_work_item(str(b.value["id"])))["child_rank"]) == 1


@pytest.mark.asyncio
async def test_refresh_cannot_legalize_a_structurally_invalid_move(
    task_space_fixture,
) -> None:
    """CAS recovery never bypasses tree constraints: after refreshing past
    a 409, the same illegal intent must fail with the stable structural
    code, not succeed."""
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="mv-illegal-p", key="MVILL")
    project_id = str(project.value["id"])
    root = await fixture.create_work_item(project_id, "Root", None, "ill-root")
    a = await fixture.create_work_item(project_id, "A", root.value["id"], "ill-a")
    x = await fixture.create_work_item(project_id, "X", a.value["id"], "ill-x")
    y = await fixture.create_work_item(project_id, "Y", root.value["id"], "ill-y")
    z = await fixture.create_work_item(project_id, "Z", y.value["id"], "ill-z")
    x_id = str(x.value["id"])

    # Client B snapshots X, then client A moves X to the top level (legal,
    # depth 1).  X's version bumps, leaving B stale.
    stale = int(x.value["version"])
    winner = await fixture.move(x_id, project_id, None, "ill-mover")
    assert not isinstance(winner, TaskSpaceRejected)

    # B's stale attempt moves X UNDER Z (a depth-3 item): CAS fires first.
    cas = await _move_with_version(
        fixture, "ill-stale", x_id, project_id, str(z.value["id"]), stale
    )
    assert isinstance(cas, TaskSpaceRejected)
    assert cas.code == "version_conflict"

    # Refreshed retry of the SAME illegal intent: structural rejection —
    # Z is at depth 3, so X under Z would be depth 4 (subtree_depth).
    fresh = await fixture.read_work_item(x_id)
    structural = await _move_with_version(
        fixture,
        "ill-retry",
        x_id,
        project_id,
        str(z.value["id"]),
        int(fresh["version"]),
    )
    assert isinstance(structural, TaskSpaceRejected)
    assert structural.code == "invalid_work_item_tree"
    assert structural.details["reason"] == "subtree_depth"

    # Tree unchanged: X is still at the top level.
    after = await fixture.read_work_item(x_id)
    assert after["parent_id"] is None
