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


TaskSpaceCommand: TypeAlias = CreateProject | CreateWorkItem | MutateWorkItem | WorkItemNoteCommand


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
