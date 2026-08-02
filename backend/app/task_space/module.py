"""Task Space command module: request factory and default implementation."""

from __future__ import annotations

from collections.abc import Mapping

from app.errors import (
    IdempotencyConflictError,
    MutationRejectedError,
)
from app.mutation.types import (
    InvalidPayloadHashError,
    MutationRequest,
    require_payload_hash,
)
from app.mutation.unit_of_work import MutationUnitOfWork
from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    NoteCommandKind,
    TaskSpaceAccepted,
    TaskSpaceCommand,
    TaskSpaceOutcome,
    TaskSpaceRejected,
    WorkItemNoteCommand,
)

NOTE_REQUEST_NAMES = {
    NoteCommandKind.REPLACE_DOCUMENT: "ReplaceDocument",
    NoteCommandKind.APPEND_BLOCKS: "AppendBlocks",
    NoteCommandKind.TOGGLE_CHECKLIST_ITEM: "ToggleChecklistItem",
}
WORK_ITEM_REQUEST_NAMES = {
    "update": "UpdateWorkItem",
    "move": "MoveWorkItem",
    "transition": "TransitionWorkItem",
}


def _business_payload(command: TaskSpaceCommand) -> Mapping[str, object]:
    if isinstance(command, CreateProject):
        return dict(command.payload)
    if isinstance(command, CreateWorkItem):
        return {
            "title": command.title,
            "description": command.description,
            "parent_id": command.parent_id,
            "type_definition_id": command.type_definition_id,
            "status_definition_id": command.status_definition_id,
            "priority": command.priority,
        }
    if isinstance(command, MutateWorkItem):
        operation = str(command.payload["operation"])
        payload = {
            key: value
            for key, value in command.payload.items()
            if key != "operation"
        }
        if operation == "move":
            # project_id is an authority guard, not Move business content.
            payload.pop("project_id", None)
        return payload
    if isinstance(command, WorkItemNoteCommand):
        return {
            key: value
            for key, value in command.payload.items()
            if key != "expected_source_work_item_version"
        }
    raise TypeError(f"unsupported TaskSpaceCommand: {type(command).__name__}")


def build_task_space_request(command: TaskSpaceCommand) -> MutationRequest:
    business_payload = _business_payload(command)
    require_payload_hash(command.payload_hash, business_payload)
    if isinstance(command, CreateProject):
        request_name = "CreateProject"
        entity_id = command.command_id
        expected_version = None
        payload: Mapping[str, object] = dict(command.payload)
    elif isinstance(command, CreateWorkItem):
        request_name = "CreateWorkItem"
        entity_id = command.command_id
        expected_version = None
        payload = {
            "project_id": command.project_id,
            "title": command.title,
            "description": command.description,
            "parent_id": command.parent_id,
            "type_definition_id": command.type_definition_id,
            "status_definition_id": command.status_definition_id,
            "priority": command.priority,
        }
    elif isinstance(command, MutateWorkItem):
        operation = str(command.payload["operation"])
        request_name = WORK_ITEM_REQUEST_NAMES[operation]
        entity_id = command.work_item_id or command.command_id
        expected_version = command.expected_version
        payload = {key: value for key, value in command.payload.items() if key != "operation"}
    elif isinstance(command, WorkItemNoteCommand):
        request_name = NOTE_REQUEST_NAMES[command.kind]
        entity_id = command.work_item_id
        expected_version = command.expected_version
        payload = {"work_item_id": command.work_item_id, **command.payload}
    else:  # closed TS0 union; fail loudly if its contract changes
        raise TypeError(f"unsupported TaskSpaceCommand: {type(command).__name__}")

    return MutationRequest.from_payload(
        name=f"task_space.{request_name}",
        entity_type="task_space",
        entity_id=entity_id,
        payload={
            "command_id": command.command_id,
            "space_id": command.space_id,
            "payload_hash": command.payload_hash,
            **payload,
        },
        expected_version=expected_version,
        client_updated_at=None,
    )


def _accepted(command: TaskSpaceCommand, value: Mapping[str, object]) -> TaskSpaceAccepted:
    primary = value.get("work_item_note", value)
    if not isinstance(primary, Mapping):
        raise TypeError("Task Space result requires one primary post-image")
    entity_type = (
        "project" if isinstance(command, CreateProject)
        else "work_item" if isinstance(command, (CreateWorkItem, MutateWorkItem))
        else "work_item_note"
    )
    return TaskSpaceAccepted(
        command_id=command.command_id,
        entity_type=entity_type,
        entity_id=str(primary["id"]),
        version=int(primary["version"]),
        value=value,
    )


class DefaultTaskSpaceCommandModule:
    def __init__(self, uow: MutationUnitOfWork) -> None:
        self._uow = uow

    async def execute(
        self,
        scope: SpaceRuntimeHandle,
        command: TaskSpaceCommand,
    ) -> TaskSpaceOutcome:
        try:
            result = await self._uow.execute(
                scope, build_task_space_request(command), command.command_id
            )
        except InvalidPayloadHashError as exc:
            return TaskSpaceRejected(
                command_id=command.command_id,
                code="invalid_payload_hash",
                retryable=False,
                details={"reason": str(exc)},
            )
        except MutationRejectedError as exc:
            rejection = exc.rejection
            return TaskSpaceRejected(
                command_id=command.command_id,
                code=rejection.code,
                retryable=rejection.retryable,
                details=rejection.details,
            )
        except IdempotencyConflictError as exc:
            return TaskSpaceRejected(
                command_id=command.command_id,
                code="idempotency_conflict",
                retryable=False,
                details=exc.details,
            )
        return _accepted(command, result.value)
