"""依赖解除确认（resolution / resolved_at）—— D2 / ADR-0004 的验收测试。

覆盖五个新增面：
1. 边态派生矩阵（completed / cancelled / cancelled+confirmed / orphan × 三种边型）；
2. ResolveDependency 幂等 CAS（首确认写两列 + 事件；重复确认 = 零效果回执）；
3. B6 防上行守卫（sync 重放拒收 resolution/resolved_at 变更、稳定错误码、零副作用）；
4. relation sync 行形状（带新列 post-image 重放不炸；原样回显不被误拒）；
5. 跨设备（A 写入 resolution → B pull 到同一事实；B 尝试上行变更被拒）。

真值表口径（合同修订版 §3.4 / §4.2，实施见 queries.py::derive_relation_edge_state）：
completed → satisfied；cancelled 未确认 → broken_requires_resolution（仍阻塞）；
cancelled 已确认 → satisfied；行缺失（孤儿边）→ open（仍阻塞，绝不被无证据确认解除）。
"""

from __future__ import annotations

import pytest

from app.errors import MutationRejectedError
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import (
    RelationCommand,
    TaskSpaceRejected,
    relation_id,
)
from app.task_space.queries import (
    derive_blocked_by_dependency,
    derive_relation_edge_state,
)
from tests.sync_v2_helpers import (
    make_sync_v2_event,
    pull_sync_v2,
    push_sync_v2,
    ready_sync_v2_client,
)

# --------------------------------------------------------------------------- #
# Helpers（与 test_task_space_relations.py 同款，保持本文件自足）
# --------------------------------------------------------------------------- #


def _hash(from_id: str, to_id: str, relation_type: str = "depends_on") -> str:
    return canonical_payload_hash({
        "from_work_item_id": from_id,
        "to_work_item_id": to_id,
        "relation_type": relation_type,
    })


def _command(fixture, *, operation: str, from_id: str, to_id: str,
             command_id: str, relation_type: str = "depends_on",
             expected_version: int | None = None) -> RelationCommand:
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


async def _execute(fixture, **kwargs):
    return await fixture.module.execute(fixture.scope, _command(fixture, **kwargs))


async def _create(fixture, from_id: str, to_id: str, command_id: str,
                  relation_type: str = "depends_on"):
    return await _execute(fixture, operation="create", from_id=from_id, to_id=to_id,
                          command_id=command_id, relation_type=relation_type)


async def _resolve(fixture, from_id: str, to_id: str, command_id: str,
                   expected_version: int, relation_type: str = "depends_on"):
    return await _execute(fixture, operation="resolve", from_id=from_id, to_id=to_id,
                          command_id=command_id, relation_type=relation_type,
                          expected_version=expected_version)


async def _seed_chain(fixture, prefix: str):
    """project + root + 两个二级兄弟（u = 上游候选，d = 下游候选）。"""
    project = await fixture.create_project(
        command_id=f"{prefix}-project", key=f"{prefix[:4].upper()}"
    )
    project_id = str(project.value["id"])
    root = await fixture.create_work_item(
        project_id, f"{prefix} root", None, f"{prefix}-root"
    )
    upstream = await fixture.create_work_item(
        project_id, "U", str(root.value["id"]), f"{prefix}-u"
    )
    downstream = await fixture.create_work_item(
        project_id, "D", str(root.value["id"]), f"{prefix}-d"
    )
    return project_id, str(upstream.value["id"]), str(downstream.value["id"])


async def _relation_row(fixture, from_id: str, to_id: str) -> dict[str, object]:
    rows = await fixture.queries.list_relations(fixture.scope, None)
    for row in rows:
        if str(row["from_work_item_id"]) == from_id and str(row["to_work_item_id"]) == to_id:
            return dict(row)
    raise AssertionError(f"relation row not found: {from_id}->{to_id}")


# --------------------------------------------------------------------------- #
# 1 — 边态派生矩阵（纯函数；与前端 relation-selectors 逐条对齐）
# --------------------------------------------------------------------------- #


def _edge(row_from: str = "d", row_to: str = "u",
          relation_type: str = "depends_on", **extra) -> dict[str, object]:
    return {
        "from_work_item_id": row_from,
        "to_work_item_id": row_to,
        "relation_type": relation_type,
        **extra,
    }


