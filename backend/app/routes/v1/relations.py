"""Thin contract router for the WorkItem dependency domain (Relation).

Every write delegates to the TaskSpaceCommandModule as a ``RelationCommand``;
reads are derived projections over the authoritative rows.

★ 派生状态不落库：``blockedByDependency`` / ``isBlocked`` 只由 ``/blocked-map``
  端点按请求计算，绝不进入 workItem 的规范行，也绝不进入同步载荷。
  ``/dependency-graph``（D19-b）同理：纯读派生投影，MindCanvas GraphJsonPayload。

★ 跨 Project 允许、跨 Space 绝对禁止：session 绑定单个 Space 库，编译器又用
  同一个 authority overlay 解析两端，所以"跨 Space"在结构上不可能发生。
  跨 Project 返回的对端一律是 ``WorkItemMinimalProjection``（Phase D 泄露防护）。
"""
from __future__ import annotations

import hashlib
import heapq
import json
from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import select

from app.deps import get_space_runtime_handle
from app.errors import NotFoundError
from app.models.relation import BLOCKING_RELATION_TYPES, Relation
from app.models.work_item import WorkItem
from app.models.work_item_definition import StatusDefinition
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.relation import (
    BlockedMapResponse,
    CreateRelationRequest,
    GraphJsonEdge,
    GraphJsonIndices,
    GraphJsonNode,
    GraphJsonPayload,
    RelationEdgeView,
    RelationResponse,
    RelationSetResponse,
    RemoveRelationRequest,
    ResolveRelationRequest,
    WorkItemMinimalProjection,
)
from app.schemas.task_space import TaskSpaceAcceptedResponse
from app.task_space.contracts import RelationCommand, TaskSpaceAccepted
from app.task_space.queries import _depth_of, derive_blocked_by_dependency

router = APIRouter()

#: 依赖闭包的防御上限（ADR-0008 D19-b）：深链 / 环输入不会拖垮请求。
MAX_GRAPH_NODES = 300


def _space_id(scope) -> str:
    value = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(value, str) or not value:
        raise RuntimeError("authorized Space runtime handle is required")
    return value


def _relation_response(value: Any) -> RelationResponse:
    return RelationResponse(
        id=str(value["id"]),
        space_id=str(value["space_id"]),
        from_work_item_id=str(value["from_work_item_id"]),
        to_work_item_id=str(value["to_work_item_id"]),
        relation_type=str(value["relation_type"]),
        # ★ 2026-09-12（D2 / ADR-0004）：确认两列（DB 行 / 命令后像都必定携带；
        #   缺失即 500 —— fail-loud，不允许静默丢字段）。
        resolution=None if value["resolution"] is None else str(value["resolution"]),
        resolved_at=None if value["resolved_at"] is None else str(value["resolved_at"]),
        version=int(value["version"]),
        created_at=str(value["created_at"]),
        updated_at=str(value["updated_at"]),
    )


async def _map_relation_outcome(outcome, scope) -> TaskSpaceAcceptedResponse:
    if not isinstance(outcome, TaskSpaceAccepted) or outcome.entity_type != "relation":
        return map_task_space_outcome(outcome)
    value = _relation_response(outcome.value).model_dump(by_alias=True)
    return map_task_space_outcome(replace(outcome, value=value))


def _command(
    *,
    operation: str,
    command_id: str,
    space_id: str,
    from_work_item_id: str,
    to_work_item_id: str,
    relation_type: str,
    expected_version: int | None,
    payload_hash: str,
) -> RelationCommand:
    from app.task_space.contracts import relation_id as derive_relation_id

    return RelationCommand(
        operation=operation,
        command_id=command_id,
        space_id=space_id,
        relation_id=derive_relation_id(
            space_id, from_work_item_id, to_work_item_id, relation_type
        ),
        from_work_item_id=from_work_item_id,
        to_work_item_id=to_work_item_id,
        relation_type=relation_type,
        expected_version=expected_version,
        payload_hash=payload_hash,
    )


# --------------------------------------------------------------------------- #
# Reads — declared before /{relation_id} so they are never shadowed
# --------------------------------------------------------------------------- #


