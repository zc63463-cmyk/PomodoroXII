"""TS-02 REST 批量写 MVP —— 领域验收（roadmap §5 TS-02）。

按计划「实施与验收顺序」，先为验收表每组可观察行为固定失败用例：

- 按输入顺序编译；后项可见前面已接受命令的 overlay；前项被拒不向
  后面的 overlay 添加事实（不要求多次 HTTP 往返）。
- 允许部分业务接受；接受集合由现有 UoW 提交/恢复/账本可见性管理，
  不新增 ``atomic=true``。
- 同一工作项连续更新时正确串接版本；回执分别保留当时的持久结果
  （v2 与 v3 可区分），不查询当前行冒充每一步结果。
- 预拒（invalid payload hash）同样进入持久回执；后项依赖被拒前项时
  按权威状态拒绝，看不到不存在的「成功」对象。
- 相同批次重试返回相同终态回执，零重复账本事件；改 payload、调换
  顺序、跨 batch 复用 commandId 按既有幂等规则稳定拒绝。
- 提交/投影间中断后恢复：接受集合可见，不产生重复账本事件。

领域契约：``TaskSpaceBatchCommandModule.execute_batch`` 使用
``PreparedBatchItem`` 进入 ``MutationUnitOfWork.execute_prepared_batch``，
绝不循环调用单条 ``execute`` 冒充批量。
"""
from __future__ import annotations

from dataclasses import fields, replace
from typing import get_type_hints

import pytest

from app.errors import IdempotencyConflictError, ValidationError
from app.mutation.types import canonical_payload_hash
from app.task_space.batch import (
    BATCH_DUPLICATE_IDS_MESSAGE,
    BATCH_EMPTY_MESSAGE,
)
from app.task_space.compiler import _stable_id
from app.task_space.contracts import (
    CreateWorkItem,
    LabelCommand,
    MutateWorkItem,
    RelationCommand,
    TaskSpaceAccepted,
    TaskSpaceBatchCommandModule,
    TaskSpaceBatchItemOutcome,
    TaskSpaceBatchOutcome,
    TaskSpaceCommand,
    TaskSpaceCommandModule,
    TaskSpaceRejected,
)
from app.task_space.contracts import (
    relation_id as derive_relation_id,
)
from app.task_space.module import DefaultTaskSpaceCommandModule
from tests.task_space_fixture import TaskSpaceFixture

# --------------------------------------------------------------------------- #
# Command builders（与在线 REST 路由完全相同的构造路径）
# --------------------------------------------------------------------------- #


def _update_command(
    fixture: TaskSpaceFixture,
    command_id: str,
    work_item_id: str,
    expected_version: int,
    patch: dict[str, object],
) -> MutateWorkItem:
    business = {"patch": patch}
    return MutateWorkItem(
        command_id=command_id,
        space_id=fixture.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": "update", **business},
    )


def _relation_command(
    fixture: TaskSpaceFixture,
    operation: str,
    command_id: str,
    from_work_item_id: str,
    to_work_item_id: str,
    expected_version: int | None,
) -> RelationCommand:
    return RelationCommand(
        operation=operation,
        command_id=command_id,
        space_id=fixture.space_id,
        relation_id=derive_relation_id(
            fixture.space_id, from_work_item_id, to_work_item_id, "depends_on"
        ),
        from_work_item_id=from_work_item_id,
        to_work_item_id=to_work_item_id,
        relation_type="depends_on",
        expected_version=expected_version,
        payload_hash=canonical_payload_hash({
            "from_work_item_id": from_work_item_id,
            "to_work_item_id": to_work_item_id,
            "relation_type": "depends_on",
        }),
    )


def _label_create_command(
    fixture: TaskSpaceFixture, command_id: str, name: str
) -> LabelCommand:
    payload = {"name": name, "color": None}
    return LabelCommand(
        operation="create",
        command_id=command_id,
        space_id=fixture.space_id,
        label_id=None,
        expected_version=None,
        payload_hash=canonical_payload_hash(payload),
        payload=payload,
    )


def _labels_command(
    fixture: TaskSpaceFixture,
    operation: str,
    command_id: str,
    work_item_id: str,
    expected_version: int,
    label_ids: list[str],
) -> MutateWorkItem:
    business = {"label_ids": sorted(label_ids)}
    return MutateWorkItem(
        command_id=command_id,
        space_id=fixture.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": operation, **business},
    )