@pytest.mark.parametrize("relation_type", ["depends_on", "blocks"])
@pytest.mark.parametrize(
    ("category", "resolution", "expected_state", "blocked"),
    [
        # 行缺失（孤儿边）：按 open —— 绝不静默解除，确认也不能解除（无证据）。
        (None, None, "open", True),
        (None, "confirmed_not_required", "open", True),
        # 完成 → satisfied。
        ("completed", None, "satisfied", False),
        ("completed", "confirmed_not_required", "satisfied", False),
        # ★ 病灶行：cancelled 未确认 → broken（仍阻塞）。
        ("cancelled", None, "broken_requires_resolution", True),
        # 确认后 → satisfied（保留审计边）。
        ("cancelled", "confirmed_not_required", "satisfied", False),
        # 其余活动类目 → open。
        ("not_started", None, "open", True),
        ("in_progress", None, "open", True),
        ("paused", None, "open", True),
        ("waiting", None, "open", True),
    ],
)
def test_edge_state_matrix(
    relation_type: str, category: str | None, resolution: str | None,
    expected_state: str, blocked: bool,
) -> None:
    categories = {} if category is None else {"u": category}
    row = _edge(relation_type=relation_type, resolution=resolution)
    assert derive_relation_edge_state(row, categories) == expected_state
    assert derive_blocked_by_dependency([row], categories).get("d", False) is blocked


def test_relates_to_is_outside_the_truth_table() -> None:
    for category in ("cancelled", "completed"):
        assert derive_blocked_by_dependency(
            [_edge(relation_type="relates_to")], {"u": category}
        ) == {}


