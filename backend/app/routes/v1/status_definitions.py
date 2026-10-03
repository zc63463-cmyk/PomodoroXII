"""Thin contract router for Status definition CRUD（状态双轴阶段 2）。

★ 与 labels.py 的差别
  1. 载荷多``category``（**固定轴取值**，用户不能发明新轴）与 ``icon``/``rank``。
  2. 多一个 ``reorder`` 端点—— status 有 rank 且用户期望组内拖动；
     label 只能追加（按 name 排序）。
  3. archive 带**引用守卫**（有 work_items 指向时拒绝），由编译器判定。

每个写操作都委派给 TaskSpaceCommandModule via StatusCommand，
编译成 typed ``task_space.*StatusDefinition`` 请求，再编成
``statusDefinition`` sync 事件（★ camel，与 overlay 的 snake 不同层）。
"""
from __future__ import annotations

from dataclasses import replace

from fastapi import APIRouter, Depends, Header

from app.deps import get_space_runtime_handle
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space import (
    ArchiveStatusDefinitionRequest,
    CreateStatusDefinitionRequest,
    ReorderStatusDefinitionRequest,
    StatusDefinitionResponse,
    TaskSpaceAcceptedResponse,
    UpdateStatusDefinitionRequest,
)
from app.task_space.contracts import (
    StatusCommand,
    TaskSpaceAccepted,
    TaskSpaceOutcome,
)

router = APIRouter()


def _space_id(scope) -> str:
    value = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(value, str) or not value:
        raise RuntimeError("authorized Space runtime handle is required")
    return value


def _status_response(value, space_id: str) -> StatusDefinitionResponse:
    return StatusDefinitionResponse(
        id=str(value["id"]),
        name=str(value["name"]),
        category=str(value["category"]),
        icon=value["icon"],
        color=value["color"],
        rank=int(value["rank"]),
        system=bool(value["system"]),
        archived_at=value["archived_at"],
        version=int(value["version"]),
        created_at=str(value["created_at"]),
        updated_at=str(value["updated_at"]),
    )


async def _map_status_outcome(
    outcome: TaskSpaceOutcome,
    scope,
    space_id: str,
) -> TaskSpaceAcceptedResponse:
    """Enrich an accepted response with the full status definition view."""
    if (
        not isinstance(outcome, TaskSpaceAccepted)
        or outcome.entity_type != "status_definition"
    ):
        return map_task_space_outcome(outcome)
    value = _status_response(outcome.value, space_id).model_dump(by_alias=True)
    return map_task_space_outcome(replace(outcome, value=value))


def _command(
    *,
    operation: str,
    command_id: str,
    space_id: str,
    status_id: str | None,
    expected_version: int | None,
    payload_hash: str,
    payload: dict[str, object],
) -> StatusCommand:
    return StatusCommand(
        operation=operation,
        command_id=command_id,
        space_id=space_id,
        status_id=status_id,
        expected_version=expected_version,
        payload_hash=payload_hash,
        payload=payload,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_status_definition(
    body: CreateStatusDefinitionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Create a status definition under an existing (fixed-axis) category."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="create",
        command_id=body.command_id,
        space_id=body.space_id,
        status_id=None,
        expected_version=None,
        payload_hash=body.payload_hash,
        payload={
            "name": body.name,
            "category": body.category,
            "icon": body.icon,
            "color": body.color,
        },
    )
    outcome = await command_module.execute(scope, command)
    return await _map_status_outcome(outcome, scope, _space_id(scope))


@router.patch("/{status_id}", response_model=TaskSpaceAcceptedResponse)
async def update_status_definition(
    status_id: str,
    body: UpdateStatusDefinitionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Update mutable fields of a status definition."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    payload: dict[str, object] = {}
    for field_name in ("name", "category", "icon", "color"):
        if field_name in body.model_fields_set:
            payload[field_name] = getattr(body, field_name)
    command = _command(
        operation="update",
        command_id=body.command_id,
        space_id=body.space_id,
        status_id=status_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload=payload,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_status_outcome(outcome, scope, _space_id(scope))


@router.post("/{status_id}/reorder", response_model=TaskSpaceAcceptedResponse)
async def reorder_status_definition(
    status_id: str,
    body: ReorderStatusDefinitionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Move a status to a target position **within its own category**.

    ★ 不带 expected_version：这是集合级操作，逐行 CAS 会让并发 reorder 互相打架。
    """
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="reorder",
        command_id=body.command_id,
        space_id=body.space_id,
        status_id=status_id,
        expected_version=None,
        payload_hash=body.payload_hash,
        payload={"rank": body.rank},
    )
    outcome = await command_module.execute(scope, command)
    return await _map_status_outcome(outcome, scope, _space_id(scope))


@router.post("/{status_id}/archive", response_model=TaskSpaceAcceptedResponse)
async def archive_status_definition(
    status_id: str,
    body: ArchiveStatusDefinitionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Archive a status definition.

    Rejected when work items still reference it (the compiler enforces it);
    archiving a live status would leave those items pointing at an
    archived row and the label would vanish from their UI.
    """
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _command(
        operation="archive",
        command_id=body.command_id,
        space_id=body.space_id,
        status_id=status_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={},
    )
    outcome = await command_module.execute(scope, command)
    return await _map_status_outcome(outcome, scope, _space_id(scope))