def _corrupted_hash_command(
    fixture: TaskSpaceFixture, command_id: str, project_id: str, title: str
) -> CreateWorkItem:
    """A create command whose declared payload hash does not match content."""
    command = fixture.create_work_item_command(
        command_id=command_id, project_id=project_id, title=title, parent_id=None
    )
    from dataclasses import replace

    return replace(command, payload_hash="0" * 64)


# --------------------------------------------------------------------------- #
# Outcome helpers
# --------------------------------------------------------------------------- #


def _batch_module(fixture: TaskSpaceFixture):
    from app.task_space.batch import DefaultTaskSpaceBatchCommandModule

    return DefaultTaskSpaceBatchCommandModule(fixture.uow)


async def _run_batch(fixture: TaskSpaceFixture, batch_id: str, commands: tuple):
    return await _batch_module(fixture).execute_batch(
        fixture.scope, commands, batch_id
    )


def _accepted_items(outcome: TaskSpaceBatchOutcome) -> list[TaskSpaceAccepted]:
    return [
        item.outcome
        for item in outcome.items
        if isinstance(item.outcome, TaskSpaceAccepted)
    ]


def _rejected_items(outcome: TaskSpaceBatchOutcome) -> list[TaskSpaceRejected]:
    return [
        item.outcome
        for item in outcome.items
        if isinstance(item.outcome, TaskSpaceRejected)
    ]


def _receipt_shape(outcome: TaskSpaceBatchOutcome) -> list[tuple[str, str]]:
    """(commandId, kind-of-outcome or rejection code) per input position."""
    shape: list[tuple[str, str]] = []
    for item in outcome.items:
        if isinstance(item.outcome, TaskSpaceAccepted):
            shape.append((item.outcome.command_id, "accepted"))
        else:
            shape.append((item.outcome.command_id, item.outcome.code))
    return shape


# --------------------------------------------------------------------------- #
# Contract shape tests
# --------------------------------------------------------------------------- #


