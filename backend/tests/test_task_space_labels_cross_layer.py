"""TS-02a cross-layer regression: the frontend's real wire request in a real UoW.

裁决一「最低验收」明确要求：*前端真实生成的请求进入真实后端命令/UoW 后结果正确，
不能只分别测试前端 mock 和后端手写 payload*。本模块就是那条链路：

1. 夹具 ``tests/cross_layer_label_requests.json`` 由**前端自己的** wire 构造器
   （``frontend/src/services/task-space-api.ts``）真实发送一次并 spy 抓取生成，
   连同前端自己算出的 RFC 8785 canonical payload hash 一起落盘；
   生成器：``frontend/src/__tools__/dump-pxii-label-requests.test.ts``。
2. 夹具带**生成来源标记**（``generated_by`` / ``generator`` / ``wire_source`` /
   ``extraction``），且每条请求都同时记录前端声明的 hash —— 因此夹具与前端实现
   漂移时会失败，而不是静默继续。
3. 后端用**真实的** Task Space 命令模块 + 真实 ``MutationUnitOfWork`` 执行这些
   请求（单条 REST 路径与 ``commands:batch`` 路径各一条）。
4. 断言最终 junction 集合、work_item 版本与账本事件 —— 前端声明的是完整目标
   集合，后端必须精确收敛到它。

标签 id 由服务端派生（``labels.id`` 取决于创建命令的 commandId），前端只是持有
缓存值。夹具因此用别名 + ``label_aliases`` 解析表，并由本模块在真实创建标签后
**校验该映射确实成立**（不成立即失败），而不是在夹具里编造 id。

夹具刷新（仅在确实改了前端 wire 形状之后）：

    cd frontend && npx vitest run src/__tools__/dump-pxii-label-requests.test.ts

⚠️ 若因夹具过期而失败，用上面的命令重新生成；**不要**手改夹具里的 hash 或
labelIds 让断言过关 —— 那等于把「两端各自独立 mock」重新引入。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.mutation.types import canonical_payload_hash, validate_operation_id
from app.task_space.batch import DefaultTaskSpaceBatchCommandModule
from app.task_space.compiler import _stable_id
from app.task_space.contracts import (
    LabelCommand,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpaceBatchOutcome,
)

FIXTURE_PATH = Path(__file__).parent / "cross_layer_label_requests.json"


def load_fixture() -> dict[str, object]:
    """Load the frontend-generated wire fixture, failing closed if absent."""
    assert FIXTURE_PATH.exists(), (
        f"missing frontend-generated fixture: {FIXTURE_PATH}\n"
        "regenerate it with: cd frontend && npx vitest run "
        "src/__tools__/dump-pxii-label-requests.test.ts"
    )
    with FIXTURE_PATH.open("r", encoding="utf-8") as handle:
        fixture = json.load(handle)
    assert isinstance(fixture, dict)
    return fixture


def _single_request(fixture: dict[str, object], name: str) -> dict[str, object]:
    for entry in fixture["single_requests"]:
        if entry["name"] == name:
            return entry
    raise AssertionError(f"no frontend single request named {name!r}")


def _batch_request(fixture: dict[str, object], name: str) -> dict[str, object]:
    for entry in fixture["batches"]:
        if entry["name"] == name:
            return entry
    raise AssertionError(f"no frontend batch named {name!r}")


async def _create_label(fixture, command_id: str, name: str) -> str:
    """Create one real label and return the server-derived id."""
    payload = {"name": name, "color": None}
    command = LabelCommand(
        operation="create",
        command_id=command_id,
        space_id=fixture.space_id,
        label_id=None,
        expected_version=None,
        payload_hash=canonical_payload_hash(payload),
        payload=payload,
    )
    outcome = await fixture.module.execute(fixture.scope, command)
    assert isinstance(outcome, TaskSpaceAccepted)
    return str(outcome.entity_id)


class ResolvedLabels:
    """Alias -> real server-derived label id, verified against ``_stable_id``."""

    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def __getitem__(self, alias: str) -> str:
        return self._mapping[alias]

    def translate(self, label_ids: list[str]) -> list[str]:
        return [self._mapping.get(value, value) for value in label_ids]


async def _resolve_aliases(space, fixture: dict[str, object]) -> ResolvedLabels:
    """Create the fixture's labels for real and prove the alias table holds."""
    aliases = fixture["label_aliases"]
    sources = {"label-a": ("xl-label-a", "A"), "label-b": ("xl-label-b", "B")}
    assert set(aliases) == set(sources)
    mapping: dict[str, str] = {}
    for alias, (command_id, name) in sources.items():
        assert aliases[alias]["source_command_id"] == command_id
        real_id = await _create_label(space, command_id, name)
        # The declared alias must be exactly the id the server derives; a
        # mismatch means the fixture describes something the server cannot
        # produce, so the whole cross-layer claim would be vacuous.
        assert real_id == _stable_id("label", command_id), alias
        mapping[alias] = real_id
    assert len(set(mapping.values())) == len(mapping)
    return ResolvedLabels(mapping)


