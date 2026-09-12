"""等待前态（pre_waiting_status_definition_id）—— ADR-0003 的写入者 / 读投影 / 跨设备验收。

覆盖施工单步 3（唯一写入者语义）、步 4（读投影与 accepted 响应）与步 7
（跨设备在线一致 + 入站兼容未破）。

契约要点：
- 只出站：DB 行 / sync 事件 / 读投影携带该列；入站 push（WORK_ITEM_SYNC_FIELDS
  精确相等）仍拒绝携带它的 post-image；
- 唯一写入者 = 进入 waiting 类目的那次迁移；重复进入覆盖；停在 Waiting 不改写；
  离开 Waiting 惰性保留；创建即 Waiting 为 NULL；前态永远不是 waiting 类目。
"""

from __future__ import annotations

from collections.abc import Mapping

import pytest

from app.errors import MutationRejectedError
from app.mutation.types import canonical_payload_hash
from app.task_space.compiler import PRE_WAITING_STATUS_FIELD
from tests.sync_v2_helpers import (
    pull_sync_v2,
    ready_sync_v2_client,
)

PRE_WAITING = PRE_WAITING_STATUS_FIELD


def _wire_value(value):
    if isinstance(value, Mapping):
        return {str(key): _wire_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_wire_value(item) for item in value]
    return value


def _sync_candidate(item: Mapping[str, object], **changes: object) -> dict:
    """Client outbound post-image: the inbound contract stays exact — strip the
    server-owned pre-waiting column (it is never uploaded by a client)."""
    candidate = {**item, **changes}
    candidate.pop(PRE_WAITING, None)
    return candidate


async def _transition(fixture, command_id: str, work_item_id: str, status_id: str):
    current = await fixture.read_work_item(work_item_id)
    return await fixture.transition_work_item(
        command_id, work_item_id, int(current["version"]), status_id
    )