def test_batch_protocol_and_outcome_types_are_closed() -> None:
    """批量协议有唯一写入口；结果类型按输入位置排列且关联原单条结果。"""
    from app.runtime.space import SpaceRuntimeHandle

    assert {
        name
        for name, value in TaskSpaceBatchCommandModule.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {"execute_batch"}
    method = get_type_hints(
        TaskSpaceBatchCommandModule.execute_batch,
        globalns={
            **TaskSpaceBatchCommandModule.execute_batch.__globals__,
            "SpaceRuntimeHandle": SpaceRuntimeHandle,
        },
    )
    assert method["commands"] == tuple[TaskSpaceCommand, ...]
    assert method["return"] is TaskSpaceBatchOutcome
    assert {field.name for field in fields(TaskSpaceBatchOutcome)} == {
        "batch_id",
        "items",
    }
    assert {field.name for field in fields(TaskSpaceBatchItemOutcome)} == {
        "input_index",
        "outcome",
    }
    # 单条协议保持原样：只实现 execute 的既有 mock 不需要实现批量接口。
    assert {
        name
        for name, value in TaskSpaceCommandModule.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {"execute"}


@pytest.mark.asyncio
async def test_single_command_module_is_unchanged(task_space_fixture) -> None:
    """单条入口兼容：DefaultTaskSpaceCommandModule 仍是单条协议实现。"""
    module: TaskSpaceCommandModule = task_space_fixture.module
    assert isinstance(module, DefaultTaskSpaceCommandModule)
    command = task_space_fixture.create_project_command(
        command_id="compat-project", key="CP"
    )
    accepted = await task_space_fixture.module.execute(
        task_space_fixture.scope, command
    )
    assert isinstance(accepted, TaskSpaceAccepted)


# --------------------------------------------------------------------------- #
# 批内创建上游/下游后建边 —— 后面的建边可读取已接受的前项
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_compiles_in_input_order_and_edges_read_the_overlay(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="ov-project", key="OV")
    project_id = str(project.value["id"])

    upstream_id = _stable_id("work_item", "ov-upstream")
    downstream_id = _stable_id("work_item", "ov-downstream")
    commands = (
        fixture.create_work_item_command(
            command_id="ov-upstream", project_id=project_id, title="Up", parent_id=None
        ),
        fixture.create_work_item_command(
            command_id="ov-downstream", project_id=project_id, title="Down", parent_id=None
        ),
        _relation_command(
            fixture, "create", "ov-edge", downstream_id, upstream_id, None
        ),
    )
    outcome = await _run_batch(fixture, "ov-batch", commands)

    assert outcome.batch_id == "ov-batch"
    assert _receipt_shape(outcome) == [
        ("ov-upstream", "accepted"),
        ("ov-downstream", "accepted"),
        ("ov-edge", "accepted"),
    ]
    assert [item.input_index for item in outcome.items] == [0, 1, 2]
    # 建 edge 读取的是 overlay 里本批创建的行（不是预先存在的行）。
    edge = _accepted_items(outcome)[2]
    assert edge.entity_type == "relation"
    assert edge.entity_id == derive_relation_id(
        fixture.space_id, downstream_id, upstream_id, "depends_on"
    )
    relations = await fixture.queries.list_relations(
        fixture.scope, downstream_id
    )
    assert any(row["id"] == edge.entity_id for row in relations)
    downstream = await fixture.read_work_item(downstream_id)
    assert downstream["title"] == "Down"
    events = await fixture.visible_events(batch_id="ov-batch")
    assert any(
        event.entity_type == "relation" and event.entity_id == edge.entity_id
        for event in events
    )


# --------------------------------------------------------------------------- #
# 三条中间版本冲突 —— 回执包含三条各自结果；成功项存在、失败项无副作用
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_partial_acceptance_middle_version_conflict(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="mc-project", key="MC")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(
        project_id, "Seed", None, "mc-seed"
    )
    work_item_id = str(item.value["id"])

    commands = (
        _update_command(
            fixture, "mc-win", work_item_id, 1, {"title": "Patch A"}
        ),
        _update_command(
            fixture, "mc-conflict", work_item_id, 1, {"title": "Patch B"}
        ),
        fixture.create_work_item_command(
            command_id="mc-create", project_id=project_id, title="Later", parent_id=None
        ),
    )
    outcome = await _run_batch(fixture, "mc-batch", commands)

    assert _receipt_shape(outcome) == [
        ("mc-win", "accepted"),
        ("mc-conflict", "version_conflict"),
        ("mc-create", "accepted"),
    ]
    conflict = _rejected_items(outcome)[0]
    assert conflict.code == "version_conflict"
    # 编译器 version_conflict 的稳定细节：overlay 当前版本（不是请求字段）。
    assert conflict.details == {"current_version": 2}

    # 成功项存在、失败项无副作用。
    row = await fixture.read_work_item(work_item_id)
    assert row["title"] == "Patch A"
    assert row["version"] == 2
    created = _accepted_items(outcome)[1]
    assert created.entity_id == _stable_id("work_item", "mc-create")
    later = await fixture.read_work_item(created.entity_id)
    assert later["title"] == "Later"


# --------------------------------------------------------------------------- #
# 同实体连续两次更新 —— 正确串接版本，回执分别保留对应版本与 post-image
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_consecutive_updates_concatenate_versions(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="cc-project", key="CC")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(project_id, "Seed", None, "cc-seed")
    work_item_id = str(item.value["id"])

    commands = (
        _update_command(
            fixture, "cc-first", work_item_id, 1, {"title": "Second"}
        ),
        _update_command(
            fixture, "cc-second", work_item_id, 2, {"title": "Third"}
        ),
    )
    outcome = await _run_batch(fixture, "cc-batch", commands)

    assert _receipt_shape(outcome) == [("cc-first", "accepted"), ("cc-second", "accepted")]
    first, second = _accepted_items(outcome)
    # 回执是各命令当时的持久结果：v2 与 v3 可区分，不是当前行快照。
    assert int(first.value["version"]) == 2
    assert str(first.value["title"]) == "Second"
    assert int(second.value["version"]) == 3
    assert str(second.value["title"]) == "Third"
    row = await fixture.read_work_item(work_item_id)
    assert row["title"] == "Third"
    assert row["version"] == 3


# --------------------------------------------------------------------------- #
# 批内前项拒绝、后项依赖它 —— 后项按权威状态拒绝；预拒进入持久回执
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_pre_rejected_upstream_rejects_dependent_edge(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="pr-project", key="PR")
    project_id = str(project.value["id"])
    # 客户端预先推导的「将创建」工作项 ID（与单条 create 的推导一致）。
    hoped_id = _stable_id("work_item", "pr-create")

    commands = (
        _corrupted_hash_command(fixture, "pr-create", project_id, "Ghost"),
        _relation_command(fixture, "create", "pr-edge", hoped_id, hoped_id, None),
    )
    outcome = await _run_batch(fixture, "pr-batch", commands)

    # 权威状态里不存在该工作项 → not_found（存在性先于自环/环检测）。
    assert _receipt_shape(outcome) == [
        ("pr-create", "invalid_payload_hash"),
        ("pr-edge", "not_found"),
    ]
    rejected = _rejected_items(outcome)
    assert rejected[0].retryable is False
    # 不存在「成功」对象：接受集合为空，无任何账本事件。
    assert _accepted_items(outcome) == []
    assert await fixture.visible_events(batch_id="pr-batch") == ()

    # 预拒进入持久回执：同一批重放返回相同回执（可重放证据）。
    replay = await _run_batch(fixture, "pr-batch", commands)
    assert _receipt_shape(replay) == _receipt_shape(outcome)


# --------------------------------------------------------------------------- #
# 断线重试 —— 返回相同终态回执，零重复事件
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_replay_returns_identical_receipt_without_duplicate_events(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="rp-project", key="RP")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(project_id, "Seed", None, "rp-seed")
    work_item_id = str(item.value["id"])

    commands = (
        _update_command(
            fixture, "rp-update", work_item_id, 1, {"title": "Replayed"}
        ),
        _corrupted_hash_command(fixture, "rp-bad", project_id, "Bad"),
        fixture.create_work_item_command(
            command_id="rp-create", project_id=project_id, title="New", parent_id=None
        ),
    )
    outcome = await _run_batch(fixture, "rp-batch", commands)
    assert _receipt_shape(outcome) == [
        ("rp-update", "accepted"),
        ("rp-bad", "invalid_payload_hash"),
        ("rp-create", "accepted"),
    ]
    def _work_item_events(events):
        # 账本存的是 wire 实体名（registry 的 sync_entity_type），work_item → "workItem"。
        return [event for event in events if event.entity_type == "workItem"]

    events_before = _work_item_events(
        await fixture.visible_events(batch_id="rp-batch")
    )
    # rp-seed 的 update 事件 + rp-create 的 create 事件；被拒项零事件。
    assert sorted(event.action for event in events_before) == ["create", "update"]

    replay = await _run_batch(fixture, "rp-batch", commands)
    assert _receipt_shape(replay) == _receipt_shape(outcome)
    assert [item.input_index for item in replay.items] == [0, 1, 2]
    assert _accepted_items(replay) == _accepted_items(outcome)
    assert _rejected_items(replay) == _rejected_items(outcome)
    assert _work_item_events(
        await fixture.visible_events(batch_id="rp-batch")
    ) == events_before


# --------------------------------------------------------------------------- #
# 全部拒绝后重试 —— 相同终态回执，全部拒绝也有可重放证据
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_all_rejected_replay_is_stable_evidence(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="ar-project", key="AR")
    project_id = str(project.value["id"])

    commands = (
        _corrupted_hash_command(fixture, "ar-bad-1", project_id, "Bad 1"),
        _corrupted_hash_command(fixture, "ar-bad-2", project_id, "Bad 2"),
    )
    outcome = await _run_batch(fixture, "ar-batch", commands)
    assert _receipt_shape(outcome) == [
        ("ar-bad-1", "invalid_payload_hash"),
        ("ar-bad-2", "invalid_payload_hash"),
    ]
    assert await fixture.visible_events(batch_id="ar-batch") == ()

    replay = await _run_batch(fixture, "ar-batch", commands)
    assert _receipt_shape(replay) == _receipt_shape(outcome)
    assert await fixture.visible_events(batch_id="ar-batch") == ()


# --------------------------------------------------------------------------- #
# 改 payload、调换顺序、跨 batch 复用 ID —— 按既有幂等规则稳定拒绝
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_idempotency_bindings_reject_changed_content(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="ib-project", key="IB")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(project_id, "Seed", None, "ib-seed")
    work_item_id = str(item.value["id"])

    # 原批：两条对同一工作项的更新（依赖批内 overlay 串接版本）。
    commands = (
        _update_command(
            fixture, "ib-a", work_item_id, 1, {"title": "Second"}
        ),
        _update_command(
            fixture, "ib-b", work_item_id, 2, {"title": "Third"}
        ),
    )
    outcome = await _run_batch(fixture, "ib-batch", commands)
    assert _receipt_shape(outcome) == [("ib-a", "accepted"), ("ib-b", "accepted")]

    # 改 payload：同一 batchId 承载不同内容 → 稳定拒绝。
    changed = (
        _update_command(
            fixture, "ib-a", work_item_id, 1, {"title": "Tampered"}
        ),
        commands[1],
    )
    with pytest.raises(IdempotencyConflictError):
        await _run_batch(fixture, "ib-batch", changed)

    # 调换顺序：同 batchId、同内容、不同顺序 → 稳定拒绝。
    with pytest.raises(IdempotencyConflictError):
        await _run_batch(fixture, "ib-batch", (commands[1], commands[0]))

    # 跨 batch 复用 commandId：单条请求的 ID 不能任意搬进新批次。
    with pytest.raises(IdempotencyConflictError) as excinfo:
        await _run_batch(fixture, "ib-other-batch", (commands[0],))
    assert excinfo.value.details["existing_batch_id"] == "ib-batch"

    # 原批重放仍然幂等：返回相同终态回执。
    replay = await _run_batch(fixture, "ib-batch", commands)
    assert _receipt_shape(replay) == _receipt_shape(outcome)


@pytest.mark.asyncio
async def test_batch_pre_rejection_binding_covers_version_and_space(
    task_space_fixture,
) -> None:
    """预拒项的幂等绑定与正常项同等严格：内容 + expectedVersion + spaceId。

    预拒项没有合法请求，但它的 intent 取「跳过 hash 比对时算出的 request_hash」，
    因此只改 ``expectedVersion``（或 ``spaceId``）而保留同一个错 hash 的重试，
    会得到不同的批哈希，按「改变内容」稳定拒绝 —— 不会命中旧回执。
    """
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="pb-project", key="PB")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(project_id, "Seed", None, "pb-seed")
    work_item_id = str(item.value["id"])

    corrupted = replace(
        _update_command(fixture, "pb-bad", work_item_id, 1, {"title": "X"}),
        payload_hash="0" * 64,
    )
    outcome = await _run_batch(fixture, "pb-batch", (corrupted,))
    assert _receipt_shape(outcome) == [("pb-bad", "invalid_payload_hash")]

    # 同内容重放：同一终态回执（预拒也有可重放证据）。
    replay = await _run_batch(fixture, "pb-batch", (corrupted,))
    assert _receipt_shape(replay) == _receipt_shape(outcome)
    assert _rejected_items(replay) == _rejected_items(outcome)

    # 只改 expectedVersion：内容变了 → 稳定拒绝。
    with pytest.raises(IdempotencyConflictError):
        await _run_batch(
            fixture, "pb-batch", (replace(corrupted, expected_version=7),)
        )

    # 只改 spaceId：同样拒绝（不命中原回执、也不写目标空间）。
    with pytest.raises(IdempotencyConflictError):
        await _run_batch(
            fixture, "pb-batch", (replace(corrupted, space_id="other-space"),)
        )


# --------------------------------------------------------------------------- #
# FINALIZED 前后与恢复 —— 未完成批的事件不可见；恢复完成后接受集合可见
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_recovery_after_commit_fault_completes_once(
    task_space_fixture,
) -> None:
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="rc-project", key="RC")
    project_id = str(project.value["id"])

    commands = (
        fixture.create_work_item_command(
            command_id="rc-create", project_id=project_id, title="Recovered", parent_id=None
        ),
    )
    fixture.mutation.inject_fault("db_commit")
    with pytest.raises(RuntimeError, match="injected db commit failure"):
        await _run_batch(fixture, "rc-batch", commands)

    # 中断后的接受集合在恢复完成前不可见（未完成批的事件不可见）。
    assert await fixture.visible_events(batch_id="rc-batch") == ()
    await fixture.mutation.recover()

    outcome = await _run_batch(fixture, "rc-batch", commands)
    assert _receipt_shape(outcome) == [("rc-create", "accepted")]
    created = _accepted_items(outcome)[0]
    row = await fixture.read_work_item(created.entity_id)
    assert row["title"] == "Recovered"

    # 恢复 + 重放不产生重复账本事件：每个实体恰好一条 create 事件。
    events = await fixture.visible_events(batch_id="rc-batch")
    creates = [
        event for event in events if event.entity_id == created.entity_id
    ]
    assert len(creates) == 1
    assert creates[0].action == "create"


