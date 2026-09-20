"""TS-02a defect two at the wire: single-label DELETE vs batch Remove over HTTP.

配套 tests/test_task_space_label_address_exactness.py（真实 UoW 的领域级回归），
本模块补**真实 HTTP 路由**那一层（真实 app + space token + UoW + 中间件栈），
按裁决一「拒绝用内存替身冒充交付证据」：

1. 单条 ``DELETE /work-items/{id}/labels/{labelId}``：URL 寻址一个**不存在**的标签、
   声明当前集合不变 ⇒ 200 且零版本变化、零账本事件（旧子集规则下这里是 422）；
2. 同一路由：声明集合同时丢掉**未寻址**的标签 ⇒ 拒绝且零副作用（旧子集规则下这里
   会 200 并把未寻址标签一起删掉）；
3. 批量 ``POST /task-space/commands:batch`` 的 ``work_item.remove_labels`` **不带**
   URL 地址约束 ⇒ 同样的「多删」声明在批量侧按方向门合法执行（证明单标签约束没有
   被误推广到批量）；
4. 单条与批量在同一 declared 集合上的**接受结果一致**（都是收敛到声明的目标集合），
   且 ``labelIds`` 随 post-image 返回、不出现独立的 junction 同步。
"""
from __future__ import annotations

from typing import Any

import pytest

from app.mutation.types import canonical_payload_hash

BATCH_PATH = "/api/v1/task-space/commands:batch"


async def _setup_space_and_headers(client: Any) -> tuple[dict[str, str], str]:
    """Create a Space and return its token headers (mirrors the batch suite)."""
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert login.status_code == 200
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "Address exactness"}, headers=master_headers
    )
    assert created.status_code == 201
    space_id = created.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    assert token.status_code == 200
    return {"Authorization": f"Bearer {token.json()['space_token']}"}, space_id


async def _create_label(client, headers, space_id, command_id: str, name: str) -> str:
    payload = {"name": name, "color": None}
    resp = await client.post(
        "/api/v1/labels",
        json={
            "commandId": command_id,
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(payload),
            **payload,
        },
        headers={**headers, "Idempotency-Key": command_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["value"]["id"]


def _project_key(prefix: str) -> str:
    """A valid project key from a test prefix.

    ``PROJECT_KEY_PATTERN`` is ``^[A-Z][A-Z0-9]{1,9}$`` (app/task_space/contracts.py:110),
    so the human-readable ``prefix`` (which contains hyphens) cannot be used
    directly — strip everything but alphanumerics and cap at 10 characters.
    """
    cleaned = "".join(ch for ch in prefix.upper() if ch.isalnum())
    assert cleaned and cleaned[0].isalpha(), prefix
    return cleaned[:10]


async def _seed_item(client, headers, space_id, *, prefix: str) -> tuple[str, int]:
    """Create a project + one work item; return (work_item_id, version)."""
    project_payload = {"key": _project_key(prefix), "name": prefix, "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": f"{prefix}-proj",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **project_payload,
        },
        headers={**headers, "Idempotency-Key": f"{prefix}-proj"},
    )
    assert project.status_code == 201, project.text
    business = {
        "title": prefix,
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    item = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": f"{prefix}-item",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(business),
            "projectId": project.json()["value"]["id"],
            "title": prefix,
        },
        headers={**headers, "Idempotency-Key": f"{prefix}-item"},
    )
    assert item.status_code == 201, item.text
    return item.json()["value"]["id"], int(item.json()["value"]["version"])


async def _add_labels(
    client, headers, space_id, *, work_item_id: str, version: int, label_ids, prefix: str
) -> int:
    business = {"label_ids": sorted(label_ids)}
    resp = await client.post(
        f"/api/v1/work-items/{work_item_id}/labels",
        json={
            "commandId": f"{prefix}-add",
            "spaceId": space_id,
            "expectedVersion": version,
            "payloadHash": canonical_payload_hash(business),
            "labelIds": sorted(label_ids),
        },
        headers={**headers, "Idempotency-Key": f"{prefix}-add"},
    )
    assert resp.status_code == 200, resp.text
    return int(resp.json()["version"])