# --------------------------------------------------------------------------- #
# 2 — ResolveDependency 幂等 CAS
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_resolve_is_an_idempotent_cas(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, u, d = await _seed_chain(fixture, "residem")
    created = await _create(fixture, d, u, "residem-c1")
    assert int(created.value["version"]) == 1
    assert created.value["resolution"] is None
    assert created.value["resolved_at"] is None

    first = await _resolve(fixture, d, u, "residem-r1", 1)
    assert not isinstance(first, TaskSpaceRejected), getattr(first, "code", "")
    assert first.value["resolution"] == "confirmed_not_required"
    assert int(first.value["version"]) == 2
    assert isinstance(first.value["resolved_at"], str)
    assert first.value["resolved_at"].endswith("Z")
    events = await fixture.visible_events(operation_id="residem-r1")
    assert len(events) == 1
    assert events[0].entity_type == "relation"
    assert events[0].action == "update"
    assert events[0].payload["resolution"] == "confirmed_not_required"

    # 重复确认（当前版本）→ 零效果回执：无 version bump、无 sync 事件、无 DB 写。
    repeat = await _resolve(fixture, d, u, "residem-r2", 2)
    assert not isinstance(repeat, TaskSpaceRejected), getattr(repeat, "code", "")
    assert int(repeat.value["version"]) == 2
    assert repeat.value["resolved_at"] == first.value["resolved_at"]
    assert await fixture.visible_events(operation_id="residem-r2") == ()
    row = await _relation_row(fixture, d, u)
    assert int(row["version"]) == 2
    assert row["resolution"] == "confirmed_not_required"

    # 陈旧版本：CAS 先于幂等 —— version_conflict，绝不静默成功。
    stale = await _resolve(fixture, d, u, "residem-r3", 1)
    assert isinstance(stale, TaskSpaceRejected)
    assert stale.code == "version_conflict"


@pytest.mark.asyncio
async def test_resolve_rejects_non_blocking_and_unknown_edges(task_space_fixture) -> None:
    fixture = task_space_fixture
    _, u, d = await _seed_chain(fixture, "resneg")
    assert not isinstance(
        await _create(fixture, d, u, "resneg-c1", relation_type="relates_to"),
        TaskSpaceRejected,
    )

    # relates_to 的确认无意义 → fail-closed。
    non_blocking = await _resolve(
        fixture, d, u, "resneg-r1", 1, relation_type="relates_to"
    )
    assert isinstance(non_blocking, TaskSpaceRejected)
    assert non_blocking.code == "payload_field_not_allowed"

    # 未知边 → not_found（不是静默零效果）。
    unknown = await _resolve(fixture, u, d, "resneg-r2", 1)
    assert isinstance(unknown, TaskSpaceRejected)
    assert unknown.code == "not_found"


# --------------------------------------------------------------------------- #
# 3 / 4 — 防上行守卫 + 行形状（sync 重放路径）
# --------------------------------------------------------------------------- #


def _sync_request(fixture, *, row: dict[str, object], action: str, command_id: str,
                  payload: dict[str, object], expected_version: int | None,
                  client_updated_at: str):
    return fixture.entity_commands.from_sync_event(
        fixture.scope,
        fixture.sync_event(
            entity_type="relation",
            entity_id=str(row["id"]),
            action=action,
            payload=payload,
            expected_version=expected_version,
            client_updated_at=client_updated_at,
        ),
    )


@pytest.mark.asyncio
async def test_sync_update_cannot_change_resolution(task_space_fixture) -> None:
    """客户端上行的 update 试图设置 resolution → fail-closed、零副作用。"""
    fixture = task_space_fixture
    _, u, d = await _seed_chain(fixture, "resguard")
    await _create(fixture, d, u, "resguard-c1")
    row = await _relation_row(fixture, d, u)

    client_updated_at = fixture.clock.tick()
    candidate = {
        **row,
        "resolution": "confirmed_not_required",
        "updated_at": client_updated_at,
        "version": int(row["version"]) + 1,
    }
    request = _sync_request(
        fixture, row=row, action="update", command_id="resguard-sync-1",
        payload=candidate, expected_version=int(row["version"]),
        client_updated_at=client_updated_at,
    )
    overlay_before = fixture.overlay_snapshot()

    with pytest.raises(MutationRejectedError) as caught:
        await fixture.uow.execute(fixture.scope, request, "resguard-sync-1")

    rejection = caught.value.rejection
    assert rejection.code == "server_managed_field_changed"
    assert list(rejection.details["fields"]) == ["resolution"]
    assert fixture.overlay_snapshot() == overlay_before
    assert await fixture.visible_events(operation_id="resguard-sync-1") == ()
    after = await _relation_row(fixture, d, u)
    assert after["resolution"] is None
    assert int(after["version"]) == 1

    # resolved_at 同样被守卫（单独字段）。
    client_updated_at = fixture.clock.tick()
    forged_timestamp = {
        **row,
        "resolved_at": client_updated_at,
        "updated_at": client_updated_at,
        "version": int(row["version"]) + 1,
    }
    request = _sync_request(
        fixture, row=row, action="update", command_id="resguard-sync-2",
        payload=forged_timestamp, expected_version=int(row["version"]),
        client_updated_at=client_updated_at,
    )
    with pytest.raises(MutationRejectedError) as caught:
        await fixture.uow.execute(fixture.scope, request, "resguard-sync-2")
    assert list(caught.value.rejection.details["fields"]) == ["resolved_at"]


@pytest.mark.asyncio
async def test_sync_create_cannot_preconfirm_a_relation(task_space_fixture) -> None:
    """离线建边的重放不得预置确认（resolution 非空即拒）。"""
    fixture = task_space_fixture
    _, u, d = await _seed_chain(fixture, "respre")
    client_updated_at = fixture.clock.tick()
    edge_id = relation_id(fixture.space_id, d, u, "depends_on")
    row = {"id": edge_id}
    payload = {
        "id": edge_id,
        "space_id": fixture.space_id,
        "from_work_item_id": d,
        "to_work_item_id": u,
        "relation_type": "depends_on",
        "resolution": "confirmed_not_required",
        "resolved_at": client_updated_at,
        "created_at": client_updated_at,
        "updated_at": client_updated_at,
        "version": 1,
    }
    request = _sync_request(
        fixture, row=row, action="create", command_id="respre-sync-1",
        payload=payload, expected_version=None, client_updated_at=client_updated_at,
    )
    with pytest.raises(MutationRejectedError) as caught:
        await fixture.uow.execute(fixture.scope, request, "respre-sync-1")
    assert caught.value.rejection.code == "server_managed_field_changed"
    assert list(caught.value.rejection.details["fields"]) == [
        "resolution", "resolved_at",
    ]

    # 合法建边（不带确认）仍被接受 —— 行形状完整、两列为 NULL。
    legit_payload = {**payload, "resolution": None, "resolved_at": None}
    request = _sync_request(
        fixture, row=row, action="create", command_id="respre-sync-2",
        payload=legit_payload, expected_version=None,
        client_updated_at=client_updated_at,
    )
    result = await fixture.uow.execute(fixture.scope, request, "respre-sync-2")
    assert result.value["resolution"] is None
    assert result.value["resolved_at"] is None
    stored = await _relation_row(fixture, d, u)
    assert {"resolution", "resolved_at"} <= set(stored)


@pytest.mark.asyncio
async def test_sync_post_image_with_resolution_columns_replays(task_space_fixture) -> None:
    """带新列 post-image 的重放（原样回显）不被误拒；服务端值被继承。"""
    fixture = task_space_fixture
    _, u, d = await _seed_chain(fixture, "reshape")
    await _create(fixture, d, u, "reshape-c1")
    row = await _relation_row(fixture, d, u)

    # 未确认状态的整行回显：接受，且两列保持 NULL。
    client_updated_at = fixture.clock.tick()
    echo = {
        **row,
        "updated_at": client_updated_at,
        "version": int(row["version"]) + 1,
    }
    request = _sync_request(
        fixture, row=row, action="update", command_id="reshape-sync-1",
        payload=echo, expected_version=int(row["version"]),
        client_updated_at=client_updated_at,
    )
    result = await fixture.uow.execute(fixture.scope, request, "reshape-sync-1")
    assert int(result.value["version"]) == 2
    assert result.value["resolution"] is None

    # 服务端确认后，客户端按服务端快照原样回显（携带 confirmed 值）同样接受 ——
    # 守卫是**变更检测**，不是“字段出现即拒”。
    resolved = await _resolve(fixture, d, u, "reshape-r1", 2)
    assert not isinstance(resolved, TaskSpaceRejected), getattr(resolved, "code", "")
    resolved_row = await _relation_row(fixture, d, u)
    client_updated_at = fixture.clock.tick()
    echo = {
        **resolved_row,
        "updated_at": client_updated_at,
        "version": int(resolved_row["version"]) + 1,
    }
    request = _sync_request(
        fixture, row=resolved_row, action="update", command_id="reshape-sync-2",
        payload=echo, expected_version=int(resolved_row["version"]),
        client_updated_at=client_updated_at,
    )
    result = await fixture.uow.execute(fixture.scope, request, "reshape-sync-2")
    assert result.value["resolution"] == "confirmed_not_required"
    assert result.value["resolved_at"] == resolved_row["resolved_at"]


# --------------------------------------------------------------------------- #
# 5 — 跨设备（HTTP：A 写入 → B pull；B 上行变更被拒）
# --------------------------------------------------------------------------- #


@pytest.fixture()
def _no_backup_scheduler(monkeypatch) -> None:
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", False)


async def _setup_space(client) -> tuple[dict[str, str], str]:
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201, setup.text
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master = {"Authorization": f"Bearer {login.json()['access_token']}"}
    space = await client.post(
        "/api/v1/spaces", json={"name": "Relation Resolution Space"}, headers=master
    )
    assert space.status_code == 201, space.text
    space_id = space.json()["id"]
    token = await client.post(f"/api/v1/spaces/{space_id}/token", headers=master)
    assert token.status_code == 200, token.text
    return {"Authorization": f"Bearer {token.json()['space_token']}"}, space_id


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_cross_device_resolution_is_pulled_and_push_is_rejected(
    _no_backup_scheduler, client
) -> None:
    headers, space_id = await _setup_space(client)
    await ready_sync_v2_client(client, headers, client_id="res-device-a")
    device_b = await ready_sync_v2_client(client, headers, client_id="res-device-b")

    definitions = await client.get("/api/v1/projects/definitions", headers=headers)
    assert definitions.status_code == 200, definitions.text
    status_id = {row["category"]: row["id"] for row in definitions.json()["statuses"]}

    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "res-space-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(
                {"key": "RESOLVE", "name": "Resolve", "description": None}
            ),
            "key": "resolve",
            "name": "Resolve",
        },
        headers={**headers, "Idempotency-Key": "res-space-project"},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["entityId"]

    async def create_item(command_id: str, title: str, parent_id: str | None):
        business = {
            "title": title,
            "description": None,
            "parent_id": parent_id,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }
        response = await client.post(
            "/api/v1/work-items",
            json={
                "commandId": command_id,
                "spaceId": space_id,
                "projectId": project_id,
                "payloadHash": canonical_payload_hash(business),
                "title": title,
                "parentId": parent_id,
            },
            headers={**headers, "Idempotency-Key": command_id},
        )
        assert response.status_code == 201, response.text
        return response.json()["value"]

    root = await create_item("res-space-root", "Root", None)
    upstream = await create_item("res-space-u", "U", root["id"])
    downstream = await create_item("res-space-d", "D", root["id"])
    edge_id = relation_id(space_id, downstream["id"], upstream["id"], "depends_on")
    create_hash = canonical_payload_hash({
        "from_work_item_id": downstream["id"],
        "to_work_item_id": upstream["id"],
        "relation_type": "depends_on",
    })

    # A：建立依赖边（D 依赖 U）。
    created = await client.post(
        "/api/v1/relations",
        json={
            "commandId": "res-edge-create",
            "spaceId": space_id,
            "payloadHash": create_hash,
            "fromWorkItemId": downstream["id"],
            "toWorkItemId": upstream["id"],
            "relationType": "depends_on",
        },
        headers={**headers, "Idempotency-Key": "res-edge-create"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["value"]["resolution"] is None
    assert created.json()["value"]["resolvedAt"] is None

    # B：pull 到建边事件；作为上行冒用的底稿。
    page = await pull_sync_v2(client, headers, device_b)
    relation_events = [
        event for event in page["events"]
        if event["entity_type"] == "relation" and event["entity_id"] == edge_id
    ]
    assert relation_events, page["events"]
    post_image = dict(relation_events[-1]["payload"])
    assert post_image["resolution"] is None
    assert post_image["resolved_at"] is None

    # B：尝试上行变更 resolution —— 守卫拒绝、applied 为空、零副作用。
    client_updated_at = "2026-09-12T00:00:00.000Z"
    forged = {
        **post_image,
        "resolution": "confirmed_not_required",
        "updated_at": client_updated_at,
        "version": int(post_image["version"]) + 1,
    }
    pushed = await push_sync_v2(
        client, headers, device_b,
        [
            make_sync_v2_event(
                entity_type="relation",
                entity_id=edge_id,
                action="update",
                payload=forged,
                expected_version=int(post_image["version"]),
                client_updated_at=client_updated_at,
            )
        ],
    )
    assert pushed["applied"] == [], pushed
    assert [error["code"] for error in pushed["errors"]] == [
        "server_managed_field_changed"
    ]

    # A：上游取消（真实链路第一步）。
    cancel_hash = canonical_payload_hash(
        {"status_definition_id": status_id["cancelled"]}
    )
    cancelled = await client.post(
        f"/api/v1/work-items/{upstream['id']}/transition",
        json={
            "commandId": "res-space-cancel",
            "spaceId": space_id,
            "expectedVersion": int(upstream["version"]),
            "payloadHash": cancel_hash,
            "statusDefinitionId": status_id["cancelled"],
        },
        headers={**headers, "Idempotency-Key": "res-space-cancel"},
    )
    assert cancelled.status_code == 200, cancelled.text

    # A：显式确认「不再需要」。
    resolved = await client.post(
        f"/api/v1/relations/{edge_id}/resolve",
        json={
            "commandId": "res-edge-resolve",
            "spaceId": space_id,
            "expectedVersion": int(created.json()["value"]["version"]),
            "payloadHash": create_hash,
            "fromWorkItemId": downstream["id"],
            "toWorkItemId": upstream["id"],
            "relationType": "depends_on",
        },
        headers={**headers, "Idempotency-Key": "res-edge-resolve"},
    )
    assert resolved.status_code == 200, resolved.text
    value = resolved.json()["value"]
    assert value["resolution"] == "confirmed_not_required"
    assert value["resolvedAt"]

    # B：增量 pull 收到确认后的事实（跨设备在线一致）。
    page = await pull_sync_v2(client, headers, device_b)
    relation_events = [
        event for event in page["events"]
        if event["entity_type"] == "relation" and event["entity_id"] == edge_id
    ]
    assert relation_events, page["events"]
    latest = relation_events[-1]["payload"]
    assert latest["resolution"] == "confirmed_not_required"
    assert latest["resolved_at"] == value["resolvedAt"]