def _labels_payload(
    entry: dict[str, object], labels: ResolvedLabels
) -> dict[str, object]:
    """The business payload the frontend's envelope implies, with real ids.

    ``spaceId`` is authorization scope, not business content, and label ids are
    server-derived: only the *shape and content* of the declaration comes from
    the fixture.  Everything else is re-derived from the real created rows.
    """
    body = entry["body"]
    business: dict[str, object] = {
        "label_ids": sorted(labels.translate(body["labelIds"]))
    }
    address = entry.get("address_label_id")
    if address is not None:
        business["require_removed_label_ids"] = [labels[address]]
    return business


def _single_domain_command(
    space,
    entry: dict[str, object],
    *,
    work_item_id: str,
    labels: ResolvedLabels,
    expected_version: int,
) -> MutateWorkItem:
    """Rebuild the domain command from the frontend's real wire payload.

    Mirrors ``app/routes/v1/work_items.py`` exactly: path-addressed work item,
    real space scope, and a hash recomputed over the same business payload the
    frontend hashed (its declared hash is asserted equal to this first, so a
    two-sided canonical-hash drift fails rather than passing silently).
    """
    body = entry["body"]
    operation = {"add": "add_labels", "remove": "remove_labels"}[entry["operation"]]
    business = _labels_payload(entry, labels)
    return MutateWorkItem(
        command_id=body["commandId"],
        space_id=space.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": operation, **business},
    )


async def _seed_labels(space, work_item_id: str, label_ids: list[str]) -> int:
    current = await space.read_work_item(work_item_id)
    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="xl-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(current["version"]),
            payload_hash=canonical_payload_hash({"label_ids": sorted(label_ids)}),
            payload={"operation": "add_labels", "label_ids": sorted(label_ids)},
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    return int(seeded.value["version"])


def test_fixture_carries_its_frontend_provenance() -> None:
    """The fixture must state where it came from and how it was extracted.

    Also pins the **regeneration hazard** fix (复审第 2 条): the generator must
    NOT be a vitest-collected ``.test.ts`` under ``frontend/src``. Such a file
    runs on every ``npm test`` and silently rewrites this backend fixture, so a
    frontend wire change would auto-align the fixture and keep the cross-layer
    assertions green — the automated version of "edit the fixture until it
    passes". A standalone ``scripts/*.mjs`` run only when invoked explicitly.
    """
    fixture = load_fixture()
    assert fixture["generated_by"] == "frontend"
    generator = fixture["generator"]
    assert generator == "frontend/scripts/dump-pxii-label-requests.mjs"
    # Not a test file, and not under the vitest include root.
    assert not generator.endswith(".test.ts")
    assert "/src/" not in generator
    assert fixture["generator_invocation"] == "npm run fixtures:label-requests"
    assert "task-space-api.ts" in fixture["wire_source"]
    assert fixture["extraction"] == "spy"
    assert set(fixture["label_aliases"]) == {"label-a", "label-b"}
    for entry in fixture["single_requests"]:
        validate_operation_id(entry["body"]["commandId"])
        assert entry["declared_target_is_cached_row_minus_address"] is True


def test_frontend_generator_is_not_vitest_collected() -> None:
    """Guard the fix structurally, from the repo rather than from the fixture.

    ``npm test`` runs ``vitest run`` with ``include: ["src/**/*.test.ts", ...]``
    (frontend/vitest.config.ts:26). Anything matching that glob runs in CI and
    must therefore never write into the backend repository.
    """
    repo_root = Path(__file__).resolve().parents[2]
    frontend_src = repo_root / "frontend" / "src"
    offenders: list[str] = []
    for path in frontend_src.rglob("*.test.ts*"):
        text = path.read_text(encoding="utf-8")
        # A relative hop out of frontend/ into backend/ is the hazard.
        if "writeFileSync" in text and "../backend/" in text:
            offenders.append(str(path.relative_to(repo_root)))
    assert offenders == [], (
        "vitest-collected tests must not write into the backend repo: "
        f"{offenders}"
    )
    # The standalone generator exists, and lives outside the collected root.
    generator = repo_root / "frontend" / "scripts" / "dump-pxii-label-requests.mjs"
    assert generator.exists()


