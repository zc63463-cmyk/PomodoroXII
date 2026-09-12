"""Closed, transport-neutral Task Space domain contracts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Literal, Mapping, Protocol, TypeAlias, get_args

if TYPE_CHECKING:
    from app.runtime.space import SpaceRuntimeHandle


# --------------------------------------------------------------------------- #
# ★ 2026-09-11 WorkItem 枚举值域：单一事实来源。
#   原因：DB CHECK / Pydantic wire schema / 编译器此前各写各的 —— schema 只限
#   长度、编译器不校验值域，于是「高」这类越界值会穿过前后端校验，最后撞上
#   work_items 的 CHECK 约束，以不可读的 500 收场。
#   Literal 是唯一声明：Pydantic 字段、编译器校验、DB CHECK 文本全部从它派生，
#   任何一处改动都会同时收紧三方（tests 里有逐字一致性断言兜底）。
# --------------------------------------------------------------------------- #

WorkItemPriorityValue: TypeAlias = Literal["low", "medium", "high", "urgent"]
WorkItemConfidenceValue: TypeAlias = Literal["low", "medium", "high"]
# 声明顺序即 DB CHECK / 错误详情 allowed 的稳定顺序（get_args 保留声明序）。
WORK_ITEM_PRIORITY_VALUES: tuple[str, ...] = get_args(WorkItemPriorityValue)
WORK_ITEM_CONFIDENCE_VALUES: tuple[str, ...] = get_args(WorkItemConfidenceValue)


def require_enum_value(field: str, value: object, allowed: tuple[str, ...]) -> None:
    """Fail closed when a non-null value falls outside its closed domain.

    ``None`` 始终合法（字段可空）；其余非成员值一律以 ``invalid_<field>``
    拒绝，让每个入口都能在 DB CHECK 之前给出稳定的领域错误。
    """
    if value is None:
        return
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"invalid_{field}")


class StatusCategory(StrEnum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    WAITING = "waiting"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class BlockType(StrEnum):
    PARAGRAPH = "paragraph"
    CHECKLIST = "checklist"


class NoteCommandKind(StrEnum):
    REPLACE_DOCUMENT = "replace_document"
    APPEND_BLOCKS = "append_blocks"
    TOGGLE_CHECKLIST_ITEM = "toggle_checklist_item"


class LabelOperation(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    ARCHIVE = "archive"


class RelationOperation(StrEnum):
    CREATE = "create"
    REMOVE = "remove"
    # ★ 2026-09-12（D2 / ADR-0004）：解除确认 —— 「上游已取消且不再需要」的
    #   显式用户事实（幂等 CAS，重复确认 = 零效果回执）。
    RESOLVE = "resolve"


class RelationType(StrEnum):
    """Edge semantics (依赖域合同 D12: 单边存储，双向解释).

    ``depends_on`` / ``blocks`` are the two readings of ONE canonical edge;
    the DB always stores ``from = blocked side``, ``to = upstream blocker``.
    Only these two participate in blocking; ``relates_to`` is a non-blocking
    association and is deliberately excluded from cycle detection.
    """

    DEPENDS_ON = "depends_on"
    BLOCKS = "blocks"
    RELATES_TO = "relates_to"


BLOCKING_RELATION_TYPES = frozenset(
    {RelationType.DEPENDS_ON.value, RelationType.BLOCKS.value}
)
RELATION_TYPES = frozenset(item.value for item in RelationType)

# ★ 2026-09-12（D2 / ADR-0004）：依赖边的「解除确认」取值（目前唯一合法值）。
#   单一事实来源：编译器（写入）、queries（真值表）、前端 relation-selectors.ts
#   三方共用；新增取值必须同时更新三处（闭集，见 ADR-0004）。
RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED = "confirmed_not_required"


SYSTEM_STATUS_IDS: Mapping[str, str] = {
    "not_started": "sys-status-not-started",
    "in_progress": "sys-status-in-progress",
    "paused": "sys-status-paused",
    "waiting": "sys-status-waiting",
    "completed": "sys-status-completed",
    "cancelled": "sys-status-cancelled",
}
SYSTEM_TYPE_ID = "sys-type-work-item"
PROJECT_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")


def normalize_project_key(value: str) -> str:
    normalized = value.strip().upper()
    if PROJECT_KEY_PATTERN.fullmatch(normalized) is None:
        raise ValueError("project_key")
    return normalized


def relation_id(
    space_id: str,
    from_work_item_id: str,
    to_work_item_id: str,
    relation_type: str,
) -> str:
    """Deterministically derive a relation id (依赖域合同 D11 / D15).

    ``"rel_" + sha256(canonical(space_id, from, to, type))[:32]``

    Consequence: the same logical edge created independently on two offline
    devices converges on ONE row instead of producing duplicates.  It also
    makes the online API naturally idempotent — a replayed create hits the
    same primary key.
    """
    from app.mutation.types import canonical_payload_hash

    digest = canonical_payload_hash({
        "space_id": space_id,
        "from_work_item_id": from_work_item_id,
        "to_work_item_id": to_work_item_id,
        "relation_type": relation_type,
    })
    return f"rel_{digest[:32]}"


def format_work_item_display_key(project_key: str, number: int) -> str:
    canonical_key = normalize_project_key(project_key)
    if type(number) is not int or number < 1:
        raise ValueError("work_item_number")
    return f"{canonical_key}-{number}"


@dataclass(frozen=True)
class WorkItemNoteCommand:
    kind: NoteCommandKind
    command_id: str
    space_id: str
    work_item_id: str
    expected_version: int | None
    payload_hash: str
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.expected_version is None and self.kind is not NoteCommandKind.REPLACE_DOCUMENT:
            raise ValueError("expected_version_required")


@dataclass(frozen=True)
class CreateProject:
    command_id: str
    space_id: str
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class CreateWorkItem:
    command_id: str
    space_id: str
    project_id: str
    title: str
    description: str | None
    parent_id: str | None
    type_definition_id: str | None
    status_definition_id: str | None
    priority: str | None
    payload_hash: str


@dataclass(frozen=True)
class MutateWorkItem:
    command_id: str
    space_id: str
    work_item_id: str | None
    expected_version: int | None
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class LabelCommand:
    """Label definition lifecycle: create / update / archive.

    ``label_id`` is required for update/archive (oracle identity); create
    leaves it None because the server derives the label id from command_id.
    """
    operation: str
    command_id: str
    space_id: str
    label_id: str | None
    expected_version: int | None
    payload_hash: str
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.operation not in {item.value for item in LabelOperation}:
            raise ValueError(f"unsupported label operation: {self.operation}")
        if self.operation != "create" and (
            self.label_id is None or self.expected_version is None
        ):
            raise ValueError("label update/archive requires label_id and expected_version")


@dataclass(frozen=True)
class RelationCommand:
    """Create, remove, or resolve-confirm one dependency edge.

    ``relation_id`` is derived (never client-chosen) and doubles as the CAS
    target: remove / resolve carry ``expected_version``; create does not (the
    row either exists or it does not).
    """

    operation: str
    command_id: str
    space_id: str
    relation_id: str
    from_work_item_id: str
    to_work_item_id: str
    relation_type: str
    expected_version: int | None
    payload_hash: str

    def __post_init__(self) -> None:
        if self.operation not in {item.value for item in RelationOperation}:
            raise ValueError(f"unsupported relation operation: {self.operation}")
        if not self.relation_id.startswith("rel_"):
            raise ValueError("relation id must be deterministically derived")
        if (
            self.operation in {
                RelationOperation.REMOVE.value,
                RelationOperation.RESOLVE.value,
            }
            and self.expected_version is None
        ):
            raise ValueError("relation remove/resolve requires expected_version")


TaskSpaceCommand: TypeAlias = (
    CreateProject
    | CreateWorkItem
    | MutateWorkItem
    | WorkItemNoteCommand
    | LabelCommand
    | RelationCommand
)


@dataclass(frozen=True)
class TaskSpaceAccepted:
    command_id: str
    entity_type: str
    entity_id: str
    version: int
    value: Mapping[str, object]


@dataclass(frozen=True)
class TaskSpaceRejected:
    command_id: str
    code: str
    retryable: bool
    details: Mapping[str, object]


TaskSpaceOutcome: TypeAlias = TaskSpaceAccepted | TaskSpaceRejected


@dataclass(frozen=True)
class TaskSpacePageQuery:
    cursor: str | None
    limit: int
    filters: Mapping[str, object]


@dataclass(frozen=True)
class TaskSpacePage:
    items: tuple[Mapping[str, object], ...]
    next_cursor: str | None


@dataclass(frozen=True)
class TaskSpaceView:
    value: Mapping[str, object]


@dataclass(frozen=True)
class TaskSpaceDefinitionsView:
    statuses: tuple[Mapping[str, object], ...]
    types: tuple[Mapping[str, object], ...]
    labels: tuple[Mapping[str, object], ...]


class TaskSpaceQueryModule(Protocol):
    async def list_projects(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage: ...

    async def get_project(self, scope: SpaceRuntimeHandle, project_id: str) -> TaskSpaceView: ...

    async def list_definitions(self, scope: SpaceRuntimeHandle) -> TaskSpaceDefinitionsView: ...

    async def list_work_items(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage: ...

    async def get_work_item(self, scope: SpaceRuntimeHandle, work_item_id: str) -> TaskSpaceView: ...

    async def read_note(
        self, scope: SpaceRuntimeHandle, work_item_id: str
    ) -> TaskSpaceView | None: ...


class TaskSpaceCommandModule(Protocol):
    async def execute(
        self, scope: SpaceRuntimeHandle, command: TaskSpaceCommand
    ) -> TaskSpaceOutcome: ...