@pytest.mark.provisioned_space_storage
async def test_single_label_delete_of_an_absent_label_is_a_wire_noop(client) -> None:
    """current={B}, URL addresses A, declared={B} => 200, nothing changes.

    Under the old subset rule this returned ``label_set_direction_violated``.
    """
    headers, space_id = await _setup_space_and_headers(client)
    label_a = await _create_label(client, headers, space_id, "d2w-la", "WireA")
    label_b = await _create_label(client, headers, space_id, "d2w-lb", "WireB")
    work_item_id, version = await _seed_item(
        client, headers, space_id, prefix="d2w-noop"
    )
    # Only B is on the item; A exists in the Space but was never attached.
    version = await _add_labels(
        client, headers, space_id,
        work_item_id=work_item_id, version=version, label_ids=[label_b],
        prefix="d2w-noop",
    )

    business = {"label_ids": [label_b], "require_removed_label_ids": [label_a]}
    resp = await client.request(
        "DELETE",
        f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
        json={
            "commandId": "d2w-noop-del",
            "spaceId": space_id,
            "expectedVersion": version,
            "payloadHash": canonical_payload_hash(business),
            "labelIds": [label_b],
        },
        headers={**headers, "Idempotency-Key": "d2w-noop-del"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == version
    assert body["value"]["labelIds"] == [label_b]
    read = await client.get(f"/api/v1/work-items/{work_item_id}", headers=headers)
    assert read.status_code == 200
    assert int(read.json()["version"]) == version
    assert read.json()["labelIds"] == [label_b]


@pytest.mark.provisioned_space_storage
async def test_single_label_delete_never_drops_an_unaddressed_label(client) -> None:
    """current={A,B}, URL addresses A, declared={} => rejected, zero effect.

    Under the old subset rule this was accepted and B was really deleted.
    """
    headers, space_id = await _setup_space_and_headers(client)
    label_a = await _create_label(client, headers, space_id, "d2x-la", "WireXA")
    label_b = await _create_label(client, headers, space_id, "d2x-lb", "WireXB")
    work_item_id, version = await _seed_item(
        client, headers, space_id, prefix="d2x-over"
    )
    version = await _add_labels(
        client, headers, space_id,
        work_item_id=work_item_id, version=version,
        label_ids=[label_a, label_b], prefix="d2x-over",
    )

    business = {"label_ids": [], "require_removed_label_ids": [label_a]}
    resp = await client.request(
        "DELETE",
        f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
        json={
            "commandId": "d2x-over-del",
            "spaceId": space_id,
            "expectedVersion": version,
            "payloadHash": canonical_payload_hash(business),
            "labelIds": [],
        },
        headers={**headers, "Idempotency-Key": "d2x-over-del"},
    )
    assert resp.status_code != 200, (
        f"dropping the un-addressed B must be refused, got {resp.status_code}"
    )
    assert resp.json()["detail"]["code"] == "label_set_direction_violated"
    # Zero side effects: both labels still attached, version untouched.
    read = await client.get(f"/api/v1/work-items/{work_item_id}", headers=headers)
    assert read.status_code == 200
    assert sorted(read.json()["labelIds"]) == sorted([label_a, label_b])
    assert int(read.json()["version"]) == version


@pytest.mark.provisioned_space_storage
async def test_exact_single_label_delete_still_converges(client) -> None:
    """current={A,B}, URL addresses A, declared={B} => 200 and really removes A."""
    headers, space_id = await _setup_space_and_headers(client)
    label_a = await _create_label(client, headers, space_id, "d2y-la", "WireYA")
    label_b = await _create_label(client, headers, space_id, "d2y-lb", "WireYB")
    work_item_id, version = await _seed_item(
        client, headers, space_id, prefix="d2y-ok"
    )
    version = await _add_labels(
        client, headers, space_id,
        work_item_id=work_item_id, version=version,
        label_ids=[label_a, label_b], prefix="d2y-ok",
    )

    business = {"label_ids": [label_b], "require_removed_label_ids": [label_a]}
    resp = await client.request(
        "DELETE",
        f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
        json={
            "commandId": "d2y-ok-del",
            "spaceId": space_id,
            "expectedVersion": version,
            "payloadHash": canonical_payload_hash(business),
            "labelIds": [label_b],
        },
        headers={**headers, "Idempotency-Key": "d2y-ok-del"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["value"]["labelIds"] == [label_b]
    read = await client.get(f"/api/v1/work-items/{work_item_id}", headers=headers)
    assert read.json()["labelIds"] == [label_b]
    assert int(read.json()["version"]) == version + 1


@pytest.mark.provisioned_space_storage
async def test_batch_remove_has_no_address_constraint_and_may_drop_any_label(
    client,
) -> None:
    """The batch Remove endpoint keeps the direction rule only — by design.

    Same "declare {} from {A,B}" shape that the single-label route must refuse
    is legal here because there is no URL segment to address: the batch command
    carries no ``require_removed_label_ids`` (schemas/task_space_batch.py), so
    the equality constraint must not leak into it.
    """
    headers, space_id = await _setup_space_and_headers(client)
    label_a = await _create_label(client, headers, space_id, "d2b-la", "BatchA")
    label_b = await _create_label(client, headers, space_id, "d2b-lb", "BatchB")
    work_item_id, version = await _seed_item(
        client, headers, space_id, prefix="d2b-any"
    )
    version = await _add_labels(
        client, headers, space_id,
        work_item_id=work_item_id, version=version,
        label_ids=[label_a, label_b], prefix="d2b-any",
    )

    business = {"label_ids": []}
    batch = {
        "batchId": "d2b-batch",
        "commands": [
            {
                "kind": "work_item.remove_labels",
                "commandId": "d2b-remove",
                "spaceId": space_id,
                "workItemId": work_item_id,
                "expectedVersion": version,
                "payloadHash": canonical_payload_hash(business),
                "labelIds": [],
            }
        ],
    }
    resp = await client.post(
        BATCH_PATH, json=batch, headers={**headers, "Idempotency-Key": "d2b-batch"}
    )
    assert resp.status_code == 200, resp.text
    receipt = resp.json()
    assert receipt["acceptedCount"] == 1, receipt
    assert receipt["rejectedCount"] == 0, receipt
    read = await client.get(f"/api/v1/work-items/{work_item_id}", headers=headers)
    # The batch declaration is authoritative: both labels converge away.
    assert read.json()["labelIds"] == []
    assert int(read.json()["version"]) == version + 1


@pytest.mark.provisioned_space_storage
async def test_single_and_batch_agree_on_the_same_declared_target(client) -> None:
    """Identical declared targets converge to identical post-images over HTTP.

    A fresh item gets {A,B}; the single-label route removes A (declared {B}) and
    a second fresh item gets the same treatment through the batch endpoint.
    Both must land on ``labelIds == [B]`` with the same version delta, and the
    post-image ``labelIds`` must travel on the work-item response itself — the
    junction is never synced as an independent entity (registry/builtin.py:430
    keeps ``work_item_label`` out of the sync-enabled set).
    """
    headers, space_id = await _setup_space_and_headers(client)
    label_a = await _create_label(client, headers, space_id, "d2e-la", "EqA")
    label_b = await _create_label(client, headers, space_id, "d2e-lb", "EqB")

    # (1) single-label route
    single_item, single_version = await _seed_item(
        client, headers, space_id, prefix="d2e-single"
    )
    single_version = await _add_labels(
        client, headers, space_id,
        work_item_id=single_item, version=single_version,
        label_ids=[label_a, label_b], prefix="d2e-single",
    )
    single_business = {
        "label_ids": [label_b],
        "require_removed_label_ids": [label_a],
    }
    single = await client.request(
        "DELETE",
        f"/api/v1/work-items/{single_item}/labels/{label_a}",
        json={
            "commandId": "d2e-single-del",
            "spaceId": space_id,
            "expectedVersion": single_version,
            "payloadHash": canonical_payload_hash(single_business),
            "labelIds": [label_b],
        },
        headers={**headers, "Idempotency-Key": "d2e-single-del"},
    )
    assert single.status_code == 200, single.text

    # (2) batch route, same logical removal, no address constraint
    batch_item, batch_version = await _seed_item(
        client, headers, space_id, prefix="d2e-batch"
    )
    batch_version = await _add_labels(
        client, headers, space_id,
        work_item_id=batch_item, version=batch_version,
        label_ids=[label_a, label_b], prefix="d2e-batch",
    )
    batch_business = {"label_ids": [label_b]}
    batch = await client.post(
        BATCH_PATH,
        json={
            "batchId": "d2e-batch",
            "commands": [
                {
                    "kind": "work_item.remove_labels",
                    "commandId": "d2e-batch-del",
                    "spaceId": space_id,
                    "workItemId": batch_item,
                    "expectedVersion": batch_version,
                    "payloadHash": canonical_payload_hash(batch_business),
                    "labelIds": [label_b],
                }
            ],
        },
        headers={**headers, "Idempotency-Key": "d2e-batch"},
    )
    assert batch.status_code == 200, batch.text
    assert batch.json()["acceptedCount"] == 1, batch.text

    single_read = await client.get(
        f"/api/v1/work-items/{single_item}", headers=headers
    )
    batch_read = await client.get(f"/api/v1/work-items/{batch_item}", headers=headers)
    assert single_read.json()["labelIds"] == [label_b]
    assert batch_read.json()["labelIds"] == [label_b]
    # Same declared target => same version delta on both transports.
    assert int(single_read.json()["version"]) == single_version + 1
    assert int(batch_read.json()["version"]) == batch_version + 1
    # labelIds rides the work-item post-image; nothing syncs the junction alone.
    assert single.json()["value"]["labelIds"] == [label_b]