@pytest.mark.asyncio
async def test_batch_recovery_after_commit_window_fault_completes_once(
    task_space_fixture,
) -> None:
    """中断点在「业务事务已提交、finalize 未完成」窗口内（而非更早）。

    计划 TS-02 实施顺序要求注入提交/投影之间的中断。任务空间命令不携带文件
    投影（编译器只为 Note/Folder 产出 projections），因此 ``projection_forward``
    故障对该批不可达；等价且可复现的点是 ``_finalize_forward``（``mark_finalizing``
    之后、可见性翻转之前）：提交已落库、事件仍不可见。恢复走
    FINALIZING → FORWARD_APPLIED → FINALIZED 分支，重放必须命中同一条持久回执。
    """
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="fw-project", key="FW")
    project_id = str(project.value["id"])
    commands = (
        fixture.create_work_item_command(
            command_id="fw-create", project_id=project_id, title="Windowed", parent_id=None
        ),
    )
    await fixture.create_work_item(project_id, "Seed", None, "fw-seed")

    original = fixture.uow._finalize_forward

    async def fail_once(*args, **kwargs):
        fixture.uow._finalize_forward = original
        raise RuntimeError("injected finalize failure")

    fixture.uow._finalize_forward = fail_once
    with pytest.raises(RuntimeError, match="injected finalize failure"):
        await _run_batch(fixture, "fw-batch", commands)

    # 事务已提交，但批未 finalize：事件仍不可见。
    assert await fixture.visible_events(batch_id="fw-batch") == ()
    await fixture.mutation.recover()

    outcome = await _run_batch(fixture, "fw-batch", commands)
    assert _receipt_shape(outcome) == [("fw-create", "accepted")]
    created = _accepted_items(outcome)[0]
    row = await fixture.read_work_item(created.entity_id)
    assert row["title"] == "Windowed"
    events = await fixture.visible_events(batch_id="fw-batch")
    assert [
        event.action for event in events if event.entity_id == created.entity_id
    ] == ["create"]


