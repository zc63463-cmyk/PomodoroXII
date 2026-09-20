"""TS-02a defect two: the single-label DELETE address constraint was incomplete.

缺陷二（收口复核补充第 3 节）：``app/task_space/compiler.py:1441-1455`` 的地址约束
用的是**子集**判定 ``required <= (current - declared)``，它只要求「被寻址标签不在
declared 里」，于是同时犯两个错：

- 例 1（误拒 no-op）：current={B}、URL 寻址 A、declared={B}。``current-declared``
  为空，``required={A}`` 不⊆ 空集 ⇒ 被拒；但「移除一个本来就不在集合里的标签」
  应当是 **no-op**（compiler.py:1476 起本就有零副作用分支）。
- 例 2（误接受多删）：current={A,B}、URL 寻址 A、declared={}。
  ``current-declared={A,B}``、``required={A}`` ⊆ 它 ⇒ 通过；方向门（remove 只拦
  added_by_declaration，此处为空）也通过 ⇒ 接受，于是**连同未寻址的 B 一起删掉**。

正确语义是**相等**判定：``declared == current - required``。在「declared 是完整
目标集合」的前提下，「寻址标签消失且没有多删任何东西」恰好等价于该等式 —— 一处同时
覆盖两个方向（允许标签原本不存在的 no-op；禁止多删未寻址标签）。

本模块的回归全部经**真实** ``DefaultTaskSpaceCommandModule`` + 真实
``MutationUnitOfWork``（task_space_fixture），并另有一条经**真实 HTTP 路由**
（单条 DELETE 与批量 POST 各一条）—— 按裁决一「拒绝用内存替身冒充交付证据」。
错误码复用既有闭集成员 ``label_set_direction_violated``，不新增码。
"""
from __future__ import annotations

import pytest

from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import (
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpaceRejected,
)
from tests.test_task_space_labels import (
    _junction_rows,
    add_labels_command,
    create_label,
    remove_labels_command,
)


def _labels(value) -> list[str]:
    return sorted(map(str, value["label_ids"]))


# --------------------------------------------------------------------------- #
# Case one: the addressed label was never there => no-op, not a rejection
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_removing_a_label_the_item_never_had_is_a_noop(task_space_fixture) -> None:
    """current={B}, URL addresses A, declared={B} => accepted, zero effect.

    On the unfixed tree this is rejected with ``label_set_direction_violated``
    because ``{A} <= (current - declared) == {}`` is false.
    """
    label_a = await create_label(task_space_fixture, command_id="d2-noop-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="d2-noop-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="d2-noop-proj", key="DN"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "d2-noop-item"
    )
    work_item_id = item.value["id"]
    # Seed with ONLY B, then try to remove A (which this item never had).
    seeded = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-noop-seed",
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            label_ids=[label_b.entity_id],
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    junction_before = _junction_rows(task_space_fixture)

    outcome = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-noop-do",
            work_item_id=work_item_id,
            expected_version=version,
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )

    assert isinstance(outcome, TaskSpaceAccepted), (
        f"removing an absent label must be a no-op, got "
        f"{type(outcome).__name__} {getattr(outcome, 'code', None)} "
        f"{getattr(outcome, 'details', None)}"
    )
    # Zero effect: version untouched, junction untouched, no ledger event.
    assert int(outcome.value["version"]) == version
    assert _labels(outcome.value) == [label_b.entity_id]
    read = await task_space_fixture.read_work_item(work_item_id)
    assert int(read["version"]) == version
    assert _labels(read) == [label_b.entity_id]
    assert _junction_rows(task_space_fixture) == junction_before
    assert await task_space_fixture.visible_events(operation_id="d2-noop-do") == ()


# --------------------------------------------------------------------------- #
# Case two: dropping an un-addressed label => rejected, zero side effects
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_declaring_a_set_that_also_drops_an_unaddressed_label_is_rejected(
    task_space_fixture,
) -> None:
    """current={A,B}, URL addresses A, declared={} => rejected, zero effect.

    On the unfixed tree this is ACCEPTED and really deletes B as well, so the
    assertion below is the regression that pins the over-deletion shut.
    """
    label_a = await create_label(task_space_fixture, command_id="d2-over-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="d2-over-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="d2-over-proj", key="DO"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "d2-over-item"
    )
    work_item_id = item.value["id"]
    seeded = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-over-seed",
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    junction_before = _junction_rows(task_space_fixture)

    outcome = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-over-do",
            work_item_id=work_item_id,
            expected_version=version,
            label_ids=[],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )

    assert isinstance(outcome, TaskSpaceRejected), (
        "declaring the empty set while addressing only A must not silently "
        f"delete the un-addressed B; got {type(outcome).__name__}"
    )
    assert outcome.code == "label_set_direction_violated"
    assert outcome.retryable is False
    # Zero side effects: nothing written, no version movement, no ledger event.
    read = await task_space_fixture.read_work_item(work_item_id)
    assert _labels(read) == sorted([label_a.entity_id, label_b.entity_id])
    assert int(read["version"]) == version
    assert _junction_rows(task_space_fixture) == junction_before
    assert await task_space_fixture.visible_events(operation_id="d2-over-do") == ()


