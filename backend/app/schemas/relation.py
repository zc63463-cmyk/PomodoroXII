"""Pydantic wire schemas for the dependency domain (Relation).

★ 为什么单独成模块而不是塞进 ``task_space.py``
  门禁 ``tests/test_parity_registry_schemas.py`` 要求每个 BUSINESS 实体都有
   可导入的 ``app.schemas.<name>`` 模块，且导出 ``<Name>Response``。
   ``relation`` 是独立注册的 BUSINESS 实体，就必须有自己的 schema 模块 ——
   塞在 task_space 里会被 parity 门禁判红。

★ 依赖方向是单向的：本模块 import ``app.schemas.task_space``（复用
   ``WireModel`` / ``WireResponseModel`` / ``CommandId``），
   ``task_space`` **不**反向 import 本模块，避免循环导入。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.task_space import CommandId, WireModel, WireResponseModel

#: 首版开放的三类边。``relates_to`` 不参与阻塞计算与环检测（D12/D13）。
RelationTypeLiteral = Literal["depends_on", "blocks", "relates_to"]


class WorkItemMinimalProjection(WireResponseModel):
    """Cross-project leak guard (Phase D).

    A dependency may span projects, but the dependent view must never carry
    another project's note bodies or session history.  This is the ONLY shape
    a foreign endpoint is ever projected into: id, display key, project id,
    title, status — nothing else.
    """

    id: str
    display_key: str
    project_id: str
    title: str
    status_definition_id: str


class RelationResponse(WireResponseModel):
    """One canonical dependency edge (D12: from = blocked side)."""

    id: str
    space_id: str
    from_work_item_id: str
    to_work_item_id: str
    relation_type: str
    # ★ 2026-09-12（D2 / ADR-0004）：解除确认两列（服务端自持）。必填可空 ——
    #   与服务端出站逐字段对齐（前端 relationSchema 为 z.strictObject，缺字段即拒收）。
    resolution: str | None
    resolved_at: str | None
    version: int = Field(ge=1)
    created_at: str
    updated_at: str


class RelationPageResponse(WireResponseModel):
    """Paged edge list (kept for parity with the other entity families)."""

    items: list[RelationResponse]
    next_cursor: str | None


class RelationEdgeView(WireResponseModel):
    """One edge plus the *other* endpoint's minimal projection."""

    relation: RelationResponse
    work_item: WorkItemMinimalProjection


class RelationSetResponse(WireResponseModel):
    """Dual-view projection of one work item's dependency edges.

    ``blockers`` = upstream items this one waits for (edge.to).
    ``blocking`` = downstream items waiting for this one (edge.from).
    """

    blockers: list[RelationEdgeView]
    blocking: list[RelationEdgeView]


class BlockedMapResponse(WireResponseModel):
    """Derived-only projection for the tree (never persisted, never synced)."""

    items: dict[str, dict[str, bool]]


class CreateRelationRequest(WireModel):
    """Declare one dependency edge. ``from``/``to`` are work item ids.

    The edge is stored single-sided and canonically: ``from_work_item_id``
    is the BLOCKED side, ``to_work_item_id`` the upstream blocker.  A caller
    that thinks in "blocks" terms just swaps the two ids.
    """

    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    from_work_item_id: str = Field(min_length=1, max_length=64)
    to_work_item_id: str = Field(min_length=1, max_length=64)
    # ★ 用枚举而非裸字符串：非法类型在**路由层**就以 422 拒掉，
    #   编译器的同名校验降级为直接调用者（测试 / 同步入口）的纵深防御。
    relation_type: RelationTypeLiteral


class RemoveRelationRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    from_work_item_id: str = Field(min_length=1, max_length=64)
    to_work_item_id: str = Field(min_length=1, max_length=64)
    # ★ 用枚举而非裸字符串：非法类型在**路由层**就以 422 拒掉，
    #   编译器的同名校验降级为直接调用者（测试 / 同步入口）的纵深防御。
    relation_type: RelationTypeLiteral


class ResolveRelationRequest(WireModel):
    """确认「已取消的上游不再需要」（D2 / ADR-0004）。

    ★ 与 Remove 同形（edge 身份 + CAS），但语义是幂等的解除确认。
    - **不接受任何时间戳字段**：``resolved_at`` 由服务端单调时钟打戳；
      ``extra="forbid"``（WireModel）会拒收调用方自带的时间戳 / resolution，
      防伪与防伪造确认。
    - 只对阻塞型边（depends_on / blocks）有意义；``relates_to`` 由编译器
      fail-closed 拒绝。
    """

    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    from_work_item_id: str = Field(min_length=1, max_length=64)
    to_work_item_id: str = Field(min_length=1, max_length=64)
    relation_type: RelationTypeLiteral


# --------------------------------------------------------------------------- #
# Dependency-graph projection (ADR-0008 D19-b) — MindCanvas GraphJsonPayload
# --------------------------------------------------------------------------- #
# ★ 为什么**不**继承 WireModel：kernel 契约（``@mindcanvas/kernel``
#   ``adapters/graphJsonAdapter.ts``）把线格式键名钉死为 snake_case
#   （``source_hash`` / ``in_degree`` / ``topological_order`` / ``file_path``），
#   而 WireModel 的 ``to_camel`` 别名生成器会把它们驼峰化 → 前端适配器收不到。
#   这组模型是「对外协议镜像」，不是本服务的一般业务实体 —— 键名以协议为准。
#   ``from_`` 字段经 FastAPI 的 by_alias 序列化输出为 ``"from"``。
#
# ★ 方向归一（D19-b）：边恒为 **上游 blocker → 下游 blocked**（``direction="fwd"``）。
#   DB 规范行是 ``from=被阻断方 / to=阻断方``，投影时翻转端点；在该方向下语义为真
#   的 kind 是 ``blocks``（``A depends_on B`` ⟺ ``B blocks A``），declared 原文
#   保留在 ``metadata.declared_as``。``relates_to`` 不参与阻塞（D12），不入图。
#
# ★ 只读派生：本组模型仅作响应投影，依赖事实源仍在 ``relations`` 表，
#   不落库、不进同步账本（ADR-0008 D19-b 纪律）。


class GraphJsonNode(BaseModel):
    """One work item in the dependency closure."""

    id: str
    label: str
    level: str | None = None  # "L1" / "L2" / "L3"（权威父链派生，1-based）
    kind: str = "work_item"
    file_path: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphJsonEdge(BaseModel):
    """One blocking edge, normalized upstream → downstream."""

    # 允许以字段名 ``from_`` 构造（线格式恒输出别名 ``from``）
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    kind: str  # "depends_on" | "blocks"（归一后恒 "blocks"；declared 见 metadata）
    direction: str = "fwd"
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphJsonIndices(BaseModel):
    """Kernel adapter 的森林中心判据：入度 0 = 无上游 blocker 的源头母材。"""

    in_degree: dict[str, int] = Field(default_factory=dict)
    topological_order: list[str] = Field(default_factory=list)


class GraphJsonPayload(BaseModel):
    """MindCanvas ``GraphJsonPayload`` 契约（前端 ``graphJsonToMindmap`` 直接消费）。"""

    version: str = "1.0.0"
    domain: str = "task_space"
    source_hash: str
    nodes: list[GraphJsonNode]
    edges: list[GraphJsonEdge]
    indices: GraphJsonIndices