def test_frontend_declared_hashes_match_the_backend_canonical_payload() -> None:
    """Two-sided hash agreement: the frontend's RFC 8785 hash is ours too.

    The fixture declares the frontend's own hash for each request; recomputing
    it with the backend's canonical business payload proves both sides agree on
    what the business content IS (so the declared set really is the full target
    set).  The address constraint travels in the single-label DELETE payload as
    ``require_removed_label_ids``, so it is part of that hash — but batch
    commands, which have no URL, declare the set alone.
    """
    fixture = load_fixture()
    for entry in fixture["single_requests"]:
        body = entry["body"]
        business: dict[str, object] = {
            "label_ids": sorted(body["labelIds"]),
            # Mirrors app/routes/v1/work_items.py::_labels_command.
            "require_removed_label_ids": [entry["address_label_id"]],
        }
        assert body["payloadHash"] == canonical_payload_hash(business), entry["name"]
    for entry in fixture["batches"]:
        assert entry["batch_has_no_url_address"] is True
        for command in entry["commands"]:
            business = {"label_ids": sorted(command["labelIds"])}
            assert command["payloadHash"] == canonical_payload_hash(business), entry["name"]


@pytest.mark.asyncio
async def test_frontend_remove_request_converges_the_real_junction(
    task_space_fixture,
) -> None:
    """{A,B} minus A: the frontend sends {B}; the real UoW ends at exactly {B}."""
    fixture = load_fixture()
    space = task_space_fixture
    entry = _single_request(fixture, "remove_one_of_two")
    labels = await _resolve_aliases(space, fixture)
    project = await space.create_project(command_id="xl-proj", key="XL")
    item = await space.create_work_item(
        str(project.value["id"]), "Cross layer", None, "xl-item"
    )
    work_item_id = str(item.value["id"])
    version = await _seed_labels(
        space, work_item_id, [labels["label-a"], labels["label-b"]]
    )
    row = await space.read_work_item(work_item_id)
    assert row["label_ids"] == sorted([labels["label-a"], labels["label-b"]])

    # The frontend's declaration is "cached row minus the addressed label".
    assert entry["body"]["labelIds"] == ["label-b"]
    assert entry["address_label_id"] == "label-a"
    assert labels.translate(entry["body"]["labelIds"]) == [labels["label-b"]]

    command = _single_domain_command(
        space, entry, work_item_id=work_item_id, labels=labels,
        expected_version=version,
    )
    outcome = await space.module.execute(space.scope, command)

    assert isinstance(outcome, TaskSpaceAccepted)
    assert int(outcome.value["version"]) == version + 1
    assert list(outcome.value["label_ids"]) == [labels["label-b"]]
    after = await space.read_work_item(work_item_id)
    assert after["label_ids"] == [labels["label-b"]]
    assert int(after["version"]) == version + 1
    events = await space.visible_events(operation_id="xl-remove-1")
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].payload["label_ids"] == [labels["label-b"]]


@pytest.mark.asyncio
async def test_frontend_remove_last_label_request_empties_the_real_junction(
    task_space_fixture,
) -> None:
    """{A} minus A: the frontend declares [], and the server must really delete.

    This is the case the old delta reading got backwards (declaring the empty
    set deleted nothing), and the case the old frontend URL inference turned
    into an empty path segment.
    """
    fixture = load_fixture()
    space = task_space_fixture
    entry = _single_request(fixture, "remove_last_label")
    labels = await _resolve_aliases(space, fixture)
    project = await space.create_project(command_id="xl2-proj", key="X2")
    item = await space.create_work_item(
        str(project.value["id"]), "Last", None, "xl2-item"
    )
    work_item_id = str(item.value["id"])
    version = await _seed_labels(space, work_item_id, [labels["label-a"]])
    assert entry["body"]["labelIds"] == []
    assert entry["address_label_id"] == "label-a"

    command = _single_domain_command(
        space, entry, work_item_id=work_item_id, labels=labels,
        expected_version=version,
    )
    outcome = await space.module.execute(space.scope, command)

    assert isinstance(outcome, TaskSpaceAccepted)
    assert list(outcome.value["label_ids"]) == []
    after = await space.read_work_item(work_item_id)
    assert after["label_ids"] == []
    assert int(after["version"]) == version + 1
    database, _projections = space.overlay_snapshot()
    junction_rows = next(
        (rows for name, rows in database if name == "work_item_label"), ()
    )
    # {A} minus A: the junction row is really gone, not merely hidden.
    assert junction_rows == ()