# --------------------------------------------------------------------------- #
# The equality rule in both directions, at the domain level
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_address_constraint_is_exact_equality_not_a_subset(
    task_space_fixture,
) -> None:
    """declared must equal ``current - addressed`` exactly, neither more nor less.

    Three shapes against current={A,B} with A addressed:
      * declared={B}   == current - {A}          => accepted (lands exactly)
      * declared={}    != current - {A}          => rejected (would drop B)
      * declared={A,B} != current - {A}          => rejected (kept A)
    """
    label_a = await create_label(task_space_fixture, command_id="d2-eq-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="d2-eq-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="d2-eq-proj", key="DQ"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "d2-eq-item"
    )
    work_item_id = item.value["id"]
    seeded = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-eq-seed",
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])

    async def attempt(command_id: str, declared: list[str], expected: int):
        return await task_space_fixture.module.execute(
            task_space_fixture.scope,
            remove_labels_command(
                space_id=task_space_fixture.space_id,
                command_id=command_id,
                work_item_id=work_item_id,
                expected_version=expected,
                label_ids=declared,
                require_removed_label_ids=[label_a.entity_id],
            ),
        )

    # exact: current - {A} == {B}
    exact = await attempt("d2-eq-exact", [label_b.entity_id], version)
    assert isinstance(exact, TaskSpaceAccepted), (
        f"declared == current - addressed must be accepted, got "
        f"{type(exact).__name__} {getattr(exact, 'code', None)}"
    )
    assert int(exact.value["version"]) == version + 1
    assert _labels(exact.value) == [label_b.entity_id]
    landed = int(exact.value["version"])

    # too small: drops the un-addressed B as well
    too_small = await attempt("d2-eq-small", [], landed)
    assert isinstance(too_small, TaskSpaceRejected)
    assert too_small.code == "label_set_direction_violated"

    # too large: the addressed label survives
    too_large = await attempt(
        "d2-eq-large", [label_a.entity_id, label_b.entity_id], landed
    )
    assert isinstance(too_large, TaskSpaceRejected)
    assert too_large.code == "label_set_direction_violated"

    read = await task_space_fixture.read_work_item(work_item_id)
    assert _labels(read) == [label_b.entity_id]
    assert int(read["version"]) == landed
    assert await task_space_fixture.visible_events(operation_id="d2-eq-small") == ()
    assert await task_space_fixture.visible_events(operation_id="d2-eq-large") == ()


@pytest.mark.asyncio
async def test_noop_convergence_is_still_a_zero_effect_receipt(
    task_space_fixture,
) -> None:
    """A repeated single-label DELETE on the same target stays a no-op.

    After the exact removal lands, replaying the same declared set under a fresh
    commandId is ``declared == current`` (the addressed label is gone), so it
    must be accepted as a zero-effect receipt rather than rejected.
    """
    label_a = await create_label(task_space_fixture, command_id="d2-re-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="d2-re-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="d2-re-proj", key="DR"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "d2-re-item"
    )
    work_item_id = item.value["id"]
    seeded = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-re-seed",
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    version = int(seeded.value["version"])
    first = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-re-first",
            work_item_id=work_item_id,
            expected_version=version,
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )
    assert isinstance(first, TaskSpaceAccepted)
    after = int(first.value["version"])

    # Same URL still names A (now already absent), same declared target {B}.
    replay = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-re-again",
            work_item_id=work_item_id,
            expected_version=after,
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )
    assert isinstance(replay, TaskSpaceAccepted), (
        f"a converged re-declaration must be a no-op receipt, got "
        f"{type(replay).__name__} {getattr(replay, 'code', None)}"
    )
    assert int(replay.value["version"]) == after
    read = await task_space_fixture.read_work_item(work_item_id)
    assert int(read["version"]) == after
    assert _labels(read) == [label_b.entity_id]
    assert await task_space_fixture.visible_events(operation_id="d2-re-again") == ()


