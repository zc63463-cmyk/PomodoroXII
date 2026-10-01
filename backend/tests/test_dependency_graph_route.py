"""GET /relations/dependency-graph —— 依赖域上图投影端点（ADR-0008 D19-b）。

门禁断言（对照任务单）：
1. 无依赖时返回当前单节点且 ``in_degree = 0``；
2. ``A depends_on B`` 时：B 的 in_degree = 0（主根）、A 的 in_degree = 1，
   edges 以**实体引用方向归一**输出（上游 blocker → 下游 blocked）；
3. 缺失 Space Token 鉴权时拦截 401/403；
4. 非法 / 不存在的 ``workItemId`` 返回 404。

附加钉：``relates_to`` 不入图（D12）、已解除确认（resolve）的边不入图、
``source_hash`` 确定性（同一状态两次读取同哈希）。
"""
from __future__ import annotations

import uuid

import pytest

from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import relation_id

pytestmark = pytest.mark.provisioned_space_storage


# ── 夹具（与 test_work_maps 同一套真机路径：真建 space / project / workItem）──


async def _master_headers(client) -> dict[str, str]:
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _space(client, master_headers: dict[str, str], name: str) -> dict:
    resp = await client.post("/api/v1/spaces", json={"name": name}, headers=master_headers)
    assert resp.status_code == 201, resp.text
    space = resp.json()
    resp = await client.post(f"/api/v1/spaces/{space['id']}/token", headers=master_headers)
    assert resp.status_code == 200, resp.text
    return {
        "id": space["id"],
        "headers": {"Authorization": f"Bearer {resp.json()['space_token']}"},
    }


async def _project(client, space_headers: dict[str, str], space_id: str, key: str) -> str:
    payload = {"key": key, "name": f"Graph Project {key}", "description": None}
    resp = await client.post(
        "/api/v1/projects",
        json={
            "commandId": f"op-proj-{key}-{uuid.uuid4().hex[:8]}",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(payload),
            **payload,
        },
        headers=space_headers,
    )
    assert resp.status_code in (200, 201), resp.text
    body = resp.json()
    return body.get("entityId") or body.get("entity_id") or body.get("id")


async def _work_item(
    client,
    space_headers: dict[str, str],
    space_id: str,
    project_id: str,
    title: str,
    *,
    parent_id: str | None = None,
) -> str:
    payload = {
        "title": title,
        "description": None,
        "parent_id": parent_id,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    resp = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": f"op-wi-{uuid.uuid4().hex[:12]}",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(payload),
            "projectId": project_id,
            "title": title,
            "parentId": parent_id,
            "typeDefinitionId": None,
            "statusDefinitionId": None,
            "priority": None,
        },
        headers=space_headers,
    )
    assert resp.status_code in (200, 201), resp.text
    body = resp.json()
    return body.get("entityId") or body.get("entity_id") or body.get("id")


def _relation_hash(from_id: str, to_id: str, relation_type: str) -> str:
    return canonical_payload_hash(
        {
            "from_work_item_id": from_id,
            "to_work_item_id": to_id,
            "relation_type": relation_type,
        }
    )


async def _relation(
    client,
    space_headers: dict[str, str],
    space_id: str,
    from_id: str,
    to_id: str,
    relation_type: str = "depends_on",
) -> None:
    """声明一条依赖边（DB 规范：from = 被阻断方，to = 上游 blocker）。"""
    resp = await client.post(
        "/api/v1/relations",
        json={
            "commandId": f"op-rel-{uuid.uuid4().hex[:12]}",
            "spaceId": space_id,
            "payloadHash": _relation_hash(from_id, to_id, relation_type),
            "fromWorkItemId": from_id,
            "toWorkItemId": to_id,
            "relationType": relation_type,
        },
        headers=space_headers,
    )
    assert resp.status_code in (200, 201), resp.text


# ── 门禁用例 ───────────────────────────────────────────────────────────────


