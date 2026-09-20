"""Pydantic wire schemas for the Task Space batch command endpoint (TS-02).

封闭的请求联合与批量响应（roadmap §5 TS-02 接口决策 2/3/7/9）：

- 每条命令有唯一 ``commandId``、操作判别字段 ``kind`` 与该操作所需的既有
  请求字段；字段白名单**逐字继承单条 REST 请求模型**（``extra="forbid"``
  + ``strict``），因此休眠字段（review_point / hard_deadline / …）、项目、
  标签定义、笔记、回收站与会话操作无法借批量 payload 开放。
- 不接收裸 ``MutationRequest`` 或任意字典补丁；``payloadHash`` 与
  ``expectedVersion`` 规则与单条入口一致。
- ``work_item.add_labels`` / ``work_item.remove_labels`` 的 ``labelIds`` 与
  单条 REST 同义：**本次命令完成后的完整目标集合**（TS-02a / 裁决一）。批量
  入口只做顺序规范化，绝不把它翻译成差量；方向约束由编译器按权威集合判定。
- ★ 与单条 REST 的**唯一**差异（有意，非疏漏）：单标签 DELETE 路由
  （``DELETE /work-items/{id}/labels/{label_id}``）的 URL 段是一个**寻址约束**
  —— 它随命令进入 canonical 业务载荷（``require_removed_label_ids``），由编译器
  在加锁事务内校验「该标签确实已从目标集合消失」。批量命令没有 URL，因此**不
  携带**该字段：它只能表达「收敛到哪个集合」，不能表达「必须消失的是哪一个」。
  两者的**集合语义相同**（裁决一第 24 行「不允许按 transport 猜测」指的就是这
  一层），差别仅在单条路径多一个由 URL 身份派生的地址约束；因此同一逻辑操作经
  两条 transport 的 canonical payload 在该字段上不同，payloadHash 也随之不同。
  这是刻意设计：寻址约束是路径身份，不是业务内容，批量本就没有可寻址的路径段。
- 批量上限由 ``app.task_space.contracts`` 常量约束（schema / REST / MCP
  共用单一事实来源）。
- 回执使用独立批量 schema：逐项 ``inputIndex`` + ``commandId`` +
  ``accepted/rejected`` + 版本或稳定错误码；**不**套用含派生 depth 的完整
  WorkItem REST 读模型，value 直接携带领域 post-image。
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import Field

from app.schemas.relation import (
    CreateRelationRequest,
    RemoveRelationRequest,
    ResolveRelationRequest,
)
from app.schemas.task_space import (
    AddWorkItemLabelsRequest,
    CommandId,
    CreateWorkItemRequest,
    MoveWorkItemRequest,
    RemoveWorkItemLabelsRequest,
    TransitionWorkItemRequest,
    UpdateWorkItemRequest,
    WireModel,
    WireResponseModel,
)
from app.task_space.contracts import (
    TASK_SPACE_BATCH_MAX_COMMANDS,
)

# --------------------------------------------------------------------------- #
# Batch command union — kind-discriminated, closed, per-operation whitelist
# --------------------------------------------------------------------------- #


class BatchCreateWorkItemCommand(CreateWorkItemRequest):
    """Create one work item (entity id remains server-derived from commandId)."""

    kind: Literal["work_item.create"]


class _BatchWorkItemTarget(WireModel):
    """Commands that address an existing work item carry its id in-band."""

    work_item_id: str = Field(min_length=1, max_length=64)


class BatchUpdateWorkItemCommand(UpdateWorkItemRequest, _BatchWorkItemTarget):
    kind: Literal["work_item.update"]


class BatchMoveWorkItemCommand(MoveWorkItemRequest, _BatchWorkItemTarget):
    kind: Literal["work_item.move"]


class BatchTransitionWorkItemCommand(TransitionWorkItemRequest, _BatchWorkItemTarget):
    kind: Literal["work_item.transition"]


class BatchAddWorkItemLabelsCommand(AddWorkItemLabelsRequest, _BatchWorkItemTarget):
    kind: Literal["work_item.add_labels"]


class BatchRemoveWorkItemLabelsCommand(RemoveWorkItemLabelsRequest, _BatchWorkItemTarget):
    kind: Literal["work_item.remove_labels"]


class BatchCreateRelationCommand(CreateRelationRequest):
    kind: Literal["relation.create"]


class BatchRemoveRelationCommand(RemoveRelationRequest):
    kind: Literal["relation.remove"]


class BatchResolveRelationCommand(ResolveRelationRequest):
    kind: Literal["relation.resolve"]


TaskSpaceBatchCommand = Annotated[
    Union[
        BatchCreateWorkItemCommand,
        BatchUpdateWorkItemCommand,
        BatchMoveWorkItemCommand,
        BatchTransitionWorkItemCommand,
        BatchAddWorkItemLabelsCommand,
        BatchRemoveWorkItemLabelsCommand,
        BatchCreateRelationCommand,
        BatchRemoveRelationCommand,
        BatchResolveRelationCommand,
    ],
    Field(discriminator="kind"),
]


class TaskSpaceBatchRequest(WireModel):
    """One closed batch against exactly one authorized Space."""

    batch_id: CommandId
    commands: list[TaskSpaceBatchCommand] = Field(
        min_length=1, max_length=TASK_SPACE_BATCH_MAX_COMMANDS
    )


# --------------------------------------------------------------------------- #
# Batch receipt — independent schema (not the full WorkItem read model)
# --------------------------------------------------------------------------- #


class TaskSpaceBatchAcceptedItem(WireResponseModel):
    status: Literal["accepted"]
    input_index: int = Field(ge=0)
    command_id: str
    entity_type: str
    entity_id: str
    version: int
    value: dict[str, Any]


class TaskSpaceBatchRejectedItem(WireResponseModel):
    status: Literal["rejected"]
    input_index: int = Field(ge=0)
    command_id: str
    code: str
    retryable: bool
    details: dict[str, Any]


TaskSpaceBatchItem = Annotated[
    Union[TaskSpaceBatchAcceptedItem, TaskSpaceBatchRejectedItem],
    Field(discriminator="status"),
]


class TaskSpaceBatchResponse(WireResponseModel):
    """HTTP 200 full business receipt: one item per input position."""

    batch_id: str
    accepted_count: int = Field(ge=0)
    rejected_count: int = Field(ge=0)
    items: list[TaskSpaceBatchItem]