# --------------------------------------------------------------------------- #
# Step 3 — the only writer: entering Waiting records the prior state
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_entering_waiting_from_paused_records_paused(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("prior-paused")
    paused = task_space_fixture.status_id("paused")
    waiting = task_space_fixture.status_id("waiting")

    await _transition(task_space_fixture, "prior-paused-1", item["id"], paused)
    outcome = await _transition(
        task_space_fixture, "prior-paused-2", item["id"], waiting
    )

    assert outcome.value["status_definition_id"] == waiting
    assert outcome.value[PRE_WAITING] == paused
    row = await task_space_fixture.read_work_item(item["id"])
    assert row[PRE_WAITING] == paused


@pytest.mark.asyncio
async def test_entering_waiting_from_in_progress_records_in_progress(
    task_space_fixture,
) -> None:
    item = await task_space_fixture.seed_level2("prior-in-progress")
    active = task_space_fixture.status_id("in_progress")
    waiting = task_space_fixture.status_id("waiting")

    await _transition(task_space_fixture, "prior-ip-1", item["id"], active)
    await _transition(task_space_fixture, "prior-ip-2", item["id"], waiting)

    row = await task_space_fixture.read_work_item(item["id"])
    assert row[PRE_WAITING] == active


@pytest.mark.asyncio
async def test_reentering_waiting_overwrites_the_prior_state(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("prior-overwrite")
    paused = task_space_fixture.status_id("paused")
    active = task_space_fixture.status_id("in_progress")
    waiting = task_space_fixture.status_id("waiting")

    await _transition(task_space_fixture, "prior-ow-1", item["id"], paused)
    await _transition(task_space_fixture, "prior-ow-2", item["id"], waiting)
    assert (await task_space_fixture.read_work_item(item["id"]))[PRE_WAITING] == paused

    # 离开 Waiting 后再从 in_progress 进入：覆盖为新前态。
    await _transition(task_space_fixture, "prior-ow-3", item["id"], active)
    await _transition(task_space_fixture, "prior-ow-4", item["id"], waiting)
    assert (await task_space_fixture.read_work_item(item["id"]))[PRE_WAITING] == active


@pytest.mark.asyncio
async def test_staying_in_waiting_does_not_rewrite_the_prior_state(
    task_space_fixture,
) -> None:
    item = await task_space_fixture.seed_level2("prior-stay")
    paused = task_space_fixture.status_id("paused")
    waiting = task_space_fixture.status_id("waiting")

    await _transition(task_space_fixture, "prior-stay-1", item["id"], paused)
    await _transition(task_space_fixture, "prior-stay-2", item["id"], waiting)
    # 停在 Waiting（同一 waiting 状态再迁移一次）不是一次新的进入。
    await _transition(task_space_fixture, "prior-stay-3", item["id"], waiting)

    row = await task_space_fixture.read_work_item(item["id"])
    assert row[PRE_WAITING] == paused
    # 前态永不为 waiting 类目（守卫由构造保证）。
    assert row[PRE_WAITING] != waiting


@pytest.mark.asyncio
async def test_leaving_waiting_keeps_the_prior_state_lazily(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("prior-leave")
    paused = task_space_fixture.status_id("paused")
    waiting = task_space_fixture.status_id("waiting")
    completed = task_space_fixture.status_id("completed")

    await _transition(task_space_fixture, "prior-leave-1", item["id"], paused)
    await _transition(task_space_fixture, "prior-leave-2", item["id"], waiting)
    await _transition(task_space_fixture, "prior-leave-3", item["id"], completed)

    row = await task_space_fixture.read_work_item(item["id"])
    assert row["status_definition_id"] == completed
    assert row[PRE_WAITING] == paused  # 惰性保留：离开也不清除


@pytest.mark.asyncio
async def test_created_in_waiting_has_null_prior_state(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(
        command_id="prior-create-proj", key="PWC"
    )
    waiting = task_space_fixture.status_id("waiting")
    created = await task_space_fixture.create_work_item(
        project.value["id"],
        "Born waiting",
        None,
        "prior-create-item",
        status_definition_id=waiting,
    )

    assert created.value[PRE_WAITING] is None
    row = await task_space_fixture.read_work_item(created.value["id"])
    assert row[PRE_WAITING] is None


@pytest.mark.asyncio
async def test_prior_state_is_never_a_waiting_category(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("prior-never-waiting")
    paused = task_space_fixture.status_id("paused")
    waiting = task_space_fixture.status_id("waiting")

    await _transition(task_space_fixture, "prior-nw-1", item["id"], paused)
    await _transition(task_space_fixture, "prior-nw-2", item["id"], waiting)
    await _transition(task_space_fixture, "prior-nw-3", item["id"], waiting)

    row = await task_space_fixture.read_work_item(item["id"])
    statuses = {
        str(status["id"]): str(status["category"])
        for status in (
            await task_space_fixture.queries.list_definitions(
                task_space_fixture.scope
            )
        ).statuses
    }
    assert statuses[str(row[PRE_WAITING])] != "waiting"


# --------------------------------------------------------------------------- #
# Step 3 — sync post-image path records the prior state too (second compile)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sync_post_image_entering_waiting_records_prior_state(
    task_space_fixture,
) -> None:
    item = await task_space_fixture.seed_level2("prior-sync")
    paused = task_space_fixture.status_id("paused")
    waiting = task_space_fixture.status_id("waiting")
    await _transition(task_space_fixture, "prior-sync-1", item["id"], paused)
    before = await task_space_fixture.read_work_item(item["id"])

    client_updated_at = task_space_fixture.clock.tick()
    candidate = _sync_candidate(
        before,
        status_definition_id=waiting,
        updated_at=client_updated_at,
        version=int(before["version"]) + 1,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope,
        task_space_fixture.sync_event(
            entity_type="workItem",
            entity_id=str(item["id"]),
            action="update",
            payload=candidate,
            expected_version=int(before["version"]),
            client_updated_at=client_updated_at,
        ),
    )

    result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "prior-sync-op"
    )

    assert result.value["status_definition_id"] == waiting
    assert result.value[PRE_WAITING] == paused
    row = await task_space_fixture.read_work_item(item["id"])
    assert row[PRE_WAITING] == paused


@pytest.mark.asyncio
async def test_sync_post_image_carrying_prior_state_is_still_rejected(
    task_space_fixture,
) -> None:
    """入站兼容未破的反例：客户端上行携带该字段 ⇒ full_post_image_required(extra)。"""
    item = await task_space_fixture.seed_level2("prior-inbound")
    client_updated_at = task_space_fixture.clock.tick()
    before = await task_space_fixture.read_work_item(item["id"])
    # 故意不剔除服务端自持列 —— 入站集合精确相等，多一个字段即拒。
    candidate = {
        **before,
        "title": "Smuggled prior state",
        "updated_at": client_updated_at,
        "version": int(before["version"]) + 1,
        PRE_WAITING: task_space_fixture.status_id("paused"),
    }
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope,
        task_space_fixture.sync_event(
            entity_type="workItem",
            entity_id=str(item["id"]),
            action="update",
            payload=candidate,
            expected_version=int(before["version"]),
            client_updated_at=client_updated_at,
        ),
    )
    overlay_before = task_space_fixture.overlay_snapshot()

    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "prior-inbound-op"
        )

    rejection = caught.value.rejection
    assert rejection.code == "work_item_structure_changed"
    assert rejection.details["reason"] == "full_post_image_required"
    assert PRE_WAITING in rejection.details["extra"]
    assert task_space_fixture.overlay_snapshot() == overlay_before
    assert await task_space_fixture.visible_events(
        operation_id="prior-inbound-op"
    ) == ()


# --------------------------------------------------------------------------- #
# Step 4 — read projection + accepted response
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_read_projection_and_accepted_response_expose_prior_state(
    task_space_fixture,
) -> None:
    item = await task_space_fixture.seed_level2("prior-read")
    paused = task_space_fixture.status_id("paused")
    waiting = task_space_fixture.status_id("waiting")

    # 历史行（从未进入 Waiting）：返回 null，不报错。
    assert (await task_space_fixture.read_work_item(item["id"]))[PRE_WAITING] is None

    await _transition(task_space_fixture, "prior-read-1", item["id"], paused)
    accepted = await _transition(
        task_space_fixture, "prior-read-2", item["id"], waiting
    )
    assert accepted.value[PRE_WAITING] == paused  # accepted post-image

    fetched = await task_space_fixture.queries.get_work_item(
        task_space_fixture.scope, item["id"]
    )
    assert fetched.value[PRE_WAITING] == paused  # read projection 与之同源


# --------------------------------------------------------------------------- #
# Step 7 — cross-device: device B pulls the fact and resumes to it (HTTP)
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
        "/api/v1/spaces", json={"name": "Prior State Space"}, headers=master
    )
    assert space.status_code == 201, space.text
    space_id = space.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master
    )
    assert token.status_code == 200, token.text
    return {"Authorization": f"Bearer {token.json()['space_token']}"}, space_id


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_cross_device_prior_state_is_pulled_and_resumable(
    _no_backup_scheduler, client
) -> None:
    headers, space_id = await _setup_space(client)
    # 设备 A / B 都在动作前注册：B 后面的 pull 是**增量**通道。
    await ready_sync_v2_client(client, headers, client_id="prior-device-a")
    device_b = await ready_sync_v2_client(client, headers, client_id="prior-device-b")

    definitions = await client.get("/api/v1/projects/definitions", headers=headers)
    assert definitions.status_code == 200, definitions.text
    status_id = {
        row["category"]: row["id"] for row in definitions.json()["statuses"]
    }

    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "prior-space-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(
                {"key": "PRIOR", "name": "Prior State", "description": None}
            ),
            "key": "prior",
            "name": "Prior State",
        },
        headers={**headers, "Idempotency-Key": "prior-space-project"},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["entityId"]

    root = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": "prior-space-root",
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(
                {
                    "title": "Root",
                    "description": None,
                    "parent_id": None,
                    "type_definition_id": None,
                    "status_definition_id": None,
                    "priority": None,
                }
            ),
            "title": "Root",
        },
        headers={**headers, "Idempotency-Key": "prior-space-root"},
    )
    assert root.status_code == 201, root.text
    root_id = root.json()["value"]["id"]

    child = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": "prior-space-child",
            "spaceId": space_id,
            "projectId": project_id,
            "parentId": root_id,
            "payloadHash": canonical_payload_hash(
                {
                    "title": "Child",
                    "description": None,
                    "parent_id": root_id,
                    "type_definition_id": None,
                    "status_definition_id": None,
                    "priority": None,
                }
            ),
            "title": "Child",
        },
        headers={**headers, "Idempotency-Key": "prior-space-child"},
    )
    assert child.status_code == 201, child.text
    child_value = child.json()["value"]
    child_id = child_value["id"]

    async def transition(command_id: str, status_definition_id: str, version: int):
        return await client.post(
            f"/api/v1/work-items/{child_id}/transition",
            json={
                "commandId": command_id,
                "spaceId": space_id,
                "expectedVersion": version,
                "payloadHash": canonical_payload_hash(
                    {"status_definition_id": status_definition_id}
                ),
                "statusDefinitionId": status_definition_id,
            },
            headers={**headers, "Idempotency-Key": command_id},
        )

    # 设备 A：not_started -> paused -> waiting（服务端记录前态 = paused）。
    paused = await transition("prior-a-paused", status_id["paused"], child_value["version"])
    assert paused.status_code == 200, paused.text
    waiting = await transition(
        "prior-a-waiting", status_id["waiting"], paused.json()["value"]["version"]
    )
    assert waiting.status_code == 200, waiting.text
    assert waiting.json()["value"]["preWaitingStatusDefinitionId"] == status_id["paused"]

    # 设备 B：增量 pull 收到 workItem 事件，payload 携带同一前态 id。
    page = await pull_sync_v2(client, headers, device_b)
    events = [
        event
        for event in page["events"]
        if event["entity_type"] == "workItem" and event["entity_id"] == child_id
    ]
    assert events, page["events"]
    assert events[-1]["payload"][PRE_WAITING] == status_id["paused"]

    # 设备 B：读取投影给出同一前态 id。
    read = await client.get(f"/api/v1/work-items/{child_id}", headers=headers)
    assert read.status_code == 200, read.text
    assert read.json()["preWaitingStatusDefinitionId"] == status_id["paused"]

    # 设备 B：一键恢复（transition 到该 id）成功，且 CAS 生效。
    resume = await transition(
        "prior-b-resume", read.json()["preWaitingStatusDefinitionId"], read.json()["version"]
    )
    assert resume.status_code == 200, resume.text
    assert resume.json()["value"]["statusDefinitionId"] == status_id["paused"]

    stale = await transition(
        "prior-b-stale", status_id["waiting"], read.json()["version"]
    )
    assert stale.status_code != 200
    assert "version_conflict" in stale.text