# --------------------------------------------------------------------------- #
# 跨 Space / label 投影 —— 原有不变量保持
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_label_projection_chains_through_overlay(
    task_space_fixture,
) -> None:
    """Batch label commands declare the full target set (TS-02a / 裁决一).

    The batch entry reuses the single-command payload semantics: ``label_ids``
    is the set expected AFTER the command, add may only keep/add and remove may
    only keep/drop.  A batch-internal Add then Remove therefore ends at the
    set the last item declared, and each receipt keeps its own step version.
    """
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="lb-project", key="LB")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(project_id, "Seed", None, "lb-seed")
    work_item_id = str(item.value["id"])
    await fixture.module.execute(
        fixture.scope, _label_create_command(fixture, "lb-label", "urgent")
    )
    label_id = _stable_id("label", "lb-label")

    commands = (
        _labels_command(
            fixture, "add_labels", "lb-add", work_item_id, 1, [label_id]
        ),
        # The later item sees the set the earlier accepted item left behind
        # ({L}) and declares the post-removal target ({}).
        _labels_command(
            fixture, "remove_labels", "lb-remove", work_item_id, 2, []
        ),
    )
    outcome = await _run_batch(fixture, "lb-batch", commands)

    assert _receipt_shape(outcome) == [
        ("lb-add", "accepted"),
        ("lb-remove", "accepted"),
    ]
    added, removed = _accepted_items(outcome)
    # 回执是各命令当时的持久结果：add 后 v2、remove 后 v3，可区分。
    assert int(added.value["version"]) == 2
    assert list(added.value["label_ids"]) == [label_id]
    assert int(removed.value["version"]) == 3
    assert list(removed.value["label_ids"]) == []
    row = await fixture.read_work_item(work_item_id)
    assert list(row["label_ids"]) == []
    assert int(row["version"]) == 3


