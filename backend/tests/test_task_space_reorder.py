"""工单②：ReorderWorkItem —— 同父内拖拽排序（child_rank 集合级重排）。

钉死的契约：
- rank 语义 = 去掉自己之后的兄弟序列插入位次；重排后同父 rank 保持/规范为
  枚举位次（顺带填洞）。
- 「位置未变，不写」：插入后 rank 不变的兄弟行零副作用（无 version bump）。
- parent_id 是 authority guard（cross_parent_reorder）；换父仍走 MoveWorkItem。
- 幂等：已在位 → 零效果回执（version 不变、无 sync 事件）。
- CAS：expected_version 只锁被移动行（陈旧 → version_conflict）。
- sync：reorder 发出的 update 事件（仅 rank 变化）走既有 move family 重放。
"""

from __future__ import annotations

from collections.abc import Mapping

import pytest

from app.task_space.contracts import TaskSpacePageQuery, TaskSpaceRejected

PRE_WAITING_FIELD = "pre_waiting_status_definition_id"


def _wire_value(value):
    if isinstance(value, Mapping):
        return {str(key): _wire_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_wire_value(item) for item in value]
    return value


def _sync_candidate(item: Mapping[str, object], **changes: object) -> dict:
    """Client outbound workItem post-image（见 test_task_space_tree 同名 helper）：
    剥离只出站列，模拟真实客户端上行形态。"""
    candidate = {**item, **changes}
    candidate.pop(PRE_WAITING_FIELD, None)
    candidate.pop("due_at", None)
    return candidate


async def _read_page(fixture, project_id: str):
    page = await fixture.queries.list_work_items(
        fixture.scope, TaskSpacePageQuery(None, 100, {"project_id": project_id})
    )
    return page.items


async def _seed_root_triple(fixture, prefix: str):
    """一个 project + 三个根项 A/B/C（rank 0/1/2，append 顺序）。"""
    project = await fixture.create_project(
        command_id=f"{prefix}-project", key="REORDER"
    )
    a = await fixture.create_work_item(project.value["id"], "Root A", None, f"{prefix}-a")
    b = await fixture.create_work_item(project.value["id"], "Root B", None, f"{prefix}-b")
    c = await fixture.create_work_item(project.value["id"], "Root C", None, f"{prefix}-c")
    return project, a, b, c


