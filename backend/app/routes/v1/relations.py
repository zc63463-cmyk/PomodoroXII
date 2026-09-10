"""Thin contract router for the WorkItem dependency domain (Relation).

Every write delegates to the TaskSpaceCommandModule as a ``RelationCommand``;
reads are derived projections over the authoritative rows.

★ 派生状态不落库：``blockedByDependency`` / ``isBlocked`` 只由 ``/blocked-map``
  端点按请求计算，绝不进入 workItem 的规范行，也绝不进入同步载荷。

★ 跨 Project 允许、跨 Space 绝对禁止：session 绑定单个 Space 库，编译器又用
  同一个 authority overlay 解析两端，所以"跨 Space"在结构上不可能发生。
  跨 Project 返回的对端一律是 ``WorkItemMinimalProjection``（Phase D 泄露防护）。
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, Header, Query

from app.deps import get_space_runtime_handle
from app.models.work_item import WorkItem
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
    RelationEdgeView,
    RelationResponse,
    RelationSetResponse,
    RemoveRelationRequest,
    WorkItemMinimalProjection,
)
from app.schemas.task_space import TaskSpaceAcceptedResponse
from app.task_space.contracts import RelationCommand, TaskSpaceAccepted

router = APIRouter()


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