@pytest.mark.asyncio
async def test_batch_label_commands_never_cross_the_operation_direction(
    task_space_fixture,
) -> None:
    """A direction-crossing item is rejected per-item; the batch keeps going."""
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="lbd-project", key="LBD")
    project_id = str(project.value["id"])
    item = await fixture.create_work_item(project_id, "Seed", None, "lbd-seed")
    work_item_id = str(item.value["id"])
    await fixture.module.execute(
        fixture.scope, _label_create_command(fixture, "lbd-a", "A")
    )
    await fixture.module.execute(
        fixture.scope, _label_create_command(fixture, "lbd-b", "B")
    )
    label_a = _stable_id("label", "lbd-a")
    label_b = _stable_id("label", "lbd-b")

    commands = (
        _labels_command(
            fixture, "add_labels", "lbd-add", work_item_id, 1, [label_a, label_b]
        ),
        # Add declaring {B} would silently drop A -> refused at its own position.
        _labels_command(
            fixture, "add_labels", "lbd-shrink", work_item_id, 2, [label_b]
        ),
        # Remove declaring {A,B} keeps both -> a no-op receipt at that position.
        _labels_command(
            fixture, "remove_labels", "lbd-noop", work_item_id, 2, [label_a, label_b]
        ),
    )
    outcome = await _run_batch(fixture, "lbd-batch", commands)

    assert _receipt_shape(outcome) == [
        ("lbd-add", "accepted"),
        ("lbd-shrink", "label_set_direction_violated"),
        ("lbd-noop", "accepted"),
    ]
    accepted = _accepted_items(outcome)
    assert int(accepted[0].value["version"]) == 2
    assert list(accepted[0].value["label_ids"]) == sorted([label_a, label_b])
    # The no-op item keeps the version the accept left behind: no bump, no event.
    assert int(accepted[1].value["version"]) == 2
    assert list(accepted[1].value["label_ids"]) == sorted([label_a, label_b])
    rejection = _rejected_items(outcome)[0]
    assert rejection.retryable is False
    assert tuple(rejection.details["would_remove"]) == (label_a,)
    row = await fixture.read_work_item(work_item_id)
    assert list(row["label_ids"]) == sorted([label_a, label_b])
    assert int(row["version"]) == 2
    # Exactly one label-bearing workItem event for the whole batch (the add):
    # refused and no-op items contribute nothing.
    events = await fixture.visible_events(batch_id="lbd-batch")
    label_events = [
        event for event in events if event.entity_type == "workItem"
    ]
    assert len(label_events) == 1
    assert label_events[0].payload["label_ids"] == sorted([label_a, label_b])
    assert await fixture.visible_events(operation_id="lbd-shrink") == ()
    assert await fixture.visible_events(operation_id="lbd-noop") == ()


