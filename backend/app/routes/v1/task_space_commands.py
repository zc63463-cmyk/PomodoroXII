"""Thin contract router for the Task Space batch write endpoint (TS-02).

``POST /api/v1/task-space/commands:batch`` —— 只操作授权的一个 Space：

- **认证与空间验证**：Space token 打开授权运行时句柄；每条命令的
  ``spaceId`` 必须与授权 Space 一致（跨空间内容在执行前整体拒绝）。
- **容量验证**：命令数上限与规范化（RFC 8785 canonical JSON）批内容
  字节上限由 ``app.task_space.contracts`` 常量约束；请求体字节上限由
  全局 ``BodySizeLimitMiddleware`` 在解析前执行。
- **薄路由**：把封闭请求联合转换为领域命令（复用单条 REST 的字段白名单
  与 server 持有字段规则），一次委托批量模块；HTTP 200 返回完整业务回执。
  外层结构错误走明确的 HTTP 错误，不包装成成功。
"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header

from app.deps import get_space_runtime_handle
from app.errors import ValidationError, to_wire_json
from app.mutation.types import canonical_json_bytes
from app.routes.v1.contract_dependencies import (
    get_task_space_batch_command_module,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space_batch import (
    BatchAddWorkItemLabelsCommand,
    BatchCreateRelationCommand,
    BatchCreateWorkItemCommand,
    BatchMoveWorkItemCommand,
    BatchRemoveRelationCommand,
    BatchRemoveWorkItemLabelsCommand,
    BatchResolveRelationCommand,
    BatchTransitionWorkItemCommand,
    BatchUpdateWorkItemCommand,
    TaskSpaceBatchAcceptedItem,
    TaskSpaceBatchCommand,
    TaskSpaceBatchRejectedItem,
    TaskSpaceBatchRequest,
    TaskSpaceBatchResponse,
)
from app.task_space.batch import BATCH_DUPLICATE_IDS_MESSAGE
from app.task_space.contracts import (
    TASK_SPACE_BATCH_MAX_CANONICAL_BYTES,
    CreateWorkItem,
    MutateWorkItem,
    RelationCommand,
    TaskSpaceAccepted,
    TaskSpaceBatchOutcome,
    TaskSpaceCommand,
)
from app.task_space.contracts import (
    relation_id as derive_relation_id,
)

router = APIRouter()


def _domain_command(command: TaskSpaceBatchCommand) -> TaskSpaceCommand:
    """Convert one wire batch command into the closed domain command union.

    Field construction mirrors the single-command REST routes exactly (same
    payload shapes, same server-owned-field rules), so a batch command and the
    equivalent single request produce identical MutationRequests — and
    therefore identical hash / version / idempotency behavior.
    """
    if isinstance(command, BatchCreateWorkItemCommand):
        return CreateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            project_id=command.project_id,
            title=command.title,
            description=command.description,
            parent_id=command.parent_id,
            type_definition_id=command.type_definition_id,
            status_definition_id=command.status_definition_id,
            priority=command.priority,
            payload_hash=command.payload_hash,
        )
    if isinstance(command, BatchUpdateWorkItemCommand):
        # Only explicitly provided fields enter the patch: an explicit null
        # clears, an omitted field is left untouched (single-PATCH semantics).
        patch: dict[str, Any] = {
            field: getattr(command, field)
            for field in ("title", "description", "priority", "type_definition_id")
            if field in command.model_fields_set
        }
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={"operation": "update", "patch": patch},
        )
    if isinstance(command, BatchMoveWorkItemCommand):
        # child_rank is server-assigned online; the wire whitelist rejects it.
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "move",
                "project_id": command.project_id,
                "new_parent_id": command.parent_id,
            },
        )
    if isinstance(command, BatchTransitionWorkItemCommand):
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "transition",
                "status_definition_id": command.status_definition_id,
            },
        )
    if isinstance(command, BatchAddWorkItemLabelsCommand):
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "add_labels",
                "label_ids": sorted(command.label_ids),
            },
        )
    if isinstance(command, BatchRemoveWorkItemLabelsCommand):
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "remove_labels",
                "label_ids": sorted(command.label_ids),
            },
        )
    if isinstance(
        command, (BatchCreateRelationCommand, BatchRemoveRelationCommand, BatchResolveRelationCommand)
    ):
        return RelationCommand(
            operation=command.kind.removeprefix("relation."),
            command_id=command.command_id,
            space_id=command.space_id,
            relation_id=derive_relation_id(
                command.space_id,
                command.from_work_item_id,
                command.to_work_item_id,
                command.relation_type,
            ),
            from_work_item_id=command.from_work_item_id,
            to_work_item_id=command.to_work_item_id,
            relation_type=command.relation_type,
            expected_version=(
                None if command.kind == "relation.create" else command.expected_version
            ),
            payload_hash=command.payload_hash,
        )
    raise TypeError(f"unsupported batch command: {type(command).__name__}")


def _batch_response(outcome: TaskSpaceBatchOutcome) -> TaskSpaceBatchResponse:
    """Map the domain batch outcome union to the wire receipt (input order)."""
    items: list[TaskSpaceBatchAcceptedItem | TaskSpaceBatchRejectedItem] = []
    accepted_count = 0
    for item in outcome.items:
        outcome_value = item.outcome
        if isinstance(outcome_value, TaskSpaceAccepted):
            accepted_count += 1
            items.append(
                TaskSpaceBatchAcceptedItem(
                    status="accepted",
                    input_index=item.input_index,
                    command_id=outcome_value.command_id,
                    entity_type=outcome_value.entity_type,
                    entity_id=outcome_value.entity_id,
                    version=outcome_value.version,
                    value=to_wire_json(outcome_value.value),
                )
            )
        else:
            items.append(
                TaskSpaceBatchRejectedItem(
                    status="rejected",
                    input_index=item.input_index,
                    command_id=outcome_value.command_id,
                    code=outcome_value.code,
                    retryable=outcome_value.retryable,
                    details=to_wire_json(outcome_value.details),
                )
            )
    return TaskSpaceBatchResponse(
        batch_id=outcome.batch_id,
        accepted_count=accepted_count,
        rejected_count=len(items) - accepted_count,
        items=items,
    )


@router.post("/commands:batch", response_model=TaskSpaceBatchResponse)
async def execute_task_space_commands_batch(
    body: TaskSpaceBatchRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    batch_module: Any = Depends(get_task_space_batch_command_module),
    scope: Any = Depends(get_space_runtime_handle),
) -> TaskSpaceBatchResponse:
    """Execute one closed batch of Task Space commands (partial acceptance).

    正常进入领域处理后，hash/版本/业务规则拒绝映射为逐项回执；接受集合的
    提交、恢复与账本可见性由现有 UoW 批量语义管理。
    """
    require_idempotency_key(body.batch_id, idempotency_key)
    command_ids = [command.command_id for command in body.commands]
    if len(set(command_ids)) != len(command_ids):
        # 与领域入口共用同一条消息常量：路由先行拒绝只是为了「不打开目标存储」，
        # 直接调用领域模块的 transport（后续 MCP 写工具）拿到同一稳定错误码。
        raise ValidationError(BATCH_DUPLICATE_IDS_MESSAGE)
    for command in body.commands:
        require_space_identity(scope, command.space_id)
    normalized = canonical_json_bytes([
        command.model_dump(by_alias=True, mode="json") for command in body.commands
    ])
    if len(normalized) > TASK_SPACE_BATCH_MAX_CANONICAL_BYTES:
        raise ValidationError(
            "Task Space batch canonical content exceeds the 1 MiB budget"
        )
    domain_commands = tuple(_domain_command(command) for command in body.commands)
    outcome = await batch_module.execute_batch(
        scope, domain_commands, body.batch_id
    )
    return _batch_response(outcome)