@pytest.mark.asyncio
async def test_reorder_moves_root_item_to_target_position(task_space_fixture) -> None:
    """拖 A 到末尾：读侧顺序 B,C,A；重排规范化三行的 rank（1→0、2→1、0→2）。"""
    project, a, b, c = await _seed_root_triple(task_space_fixture, "reorder-root")

    outcome = await task_space_fixture.reorder_work_item(
        a.value["id"], None, 2, "reorder-root-to-end"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    roots = [
        row for row in await _read_page(task_space_fixture, project.value["id"])
        if row["parent_id"] is None
    ]
    assert [row["title"] for row in roots] == ["Root B", "Root C", "Root A"]
    assert [int(row["child_rank"]) for row in roots] == [0, 1, 2]
    assert int(outcome.value["child_rank"]) == 2
    # 集合级重排把每行的 rank 规范化为枚举位次：三行都被重写（version +1）。
    for before in (a, b, c):
        after = next(row for row in roots if row["id"] == before.value["id"])
        assert int(after["version"]) == int(before.value["version"]) + 1


@pytest.mark.asyncio
async def test_reorder_keeps_rows_whose_rank_already_matches(task_space_fixture) -> None:
    """「位置未变，不写」：把 z 拖到中间位次时，插入点之前的行 rank 已对位。"""
    project = await task_space_fixture.create_project(
        command_id="reorder-keep-project", key="REORDER"
    )
    x = await task_space_fixture.create_work_item(project.value["id"], "Root X", None, "reorder-keep-x")
    y = await task_space_fixture.create_work_item(project.value["id"], "Root Y", None, "reorder-keep-y")
    z = await task_space_fixture.create_work_item(project.value["id"], "Root Z", None, "reorder-keep-z")

    outcome = await task_space_fixture.reorder_work_item(
        z.value["id"], None, 1, "reorder-keep-mid"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    roots = [
        row for row in await _read_page(task_space_fixture, project.value["id"])
        if row["parent_id"] is None
    ]
    assert [row["title"] for row in roots] == ["Root X", "Root Z", "Root Y"]
    # x 的 rank 0 == 枚举位次 0 ⇒ 不写；y/z 被重写。
    kept = next(row for row in roots if row["id"] == x.value["id"])
    assert int(kept["version"]) == int(x.value["version"])
    for before in (y, z):
        after = next(row for row in roots if row["id"] == before.value["id"])
        assert int(after["version"]) == int(before.value["version"]) + 1


@pytest.mark.asyncio
async def test_reorder_to_front_rewrites_every_sibling_rank(task_space_fixture) -> None:
    """拖 C 到最前：[A,B,C] → [C,A,B]，三行 rank 全部变化、version 全部 +1。"""
    project, a, b, c = await _seed_root_triple(task_space_fixture, "reorder-front")

    outcome = await task_space_fixture.reorder_work_item(
        c.value["id"], None, 0, "reorder-front-op"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    roots = [
        row for row in await _read_page(task_space_fixture, project.value["id"])
        if row["parent_id"] is None
    ]
    assert [row["title"] for row in roots] == ["Root C", "Root A", "Root B"]
    assert [int(row["child_rank"]) for row in roots] == [0, 1, 2]
    for before in (a, b, c):
        after = next(row for row in roots if row["id"] == before.value["id"])
        assert int(after["version"]) == int(before.value["version"]) + 1


@pytest.mark.asyncio
async def test_reorder_positions_level3_sibling_before_another(task_space_fixture) -> None:
    """L3 同层插到某个兄弟之前：reorder(y, rank=0) → y,x 顺序。"""
    level2 = await task_space_fixture.seed_level2("reorder-l3")
    await task_space_fixture.create_work_item(
        level2["project_id"], "Child X", level2["id"], "reorder-l3-x"
    )
    y = await task_space_fixture.create_work_item(
        level2["project_id"], "Child Y", level2["id"], "reorder-l3-y"
    )

    outcome = await task_space_fixture.reorder_work_item(
        y.value["id"], level2["id"], 0, "reorder-l3-before"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    children = [
        row for row in await _read_page(task_space_fixture, level2["project_id"])
        if row["parent_id"] == level2["id"]
    ]
    assert [row["title"] for row in children] == ["Child Y", "Child X"]
    assert [int(row["child_rank"]) for row in children] == [0, 1]


@pytest.mark.asyncio
async def test_reorder_fills_holes_left_by_earlier_moves(task_space_fixture) -> None:
    """append-only 留下的洞（rank 0 空缺）在重排时被填掉 —— 只触碰同一父项的行。"""
    project = await task_space_fixture.create_project(
        command_id="reorder-hole-project", key="REORDER"
    )
    root_a = await task_space_fixture.create_work_item(project.value["id"], "Root A", None, "reorder-hole-root-a")
    level2_a = await task_space_fixture.create_work_item(project.value["id"], "L2 A", root_a.value["id"], "reorder-hole-l2a")
    root_b = await task_space_fixture.create_work_item(project.value["id"], "Root B", None, "reorder-hole-root-b")
    level2_b = await task_space_fixture.create_work_item(project.value["id"], "L2 B", root_b.value["id"], "reorder-hole-l2b")
    x = await task_space_fixture.create_work_item(project.value["id"], "Child X", level2_a.value["id"], "reorder-hole-x")
    y = await task_space_fixture.create_work_item(project.value["id"], "Child Y", level2_a.value["id"], "reorder-hole-y")
    z = await task_space_fixture.create_work_item(project.value["id"], "Child Z", level2_a.value["id"], "reorder-hole-z")
    # Move X away (same project): leaves a hole at rank 0 under level2_a.
    moved = await task_space_fixture.move(
        x.value["id"], project.value["id"], level2_b.value["id"], "reorder-hole-move"
    )
    assert not isinstance(moved, TaskSpaceRejected)

    outcome = await task_space_fixture.reorder_work_item(
        z.value["id"], level2_a.value["id"], 0, "reorder-hole-fill"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    children = [
        row for row in await _read_page(task_space_fixture, project.value["id"])
        if row["parent_id"] == level2_a.value["id"]
    ]
    assert [row["title"] for row in children] == ["Child Z", "Child Y"]
    assert [int(row["child_rank"]) for row in children] == [0, 1]
    # The other parent's rows are untouched.
    other = await task_space_fixture.read_work_item(level2_b.value["id"])
    assert int(other["child_rank"]) == 0


@pytest.mark.asyncio
async def test_reorder_is_idempotent_when_already_in_position(task_space_fixture) -> None:
    """B 已在 rank 1：reorder(B, rank=1) 恢复原序 ⇒ 零效果（无事件、无 bump）。"""
    _, a, b, c = await _seed_root_triple(task_space_fixture, "reorder-idem")

    outcome = await task_space_fixture.reorder_work_item(
        b.value["id"], None, 1, "reorder-idem-noop"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    row = await task_space_fixture.read_work_item(b.value["id"])
    assert int(row["version"]) == int(b.value["version"])
    assert int(row["child_rank"]) == 1
    assert int(a.value["version"]) == 1 and int(c.value["version"]) == 1
    assert await task_space_fixture.visible_events(operation_id="reorder-idem-noop") == ()


@pytest.mark.asyncio
async def test_reorder_rank_beyond_end_clamps_to_append(task_space_fixture) -> None:
    _, a, _, _ = await _seed_root_triple(task_space_fixture, "reorder-clamp")

    outcome = await task_space_fixture.reorder_work_item(
        a.value["id"], None, 99, "reorder-clamp-end"
    )

    assert not isinstance(outcome, TaskSpaceRejected)
    assert int(outcome.value["child_rank"]) == 2


@pytest.mark.asyncio
async def test_reorder_rejects_cross_parent_guard(task_space_fixture) -> None:
    level2 = await task_space_fixture.seed_level2("reorder-guard")
    child = await task_space_fixture.create_work_item(
        level2["project_id"], "Child", level2["id"], "reorder-guard-child"
    )

    outcome = await task_space_fixture.reorder_work_item(
        child.value["id"], None, 0, "reorder-guard-cross-parent"
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "invalid_work_item_tree"


@pytest.mark.asyncio
async def test_reorder_stale_expected_version_is_version_conflict(task_space_fixture) -> None:
    _, a, _, _ = await _seed_root_triple(task_space_fixture, "reorder-cas")

    outcome = await task_space_fixture.reorder_work_item(
        a.value["id"],
        None,
        1,
        "reorder-cas-stale",
        expected_version=int(a.value["version"]) + 5,
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "version_conflict"


@pytest.mark.asyncio
async def test_reorder_update_events_replay_through_move_family(task_space_fixture) -> None:
    """reorder 的 update 事件形状 = 既有 move-family 重放入口。

    [A,B,C,D] → [C,A,B,D]：D 的 rank 未变 ⇒ 不写（恰三个事件）。
    事件 post-image 是出站全列（含只出站列与 label_ids 投影）；剥掉只出站列
    后的 rank-only candidate（与 wave2 重放测试同形态）经 entity.update 真实
    重放收敛 —— 证明 reorder 的兄弟行事件走既有 move family，无需新重放路径。
    （单库无法同时扮演已应用的服务器与未应用的另一设备，故 rank-only 重放
    打在未被 reorder 触碰的 D 行上 —— 与 wave2 手工 candidate 模式一致。）
    """
    project = await task_space_fixture.create_project(
        command_id="reorder-replay-project", key="REORDER"
    )
    a = await task_space_fixture.create_work_item(project.value["id"], "Root A", None, "reorder-replay-a")
    b = await task_space_fixture.create_work_item(project.value["id"], "Root B", None, "reorder-replay-b")
    c = await task_space_fixture.create_work_item(project.value["id"], "Root C", None, "reorder-replay-c")
    d = await task_space_fixture.create_work_item(project.value["id"], "Root D", None, "reorder-replay-d")

    outcome = await task_space_fixture.reorder_work_item(
        c.value["id"], None, 0, "reorder-replay-op"
    )
    assert not isinstance(outcome, TaskSpaceRejected)

    events = await task_space_fixture.visible_events(operation_id="reorder-replay-op")
    # D 的 rank 3 == 枚举位次 3 ⇒ 不写；A/B/C 规范化全写 ⇒ 恰三个事件。
    assert len(events) == 3
    a_event = next(
        event for event in events if str(event.payload["id"]) == a.value["id"]
    )
    # 事件 post-image 是出站全列（含只出站列与 label_ids 投影）。
    assert "label_ids" in a_event.payload
    assert PRE_WAITING_FIELD in a_event.payload
    assert int(a_event.payload["child_rank"]) == 1

    # rank-only candidate 重放（入站剥离只出站列）—— 打在未被触碰的 D 上。
    d_row = await task_space_fixture.read_work_item(d.value["id"])
    client_updated_at = task_space_fixture.clock.tick(7)
    candidate = _sync_candidate(
        d_row,
        child_rank=9,
        updated_at=client_updated_at,
        version=int(d_row["version"]) + 1,
    )
    request = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(d.value["id"]),
        action="update",
        payload=candidate,
        expected_version=int(d_row["version"]),
        client_updated_at=client_updated_at,
    )
    task_space_fixture.clock.tick(9)
    replayed = await task_space_fixture.uow.execute(
        task_space_fixture.scope,
        task_space_fixture.entity_commands.from_sync_event(
            task_space_fixture.scope, request
        ),
        "reorder-replay-peer-d",
    )
    assert int(replayed.value["child_rank"]) == 9
    row = await task_space_fixture.read_work_item(d.value["id"])
    assert int(row["child_rank"]) == 9

    roots = [
        item for item in await _read_page(task_space_fixture, outcome.value["project_id"])
        if item["parent_id"] is None
    ]
    assert [item["title"] for item in roots] == ["Root C", "Root A", "Root B", "Root D"]


# --------------------------------------------------------------------------- #
# HTTP 端到端：真实 app + REST 契约（排序保持的请求/响应证据）
# --------------------------------------------------------------------------- #


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_rest_reorder_keeps_order_after_fresh_read(client) -> None:
    """REST reorder → 全新 GET 列表：顺序保持（camelCase wire 契约证据）。"""
    from app.mutation.types import canonical_payload_hash

    setup = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert setup.status_code == 201
    login = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "Reorder HTTP Space"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token = await client.post(f"/api/v1/spaces/{space_id}/token", headers=master_headers)
    headers = {"Authorization": f"Bearer {token.json()['space_token']}"}

    project_payload = {"key": "REORDER", "name": "Reorder HTTP Project", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "http-reorder-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **{**project_payload, "key": "reorder"},
        },
        headers={**headers, "Idempotency-Key": "http-reorder-project"},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["value"]["id"]

    def _create_body(command_id: str, title: str) -> dict:
        business = {
            "title": title,
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }
        return {
            "commandId": command_id,
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(business),
            "projectId": project_id,
            "title": business["title"],
            "description": None,
            "parentId": None,
            "typeDefinitionId": None,
            "statusDefinitionId": None,
            "priority": None,
        }

    item_ids: dict[str, str] = {}
    for index, title in enumerate(("Root A", "Root B", "Root C")):
        command_id = f"http-reorder-create-{index}"
        resp = await client.post(
            "/api/v1/work-items",
            json=_create_body(command_id, title),
            headers={**headers, "Idempotency-Key": command_id},
        )
        assert resp.status_code == 201, resp.text
        item_ids[title] = resp.json()["value"]["id"]

    reorder_business = {"parent_id": None, "rank": 2}
    reorder = await client.post(
        f"/api/v1/work-items/{item_ids['Root A']}/reorder",
        json={
            "commandId": "http-reorder-op",
            "spaceId": space_id,
            "expectedVersion": 1,
            "payloadHash": canonical_payload_hash(reorder_business),
            "parentId": None,
            "rank": 2,
        },
        headers={**headers, "Idempotency-Key": "http-reorder-op"},
    )
    assert reorder.status_code == 200, reorder.text
    assert int(reorder.json()["value"]["childRank"]) == 2

    page = await client.get(
        "/api/v1/work-items",
        params={"projectId": project_id},
        headers=headers,
    )
    assert page.status_code == 200, page.text
    roots = [item for item in page.json()["items"] if item["parentId"] is None]
    assert [item["title"] for item in roots] == ["Root B", "Root C", "Root A"]
    assert [int(item["childRank"]) for item in roots] == [0, 1, 2]