@router.get("", response_model=RelationSetResponse)
async def list_relations(
    work_item_id: str = Query(alias="workItemId"),
    query_module: Any = Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> RelationSetResponse:
    """Dual-view projection of one work item's dependency edges."""
    rows = await query_module.list_relations(scope, work_item_id)
    if not rows:
        return RelationSetResponse(blockers=[], blocking=[])

    from sqlalchemy import select

    session_factory = getattr(scope, "session_factory", None)
    if not callable(session_factory):
        raise RuntimeError("authoritative WorkItem rows are required")
    endpoint_ids = sorted({
        str(row["to_work_item_id"]) if str(row["from_work_item_id"]) == work_item_id
        else str(row["from_work_item_id"])
        for row in rows
    })
    async with session_factory() as session:
        result = await session.execute(
            select(WorkItem).where(WorkItem.id.in_(endpoint_ids))
        )
        minimal = {
            str(row.id): WorkItemMinimalProjection(
                id=str(row.id),
                display_key=str(row.display_key),
                project_id=str(row.project_id),
                title=str(row.title),
                status_definition_id=str(row.status_definition_id),
            )
            for row in result.scalars()
        }

    blockers: list[RelationEdgeView] = []
    blocking: list[RelationEdgeView] = []
    for row in rows:
        edge = _relation_response(row)
        if str(row["from_work_item_id"]) == work_item_id:
            endpoint = minimal.get(str(row["to_work_item_id"]))
            if endpoint is not None:
                blockers.append(RelationEdgeView(relation=edge, work_item=endpoint))
        else:
            endpoint = minimal.get(str(row["from_work_item_id"]))
            if endpoint is not None:
                blocking.append(RelationEdgeView(relation=edge, work_item=endpoint))
    return RelationSetResponse(blockers=blockers, blocking=blocking)


@router.get("/blocked-map", response_model=BlockedMapResponse)
async def blocked_map(
    project_id: str | None = Query(default=None, alias="projectId"),
    query_module: Any = Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> BlockedMapResponse:
    """Derived-only blocking projection for the tree (never persisted)."""
    mapping = await query_module.blocked_map(scope, project_id)
    return BlockedMapResponse(items=mapping)


@router.get("/dependency-graph", response_model=GraphJsonPayload)
async def get_dependency_graph(
    work_item_id: str = Query(alias="workItemId"),
    max_depth: int = Query(default=3, ge=1, le=5),
    scope=Depends(get_space_runtime_handle),
) -> GraphJsonPayload:
    """以工作项为锚的依赖闭包 → MindCanvas ``GraphJsonPayload``（ADR-0008 D19-b）。

    ★ 纯读派生投影：不落库、不进同步账本、无任何写副作用 —— 依赖事实源只在
      ``relations`` 表（红线 1）。
    ★ 边方向归一为 **上游 blocker → 下游 blocked**（``direction="fwd"``；DB 规范行
      是 from=被阻断方 / to=阻断方，投影时翻转端点）。在该方向下语义为真的 kind 是
      ``blocks``（``A depends_on B`` ⟺ ``B blocks A``），declared 原文保留在
      ``edge.metadata.declaredAs``。
    ★ ``relates_to`` 不参与阻塞（D12），不入图；已解除确认（``resolution`` 非空）
      的边视为「不再需要」，不入图。
    ★ ``indices.in_degree`` 为标准入度（= 该节点的上游 blocker 数）：入度 0 的
      源头母材由前端 ``graphJsonToMindmap`` 升格为森林中心；拓扑序用 Kahn 算法，
      带环时残留节点按 id 稳定追加在末尾并标 ``metadata.isCyclic``。
    ★ 闭包防御：双向 BFS 波数 ≤ ``max_depth``、节点数 ≤ ``MAX_GRAPH_NODES``。
    """
    session_factory = getattr(scope, "session_factory", None)
    if not callable(session_factory):
        raise RuntimeError("authoritative WorkItem rows are required")

    async with session_factory() as session:
        anchor = await session.get(WorkItem, work_item_id)
        if anchor is None:
            raise NotFoundError("WorkItem not found")

        # 1) 双向 BFS 闭包（波数 = 距锚的依赖距离，≤ max_depth；节点 ≤ 上限）
        closure_ids: set[str] = {work_item_id}
        frontier: set[str] = {work_item_id}
        for _wave in range(max_depth):
            if not frontier or len(closure_ids) >= MAX_GRAPH_NODES:
                break
            rows = (
                await session.execute(
                    select(Relation).where(
                        Relation.relation_type.in_(BLOCKING_RELATION_TYPES),
                        Relation.resolution.is_(None),
                        Relation.from_work_item_id.in_(frontier)
                        | Relation.to_work_item_id.in_(frontier),
                    )
                )
            ).scalars()
            next_frontier: set[str] = set()
            for row in rows:
                for endpoint in (row.from_work_item_id, row.to_work_item_id):
                    endpoint_id = str(endpoint)
                    if endpoint_id not in closure_ids and len(closure_ids) < MAX_GRAPH_NODES:
                        closure_ids.add(endpoint_id)
                        next_frontier.add(endpoint_id)
            frontier = next_frontier

        # 2) 边集：补一遍闭包成员的全部有效阻塞边（波数截断不漏同行边），
        #    只保留两端都在闭包内的；端点归一为 上游(to) → 下游(from)
        incident = (
            await session.execute(
                select(Relation).where(
                    Relation.relation_type.in_(BLOCKING_RELATION_TYPES),
                    Relation.resolution.is_(None),
                    Relation.from_work_item_id.in_(closure_ids)
                    | Relation.to_work_item_id.in_(closure_ids),
                )
            )
        ).scalars()
        raw_rows: list[dict[str, object]] = []
        edge_specs: list[tuple[str, str, str]] = []
        for row in incident:
            upstream = str(row.to_work_item_id)
            downstream = str(row.from_work_item_id)
            if upstream not in closure_ids or downstream not in closure_ids:
                continue  # 端点越出闭包（深度 / 上限截断）
            declared = str(row.relation_type)
            raw_rows.append(
                {
                    "from_work_item_id": downstream,
                    "to_work_item_id": upstream,
                    "relation_type": declared,
                    "resolution": row.resolution,
                }
            )
            edge_specs.append((upstream, downstream, declared))

        # 3) 节点行 + 祖先链（level 沿权威父链派生）+ 状态类目
        item_by_id: dict[str, WorkItem] = {}
        parent_by_id: dict[str, str | None] = {}
        item_status_def: dict[str, str] = {}
        for item in (
            await session.execute(select(WorkItem).where(WorkItem.id.in_(closure_ids)))
        ).scalars():
            item_id = str(item.id)
            item_by_id[item_id] = item
            parent_by_id[item_id] = None if item.parent_id is None else str(item.parent_id)
            item_status_def[item_id] = str(item.status_definition_id)
        missing_parents = {
            parent_id
            for parent_id in parent_by_id.values()
            if parent_id is not None and parent_id not in parent_by_id
        }
        while missing_parents:
            fetched = (
                await session.execute(select(WorkItem).where(WorkItem.id.in_(missing_parents)))
            ).scalars()
            missing_parents = set()
            for item in fetched:
                parent_id = None if item.parent_id is None else str(item.parent_id)
                parent_by_id[str(item.id)] = parent_id
                if parent_id is not None and parent_id not in parent_by_id:
                    missing_parents.add(parent_id)

        status_definition_ids = set(item_status_def.values())
        category_by_definition: dict[str, str] = {}
        if status_definition_ids:
            for definition in (
                await session.execute(
                    select(StatusDefinition).where(StatusDefinition.id.in_(status_definition_ids))
                )
            ).scalars():
                category_by_definition[str(definition.id)] = str(definition.category)
        category_by_work_item: dict[str, str | None] = {
            item_id: category_by_definition.get(definition_id)
            for item_id, definition_id in item_status_def.items()
        }
        blocked_by_dependency = derive_blocked_by_dependency(
            raw_rows, category_by_work_item
        )

        # 4) Kahn 拓扑序（带环回退：残留节点按 id 稳定追加，标 isCyclic）
        in_degree: dict[str, int] = {node_id: 0 for node_id in closure_ids}
        adjacency: dict[str, list[str]] = {node_id: [] for node_id in closure_ids}
        for upstream, downstream, _declared in edge_specs:
            in_degree[downstream] += 1
            adjacency[upstream].append(downstream)
        in_degree_by_node = dict(in_degree)  # 拓扑入度（= 上游 blocker 数），Kahn 用副本
        ready = [node_id for node_id, degree in in_degree.items() if degree == 0]
        heapq.heapify(ready)
        topological: list[str] = []
        while ready:
            node_id = heapq.heappop(ready)
            topological.append(node_id)
            for neighbor in adjacency[node_id]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    heapq.heappush(ready, neighbor)
        cyclic = sorted(closure_ids - set(topological))
        topological_order = topological + cyclic
        cyclic_set = set(cyclic)

        # 5) 载荷组装（确定性：节点/边按 id 排序；source_hash 覆盖实体与边）
        graph_nodes = [
            GraphJsonNode(
                id=item_id,
                label=str(item_by_id[item_id].title),
                level=f"L{_depth_of(item_id, parent_by_id)}",
                kind="work_item",
                file_path=None,
                metadata={
                    "displayKey": str(item_by_id[item_id].display_key),
                    "projectId": str(item_by_id[item_id].project_id),
                    "statusCategory": category_by_work_item.get(item_id),
                    "isBlocked": blocked_by_dependency.get(item_id, False),
                    "isCyclic": item_id in cyclic_set,
                },
            )
            for item_id in sorted(closure_ids)
        ]
        edge_specs.sort()
        graph_edges = [
            GraphJsonEdge(
                from_=upstream,
                to=downstream,
                kind="blocks",
                direction="fwd",
                metadata={"declaredAs": declared},
            )
            for upstream, downstream, declared in edge_specs
        ]
        source_material = json.dumps(
            {
                "nodes": [[node.id, node.label, node.level or ""] for node in graph_nodes],
                "edges": [[edge.from_, edge.to, edge.kind] for edge in graph_edges],
            },
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return GraphJsonPayload(
            version="1.0.0",
            domain="task_space",
            source_hash=hashlib.sha256(source_material.encode("utf-8")).hexdigest(),
            nodes=graph_nodes,
            edges=graph_edges,
            indices=GraphJsonIndices(
                in_degree={node_id: in_degree_by_node[node_id] for node_id in sorted(closure_ids)},
                topological_order=topological_order,
            ),
        )


# --------------------------------------------------------------------------- #
# Writes
# --------------------------------------------------------------------------- #


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_relation(
    body: CreateRelationRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Declare one dependency edge (idempotent: deterministic relation id)."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="create",
        command_id=body.command_id,
        space_id=body.space_id,
        from_work_item_id=body.from_work_item_id,
        to_work_item_id=body.to_work_item_id,
        relation_type=body.relation_type,
        expected_version=None,
        payload_hash=body.payload_hash,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_relation_outcome(outcome, scope)


@router.delete("/{relation_id}", response_model=TaskSpaceAcceptedResponse)
async def remove_relation(
    relation_id: str,
    body: RemoveRelationRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Remove one dependency edge (tombstone propagates through sync)."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="remove",
        command_id=body.command_id,
        space_id=body.space_id,
        from_work_item_id=body.from_work_item_id,
        to_work_item_id=body.to_work_item_id,
        relation_type=body.relation_type,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
    )
    # The path id is authoritative; a mismatched body would silently address
    # a different logical edge (the id is a pure function of the body).
    if command.relation_id != relation_id:
        from app.errors import AppError

        raise AppError(
            code="entity_id_mismatch",
            details={"routeRelationId": relation_id, "bodyRelationId": command.relation_id},
        )
    outcome = await command_module.execute(scope, command)
    return await _map_relation_outcome(outcome, scope)


@router.post("/{relation_id}/resolve", response_model=TaskSpaceAcceptedResponse)
async def resolve_relation(
    relation_id: str,
    body: ResolveRelationRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """确认「已取消的上游不再需要」（幂等 CAS；服务端打戳，见 D2 / ADR-0004）。

    这是 relation 的 resolution / resolved_at 的**唯一**写入通道：客户端不能
    选择 resolution 取值或时间戳（外部 schema extra="forbid"），重复确认是
    零效果回执（无 version bump / 无 sync 事件）。
    """
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="resolve",
        command_id=body.command_id,
        space_id=body.space_id,
        from_work_item_id=body.from_work_item_id,
        to_work_item_id=body.to_work_item_id,
        relation_type=body.relation_type,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
    )
    if command.relation_id != relation_id:
        from app.errors import AppError

        raise AppError(
            code="entity_id_mismatch",
            details={"routeRelationId": relation_id, "bodyRelationId": command.relation_id},
        )
    outcome = await command_module.execute(scope, command)
    return await _map_relation_outcome(outcome, scope)