@pytest.mark.asyncio
async def test_stale_cache_remove_of_an_already_gone_label_is_a_noop(
    task_space_fixture,
) -> None:
    """The realistic client retry: the addressed label is already gone server-side.

    The frontend computes ``target = cached.labelIds - {addressed}``
    (task-space-repository.ts::removeWorkItemLabel). If the label was already
    removed by an earlier attempt, the server's ``current`` no longer holds it,
    so ``declared == current`` and the equality rule accepts the command as a
    zero-effect receipt. The old subset rule rejected exactly this — the very
    retry a client makes after a lost response.
    """
    label_a = await create_label(task_space_fixture, command_id="d2-sc-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="d2-sc-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="d2-sc-proj", key="DS"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "d2-sc-item"
    )
    work_item_id = item.value["id"]
    seeded = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-sc-seed",
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    version = int(seeded.value["version"])
    # First attempt really removes A (and, being the exact complement, lands).
    first = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-sc-first",
            work_item_id=work_item_id,
            expected_version=version,
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )
    assert isinstance(first, TaskSpaceAccepted)
    landed = int(first.value["version"])

    # The client's cache still says {A,B}, so its retry declares {B} addressing A
    # even though A is gone. That declaration equals the current set: no-op.
    retry = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-sc-retry",
            work_item_id=work_item_id,
            expected_version=landed,
            label_ids=[label_b.entity_id],
            require_removed_label_ids=[label_a.entity_id],
        ),
    )
    assert isinstance(retry, TaskSpaceAccepted), (
        f"an already-satisfied removal must be a no-op receipt, got "
        f"{type(retry).__name__} {getattr(retry, 'code', None)} "
        f"{getattr(retry, 'details', None)}"
    )
    assert int(retry.value["version"]) == landed
    read = await task_space_fixture.read_work_item(work_item_id)
    assert int(read["version"]) == landed
    assert _labels(read) == [label_b.entity_id]
    assert await task_space_fixture.visible_events(operation_id="d2-sc-retry") == ()


@pytest.mark.asyncio
async def test_complement_is_taken_from_the_addressed_set_not_the_payload(
    task_space_fixture,
) -> None:
    """The equality is computed against the ADDRESSED set, never the payload shape.

    Addressing B while declaring {A} (current={A,B}) is the mirror image of the
    converging case: ``current - {B} == {A}`` holds, so it must be accepted. This
    pins that the compiler derives the complement from ``require_removed_label_ids``
    rather than from any heuristic about the declared set.
    """
    label_a = await create_label(task_space_fixture, command_id="d2-cx-a", name="A")
    label_b = await create_label(task_space_fixture, command_id="d2-cx-b", name="B")
    project = await task_space_fixture.create_project(
        command_id="d2-cx-proj", key="DC"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"], "Item", None, "d2-cx-item"
    )
    work_item_id = item.value["id"]
    seeded = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        add_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-cx-seed",
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            label_ids=[label_a.entity_id, label_b.entity_id],
        ),
    )
    version = int(seeded.value["version"])

    # Address B (not A) while declaring {A}: current - {B} == {A} => accepted.
    # The commandId must not collide with any earlier command: "d2-cx-b" already
    # bound the label-creation request above, and reusing it here would be an
    # idempotency_conflict rather than a test of the equality rule.
    addressed_b = await task_space_fixture.module.execute(
        task_space_fixture.scope,
        remove_labels_command(
            space_id=task_space_fixture.space_id,
            command_id="d2-cx-remove-b",
            work_item_id=work_item_id,
            expected_version=version,
            label_ids=[label_a.entity_id],
            require_removed_label_ids=[label_b.entity_id],
        ),
    )
    assert isinstance(addressed_b, TaskSpaceAccepted), (
        f"current={{A,B}}, address B, declared {{A}} must be accepted, got "
        f"{type(addressed_b).__name__} {getattr(addressed_b, 'code', None)}"
    )
    assert int(addressed_b.value["version"]) == version + 1
    assert _labels(addressed_b.value) == [label_a.entity_id]
    read = await task_space_fixture.read_work_item(work_item_id)
    assert _labels(read) == [label_a.entity_id]
    assert int(read["version"]) == version + 1
    events = await task_space_fixture.visible_events(operation_id="d2-cx-remove-b")
    assert len(events) == 1
