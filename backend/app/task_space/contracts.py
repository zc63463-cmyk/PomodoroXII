"""Closed, transport-neutral Task Space domain contracts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Mapping, Protocol, TypeAlias

if TYPE_CHECKING:
    from app.runtime.space import SpaceRuntimeHandle


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
    """Create or remove one dependency edge.

    ``relation_id`` is derived (never client-chosen) and doubles as the CAS
    target: remove carries ``expected_version``; create does not (the row
    either exists or it does not).
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
        if self.operation == RelationOperation.REMOVE.value and self.expected_version is None:
            raise ValueError("relation remove requires expected_version")


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