@pytest.mark.asyncio
async def test_batch_foreign_space_command_is_rejected_by_domain(
    task_space_fixture,
) -> None:
    """跨空间内容是领域防线之一：scope 之外的命令按 space_scope_mismatch 拒绝。"""
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="fs-project", key="FS")
    project_id = str(project.value["id"])

    foreign = replace(
        fixture.create_work_item_command(
            command_id="fs-create", project_id=project_id, title="X", parent_id=None
        ),
        space_id="other-space",
    )
    outcome = await _run_batch(fixture, "fs-batch", (foreign,))
    assert _receipt_shape(outcome) == [("fs-create", "space_scope_mismatch")]


# --------------------------------------------------------------------------- #
# 跨 Space/归档冻结/label 投影/边确认 —— 原有不变量全部保持
# --------------------------------------------------------------------------- #


def _trash_command(
    fixture: TaskSpaceFixture, command_id: str, work_item_id: str, expected_version: int
) -> MutateWorkItem:
    """Trash one work item (server stamps ``archived_at``; payload is empty)."""
    return MutateWorkItem(
        command_id=command_id,
        space_id=fixture.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash({}),
        payload={"operation": "trash"},
    )


@pytest.mark.asyncio
async def test_batch_archived_endpoint_blocks_edge_while_sibling_succeeds(
    task_space_fixture,
) -> None:
    """归档冻结（D17）：批内建边若触碰已归档端点被拒，同批其它命令照常接受。"""
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="af-project", key="AF")
    project_id = str(project.value["id"])
    archived = await fixture.create_work_item(project_id, "Archived", None, "af-archived")
    archived_id = str(archived.value["id"])
    other = await fixture.create_work_item(project_id, "Live", None, "af-live")
    other_id = str(other.value["id"])
    trashed = await fixture.module.execute(
        fixture.scope, _trash_command(fixture, "af-trash", archived_id, 1)
    )
    assert isinstance(trashed, TaskSpaceAccepted)
    assert trashed.value["archived_at"] is not None

    commands = (
        _relation_command(fixture, "create", "af-edge", other_id, archived_id, None),
        fixture.create_work_item_command(
            command_id="af-new", project_id=project_id, title="Sibling", parent_id=None
        ),
    )
    outcome = await _run_batch(fixture, "af-batch", commands)

    assert _receipt_shape(outcome) == [
        ("af-edge", "archived_work_item_immutable"),
        ("af-new", "accepted"),
    ]
    # 冻结端点的边没有被写入：关系表里没有这条边。
    rows = await fixture.queries.list_relations(fixture.scope, archived_id)
    assert all(row["id"] != derive_relation_id(
        fixture.space_id, other_id, archived_id, "depends_on"
    ) for row in rows)
    # 同批的兄弟命令照常落库（部分接受，不是整批回滚）。
    sibling = await fixture.read_work_item(_stable_id("work_item", "af-new"))
    assert sibling["title"] == "Sibling"