@pytest.mark.asyncio
async def test_frontend_batch_request_matches_the_single_request_result(
    task_space_fixture,
) -> None:
    """The frontend's batch declaration lands on the same set/version/ledger.

    ★ 本用例的诚实边界（复审第 4 条）：TS-02 首版只交付 API，前端**没有**批量
    适配器，因此不存在「前端真实生成的批量请求」可抓。夹具里的 batches 段由单条
    路由的真实抓取按批量联合体的形状重述，并自认
    ``batch_derived_from: single_route_captures``。
    为不落入「后端手写 payload」的陷阱，这里刻意不做 Python 侧手工拼装：夹具的
    每个命令全部喂进**生产批量入口自己的** wire→domain 转换器
    （``app.routes.v1.task_space_commands._domain_command``），因此被测的领域命令
    是生产路由会构造的那一个，而不是测试另写一份。仅两处在测试侧重定基（均为
    前端缓存占位值的必然结果，且都在夹具里如实标注）：标签别名→服务端派生 id、
    expectedVersion→真实行版本。
    """
    from app.routes.v1.task_space_commands import _domain_command
    from app.schemas.task_space_batch import TaskSpaceBatchRequest

    fixture = load_fixture()
    space = task_space_fixture
    batch = _batch_request(fixture, "add_then_remove_from_cache")
    assert batch["batch_derived_from"] == "single_route_captures"
    assert batch["batch_has_no_url_address"] is True
    labels = await _resolve_aliases(space, fixture)
    project = await space.create_project(command_id="xb-proj", key="XB")
    item = await space.create_work_item(
        str(project.value["id"]), "Batched", None, "xb-item"
    )
    work_item_id = str(item.value["id"])
    base_version = int(item.value["version"])

    # Hand the fixture's commands to the PRODUCTION batch wire schema, with only
    # the two cached-placeholder rebases applied. Everything else — kind
    # dispatch, field whitelist, payload shape — is the production converter's
    # work, so a drift in that converter surfaces here.
    #
    # The fixture's own payloadHash cannot be reused verbatim: it was computed
    # over the PLACEHOLDER aliases ("label-a"), and label ids are server-derived,
    # so translating them necessarily changes the hash. The fixture therefore
    # pins the *shape* (asserted in
    # test_frontend_declared_hashes_match_the_backend_canonical_payload, which
    # recomputes over the aliases), and here the hash is recomputed over the
    # translated payload — the production converter still builds the payload.
    wire_commands = []
    for index, command in enumerate(batch["commands"]):
        translated = sorted(labels.translate(command["labelIds"]))
        wire_commands.append({
            "kind": command["kind"],
            "commandId": command["commandId"],
            "spaceId": space.space_id,
            "workItemId": work_item_id,
            "expectedVersion": base_version + index,
            "payloadHash": canonical_payload_hash({"label_ids": translated}),
            "labelIds": translated,
        })
    parsed = TaskSpaceBatchRequest.model_validate(
        {"batchId": "xl-batch", "commands": wire_commands}
    )
    executed = tuple(_domain_command(command) for command in parsed.commands)

    module = DefaultTaskSpaceBatchCommandModule(space.uow)
    outcome: TaskSpaceBatchOutcome = await module.execute_batch(
        space.scope, executed, parsed.batch_id
    )

    accepted = [
        item_outcome.outcome
        for item_outcome in outcome.items
        if isinstance(item_outcome.outcome, TaskSpaceAccepted)
    ]
    assert len(accepted) == 2, [
        (item.input_index, type(item.outcome).__name__, getattr(item.outcome, "code", None))
        for item in outcome.items
    ]
    assert list(accepted[0].value["label_ids"]) == [labels["label-a"]]
    # The second item declares the post-removal target of the set the first
    # accepted item left behind: {A} minus A => [].
    assert list(accepted[1].value["label_ids"]) == []
    assert int(accepted[0].value["version"]) + 1 == int(accepted[1].value["version"])
    row = await space.read_work_item(work_item_id)
    assert row["label_ids"] == []
    assert int(row["version"]) == int(accepted[1].value["version"])
    events = await space.visible_events(batch_id="xl-batch")
    label_events = [event for event in events if event.entity_type == "workItem"]
    assert len(label_events) == 2
    assert label_events[-1].payload["label_ids"] == []
