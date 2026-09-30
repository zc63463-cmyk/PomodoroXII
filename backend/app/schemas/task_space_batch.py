"""Pydantic wire schemas for the Task Space batch command endpoint (TS-02).

封闭的请求联合与批量响应（roadmap §5 TS-02 接口决策 2/3/7/9）：

- 每条命令有唯一 ``commandId``、操作判别字段 ``kind`` 与该操作所需的既有
  请求字段；字段白名单**逐字继承单条 REST 请求模型**（``extra="forbid"``
  + ``strict``），因此休眠字段（review_point / hard_deadline / …）、项目、
  标签定义、笔记、回收站与会话操作无法借批量 payload 开放。
- 不接收裸 ``MutationRequest`` 或任意字典补丁；``payloadHash`` 与
  ``expectedVersion`` 规则与单条入口一致。
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