@pytest.mark.asyncio
async def test_batch_edge_confirmation_is_idempotent_across_batches(
    task_space_fixture,
) -> None:
    """边确认（D2 / ADR-0004）：批内建边 → 批内确认 → 重复确认是零效果回执。"""
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="ec-project", key="EC")
    project_id = str(project.value["id"])
    upstream = await fixture.create_work_item(project_id, "Up", None, "ec-up")
    upstream_id = str(upstream.value["id"])
    downstream = await fixture.create_work_item(project_id, "Down", None, "ec-down")
    downstream_id = str(downstream.value["id"])
    edge_id = derive_relation_id(
        fixture.space_id, downstream_id, upstream_id, "depends_on"
    )

    created = await _run_batch(
        fixture,
        "ec-create-batch",
        (_relation_command(fixture, "create", "ec-edge", downstream_id, upstream_id, None),),
    )
    assert _receipt_shape(created) == [("ec-edge", "accepted")]
    edge_version = int(_accepted_items(created)[0].value["version"])

    confirmed = await _run_batch(
        fixture,
        "ec-resolve-batch",
        (
            _relation_command(
                fixture, "resolve", "ec-resolve", downstream_id, upstream_id, edge_version
            ),
        ),
    )
    assert _receipt_shape(confirmed) == [("ec-resolve", "accepted")]
    accepted = _accepted_items(confirmed)[0]
    assert accepted.value["resolution"] == "confirmed_not_required"
    assert accepted.value["resolved_at"] is not None
    resolved_version = int(accepted.value["version"])
    assert resolved_version == edge_version + 1

    # 重复确认：幂等零效果回执（无 version bump、无新账本事件）。
    events_before = await fixture.visible_events(batch_id="ec-resolve-batch")
    repeated = await _run_batch(
        fixture,
        "ec-resolve-again-batch",
        (
            _relation_command(
                fixture,
                "resolve",
                "ec-resolve-again",
                downstream_id,
                upstream_id,
                resolved_version,
            ),
        ),
    )
    assert _receipt_shape(repeated) == [("ec-resolve-again", "accepted")]
    assert int(_accepted_items(repeated)[0].value["version"]) == resolved_version
    assert await fixture.visible_events(batch_id="ec-resolve-again-batch") == ()
    assert await fixture.visible_events(batch_id="ec-resolve-batch") == events_before
    rows = await fixture.queries.list_relations(fixture.scope, downstream_id)
    row = next(item for item in rows if item["id"] == edge_id)
    assert row["resolution"] == "confirmed_not_required"


# --------------------------------------------------------------------------- #
# 领域入口的封闭性 —— 空批 / 重复 commandId 失败响亮
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_domain_entry_rejects_empty_and_duplicate_ids(
    task_space_fixture,
) -> None:
    """结构性拒绝给出稳定错误码（不是裸 ValueError），供 MCP 等入口直接映射。"""
    fixture = task_space_fixture
    project = await fixture.create_project(command_id="de-project", key="DE")
    project_id = str(project.value["id"])
    command = fixture.create_work_item_command(
        command_id="de-one", project_id=project_id, title="One", parent_id=None
    )

    with pytest.raises(ValidationError, match="non-empty") as empty:
        await _run_batch(fixture, "de-empty", ())
    assert str(empty.value) == BATCH_EMPTY_MESSAGE
    assert empty.value.code == "validation_error"
    assert empty.value.status_code == 422

    with pytest.raises(ValidationError, match="unique") as duplicate:
        await _run_batch(fixture, "de-dup", (command, command))
    assert str(duplicate.value) == BATCH_DUPLICATE_IDS_MESSAGE
    assert duplicate.value.code == "validation_error"
