"""TS-02 REST batch write: command preparation, pre-rejection, receipt mapping.

批量领域适配（roadmap §5 TS-02）。职责边界：

- **准备**：把封闭的 ``TaskSpaceCommand`` 联合编译为 ``MutationRequest``
  （复用单条入口的 ``build_task_space_request``），再包成
  ``PreparedBatchItem`` 进入 ``MutationUnitOfWork.execute_prepared_batch``。
  绝不循环调用单条 ``execute`` 冒充批量 —— 提交、恢复与账本可见性完全由
  现有 UoW 批量语义管理，不新增 ``atomic=true``。
- **预拒**：声明式 ``payload_hash`` 校验失败在进入编译前即拒绝
  （``invalid_payload_hash``），作为 ``pre_rejection`` 随批持久化 ——
  预拒同样进入持久回执；预拒项的 intent 哈希取其 canonical 业务载荷，
  因此「改内容重试」不会命中旧回执（内容参与幂等绑定）。
- **回执映射**：``BatchMutationResult``（applied / rejected）按 commandId
  映射回输入位置；接受项使用各命令**当时的持久结果**（journal 的
  result_value / 重放时的持久镜像），不查询当前行冒充每一步结果。

批量上限常量在 :mod:`app.task_space.contracts`（schema / REST / MCP 共用）。
"""
from __future__ import annotations

from app.errors import ValidationError
from app.mutation.types import (
    BatchMutationResult,
    InvalidPayloadHashError,
    MutationRejection,
    PreparedBatchItem,
)
from app.mutation.unit_of_work import MutationUnitOfWork
from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    CreateProject,
    CreateWorkItem,
    LabelCommand,
    MutateWorkItem,
    RelationCommand,
    TaskSpaceAccepted,
    TaskSpaceBatchItemOutcome,
    TaskSpaceBatchOutcome,
    TaskSpaceCommand,
    TaskSpaceRejected,
    WorkItemNoteCommand,
)
from app.task_space.module import (
    accepted_outcome,
    build_task_space_request,
)

#: 领域入口的结构性拒绝消息（HTTP 与后续 MCP 共用，避免各入口自造文案）。
BATCH_EMPTY_MESSAGE = "Task Space batch requires a non-empty command list"
BATCH_DUPLICATE_IDS_MESSAGE = "Task Space batch command IDs must be unique"


def _request_entity_id(command: TaskSpaceCommand) -> str:
    """The entity id ``build_task_space_request`` would address (for receipts)."""
    if isinstance(command, (CreateProject, CreateWorkItem)):
        return command.command_id
    if isinstance(command, MutateWorkItem):
        return command.work_item_id or command.command_id
    if isinstance(command, WorkItemNoteCommand):
        return command.work_item_id
    if isinstance(command, RelationCommand):
        return command.relation_id
    if isinstance(command, LabelCommand):
        return command.command_id if command.operation == "create" else str(command.label_id)
    raise TypeError(f"unsupported TaskSpaceCommand: {type(command).__name__}")


def _pre_rejected_item(
    index: int, command: TaskSpaceCommand, intent_hash: str, reason: str
) -> PreparedBatchItem:
    """Persist a hash pre-rejection as the command's durable receipt entry."""
    rejection = MutationRejection(
        request_index=index,
        operation_id=command.command_id,
        entity_type="task_space",
        entity_id=_request_entity_id(command),
        code="invalid_payload_hash",
        retryable=False,
        details={"reason": reason},
    )
    # 预拒项没有合法请求，但幂等绑定必须与正常项同等严格：intent 取
    # ``build_task_space_request`` 在**跳过 hash 比对**时算出的 request_hash ——
    # 它覆盖 name / entity_type / entity_id / payload（含 space_id、业务字段与
    # 声明 hash）/ expected_version。因此只改 expectedVersion 或 spaceId 的重试
    # 会得到不同的批哈希，按「改变内容」稳定拒绝，而不是命中旧回执。
    return PreparedBatchItem(
        request_index=index,
        operation_id=command.command_id,
        intent_hash=intent_hash,
        request=None,
        pre_rejection=rejection,
    )


def prepare_batch_items(
    commands: tuple[TaskSpaceCommand, ...],
) -> tuple[PreparedBatchItem, ...]:
    """Compile every command into a PreparedBatchItem (request or pre-rejection)."""
    items: list[PreparedBatchItem] = []
    for index, command in enumerate(commands):
        try:
            request = build_task_space_request(command)
        except InvalidPayloadHashError as exc:
            unverified = build_task_space_request(
                command, verify_payload_hash=False
            )
            items.append(
                _pre_rejected_item(index, command, unverified.request_hash, str(exc))
            )
        else:
            items.append(
                PreparedBatchItem(
                    request_index=index,
                    operation_id=command.command_id,
                    intent_hash=request.request_hash,
                    request=request,
                    pre_rejection=None,
                )
            )
    return tuple(items)


def map_batch_result(
    commands: tuple[TaskSpaceCommand, ...], result: BatchMutationResult
) -> TaskSpaceBatchOutcome:
    """Map the UoW batch result back to per-position domain outcomes."""
    applied = {item.operation_id: item for item in result.applied}
    rejected = {item.operation_id: item for item in result.rejected}
    items: list[TaskSpaceBatchItemOutcome] = []
    for index, command in enumerate(commands):
        command_id = command.command_id
        mutation = applied.get(command_id)
        if mutation is not None:
            outcome: TaskSpaceAccepted | TaskSpaceRejected = accepted_outcome(
                command, mutation.value
            )
        else:
            rejection = rejected.get(command_id)
            if rejection is None:
                raise RuntimeError(
                    f"batch receipt has no outcome for command {command_id!r}"
                )
            outcome = TaskSpaceRejected(
                command_id=command_id,
                code=rejection.code,
                retryable=rejection.retryable,
                details=rejection.details,
            )
        items.append(TaskSpaceBatchItemOutcome(input_index=index, outcome=outcome))
    return TaskSpaceBatchOutcome(batch_id=result.batch_id, items=tuple(items))


class DefaultTaskSpaceBatchCommandModule:
    """Batch adapter over the shared MutationUnitOfWork (production binding).

    每批恰好一次 ``execute_prepared_batch``：按输入顺序编译、后项可见前面
    已接受命令的 overlay、允许部分业务接受 —— 全部是 UoW 的既有批量语义。

    结构性拒绝（空批 / 重复 commandId）在**领域入口**就给出稳定错误码
    （``validation_error``，HTTP 422），而不是裸 ``ValueError``：HTTP 路由与
    后续 MCP 写工具共用同一入口，任何调用方都应拿到可读、可映射的错误，
    不能依赖各 transport 各自重复校验。
    """

    def __init__(self, uow: MutationUnitOfWork) -> None:
        self._uow = uow

    async def execute_batch(
        self,
        scope: SpaceRuntimeHandle,
        commands: tuple[TaskSpaceCommand, ...],
        batch_id: str,
    ) -> TaskSpaceBatchOutcome:
        resolved = tuple(commands)
        if not resolved:
            raise ValidationError(BATCH_EMPTY_MESSAGE)
        command_ids = [command.command_id for command in resolved]
        if len(set(command_ids)) != len(command_ids):
            raise ValidationError(BATCH_DUPLICATE_IDS_MESSAGE)
        items = prepare_batch_items(resolved)
        result = await self._uow.execute_prepared_batch(scope, items, batch_id)
        return map_batch_result(resolved, result)