async def test_no_dependencies_returns_single_node_with_zero_in_degree(client) -> None:
    """无依赖：闭包只有锚自己，入度 0（它就是森林中心主根）。"""
    master = await _master_headers(client)
    space = await _space(client, master, "graph-solo")
    project = await _project(client, space["headers"], space["id"], "SOLO")
    anchor = await _work_item(client, space["headers"], space["id"], project, "孤点工作项")

    resp = await client.get(
        "/api/v1/relations/dependency-graph",
        params={"workItemId": anchor},
        headers=space["headers"],
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()

    assert payload["domain"] == "task_space"
    assert payload["version"] == "1.0.0"
    assert [node["id"] for node in payload["nodes"]] == [anchor]
    assert payload["nodes"][0]["kind"] == "work_item"
    assert payload["nodes"][0]["label"] == "孤点工作项"
    assert payload["edges"] == []
    assert payload["indices"]["in_degree"] == {anchor: 0}
    assert payload["indices"]["topological_order"] == [anchor]
    # 确定性：同状态两次读取 source_hash 一致
    again = await client.get(
        "/api/v1/relations/dependency-graph",
        params={"workItemId": anchor},
        headers=space["headers"],
    )
    assert again.json()["source_hash"] == payload["source_hash"]


async def test_a_depends_on_b_b_is_root_with_zero_in_degree(client) -> None:
    """A depends_on B：边归一为 B→A（上游→下游）；B 入度 0（主根）、A 入度 1。"""
    master = await _master_headers(client)
    space = await _space(client, master, "graph-chain")
    project = await _project(client, space["headers"], space["id"], "CHAIN")
    item_a = await _work_item(client, space["headers"], space["id"], project, "下游 A")
    item_b = await _work_item(client, space["headers"], space["id"], project, "上游 B")
    await _relation(client, space["headers"], space["id"], item_a, item_b, "depends_on")

    resp = await client.get(
        "/api/v1/relations/dependency-graph",
        params={"workItemId": item_a},
        headers=space["headers"],
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()

    assert sorted(node["id"] for node in payload["nodes"]) == sorted([item_a, item_b])
    assert payload["indices"]["in_degree"][item_b] == 0
    assert payload["indices"]["in_degree"][item_a] == 1

    assert len(payload["edges"]) == 1
    edge = payload["edges"][0]
    assert edge["from"] == item_b  # 上游 blocker
    assert edge["to"] == item_a  # 下游 blocked
    assert edge["direction"] == "fwd"
    assert edge["metadata"]["declaredAs"] == "depends_on"
    # 主根 = 入度 0 的源头母材（Kahn 首位）
    assert payload["indices"]["topological_order"][0] == item_b


async def test_missing_space_token_is_rejected(client) -> None:
    resp = await client.get(
        "/api/v1/relations/dependency-graph",
        params={"workItemId": "whatever"},
    )
    assert resp.status_code in (401, 403), resp.text


async def test_unknown_work_item_is_404(client) -> None:
    master = await _master_headers(client)
    space = await _space(client, master, "graph-404")
    resp = await client.get(
        "/api/v1/relations/dependency-graph",
        params={"workItemId": "wi-does-not-exist"},
        headers=space["headers"],
    )
    assert resp.status_code == 404, resp.text


async def test_relates_to_and_resolved_edges_are_excluded(client) -> None:
    """「有效 Relation 记录」：relates_to 不参与阻塞（D12）；解除确认的边不入图。"""
    master = await _master_headers(client)
    space = await _space(client, master, "graph-valid")
    project = await _project(client, space["headers"], space["id"], "VALID")
    item_a = await _work_item(client, space["headers"], space["id"], project, "A")
    item_b = await _work_item(client, space["headers"], space["id"], project, "B")
    item_c = await _work_item(client, space["headers"], space["id"], project, "C")
    item_d = await _work_item(client, space["headers"], space["id"], project, "D")
    # A depends_on B（有效，应入图）；A relates_to C（不入图）；D depends_on A 后解除（不入图）
    await _relation(client, space["headers"], space["id"], item_a, item_b, "depends_on")
    await _relation(client, space["headers"], space["id"], item_a, item_c, "relates_to")
    await _relation(client, space["headers"], space["id"], item_d, item_a, "depends_on")

    resolved = relation_id(space["id"], item_d, item_a, "depends_on")
    resp = await client.post(
        f"/api/v1/relations/{resolved}/resolve",
        json={
            "commandId": f"op-resolve-{uuid.uuid4().hex[:12]}",
            "spaceId": space["id"],
            "expectedVersion": 1,
            # ★ relation 命令的 business payload 恒为 (from, to, type) 三元组，
            #   expected_version 不进哈希（app/task_space/module.py::_business_payload）。
            "payloadHash": _relation_hash(item_d, item_a, "depends_on"),
            "fromWorkItemId": item_d,
            "toWorkItemId": item_a,
            "relationType": "depends_on",
        },
        headers=space["headers"],
    )
    assert resp.status_code in (200, 201), resp.text

    graph = await client.get(
        "/api/v1/relations/dependency-graph",
        params={"workItemId": item_a},
        headers=space["headers"],
    )
    assert graph.status_code == 200, graph.text
    payload = graph.json()
    edges = [(edge["from"], edge["to"]) for edge in payload["edges"]]
    assert edges == [(item_b, item_a)]
