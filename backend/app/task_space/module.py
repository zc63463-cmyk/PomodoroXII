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
    LabelCommand,
    MutateWorkItem,
    NoteCommandKind,
    RelationCommand,
    StatusCommand,
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
    # 工单②：同父内拖拽排序 —— 集合级重排（先例 status 的 reorder），与 Move
    # 的 append-only 分配器语义分离；见 _compile_ReorderWorkItem 注释。
    "reorder": "ReorderWorkItem",
    # archived_at lifecycle: the caller never supplies the timestamp, so the
    # business payload is empty and the server stamps its own monotonic clock.
    "trash": "TrashWorkItem",
    "restore": "RestoreWorkItem",
    # D5 Y: idempotent set mutations; the target label_ids set travels in the
    # payload and the compiler read-modify-writes the junction table.
    "add_labels": "AddWorkItemLabels",
    "remove_labels": "RemoveWorkItemLabels",
}
LABEL_REQUEST_NAMES = {
    "create": "CreateLabel",
    "update": "UpdateLabel",
    "archive": "ArchiveLabel",
}
# ★ 2026-10-02（状态双轴阶段 2）：status 定义的生命周期。
#   比 label 多一个 reorder —— status 有 rank 且用户期望「按 category 分组、组内拖动」。
STATUS_REQUEST_NAMES = {
    "create": "CreateStatusDefinition",
    "update": "UpdateStatusDefinition",
    "archive": "ArchiveStatusDefinition",
    "reorder": "ReorderStatusDefinition",
}
RELATION_REQUEST_NAMES = {
    "create": "CreateRelation",
    "remove": "RemoveRelation",
    # ★ 2026-09-12（D2 / ADR-0004）：解除确认（幂等 CAS，服务端打戳）。
    "resolve": "ResolveDependency",
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
            # project_id is an authority guard, not Move business content, and
            # child_rank is never client-supplied online: the external Move API
            # rejects it and the server assigns the authoritative rank.  Both
            # are excluded from the canonical business payload, so a caller
            # cannot smuggle child_rank through the payload hash either.
            payload.pop("project_id", None)
            payload.pop("child_rank", None)
        if operation in {"add_labels", "remove_labels"}:
            # The label_ids set is the whole business payload: the hash covers
            # "labels as state", exactly what the compiler converges the
            # junction to.  Sorted, so the canonical hash is order-stable.
            payload["label_ids"] = sorted(payload["label_ids"])
            # ★ 2026-09-20（TS-02a）：单标签 DELETE 的 URL 约束（「这个标签必须
            #   消失」）是命令契约的一部分 —— 它参与 hash，因此改 URL 后的重试是
            #   「内容变了」而不是命中旧回执；也随命令进入编译器的加锁校验。
            if payload.get("require_removed_label_ids") is not None:
                payload["require_removed_label_ids"] = sorted(
                    payload["require_removed_label_ids"]
                )
            else:
                # Absent = no address-level constraint; keep the canonical
                # payload free of an explicit null so single POST/DELETE and
                # batch commands for the same logical set hash identically.
                payload.pop("require_removed_label_ids", None)
        return payload
    if isinstance(command, LabelCommand):
        # create/update carry the definition fields; archive carries none.
        return dict(command.payload)
    if isinstance(command, StatusCommand):
        # 状态双轴：payload 里category 是**固定轴的取值**（用户不能发明新轴），
        # 所以它参与业务哈希—— 改了 category 就是改了语义（换分组）。
        # reorder 只带目标 rank，期望幂等：把 status 移到同一位置应命中旧回执。
        payload = dict(command.payload)
        if "rank" in payload:
            payload["rank"] = int(payload["rank"])
        return payload
    if isinstance(command, RelationCommand):
        # The endpoints ARE the business payload: the hash covers the logical
        # edge (from, to, type), never the derived relation_id (which is a
        # pure function of those three plus the space).
        return {
            "from_work_item_id": command.from_work_item_id,
            "to_work_item_id": command.to_work_item_id,
            "relation_type": command.relation_type,
        }
    if isinstance(command, WorkItemNoteCommand):
        return {
            key: value
            for key, value in command.payload.items()
            if key != "expected_source_work_item_version"
        }
    raise TypeError(f"unsupported TaskSpaceCommand: {type(command).__name__}")


def build_task_space_request(
    command: TaskSpaceCommand, *, verify_payload_hash: bool = True
) -> MutationRequest:
    """Compile one domain command into its canonical MutationRequest.

    ``verify_payload_hash=False`` skips only the declared-hash comparison so a
    caller can still obtain the request **identity** (``request_hash`` covers
    name / entity_type / entity_id / payload / expected_version) of a command
    whose declared hash is wrong.  The batch adapter uses it to bind a
    pre-rejected (``invalid_payload_hash``) item to the same content-addressed
    identity a valid item would get, instead of a weaker business-payload-only
    hash.  Default behaviour is unchanged: the single-command entry point still
    validates the declared hash and raises ``InvalidPayloadHashError``.
    """
    business_payload = _business_payload(command)
    if verify_payload_hash:
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
        if operation == "move":
            # See _business_payload: child_rank is server-assigned only, so
            # the online request never carries it to the compiler.
            payload.pop("child_rank", None)
    elif isinstance(command, WorkItemNoteCommand):
        request_name = NOTE_REQUEST_NAMES[command.kind]
        entity_id = command.work_item_id
        expected_version = command.expected_version
        payload = {"work_item_id": command.work_item_id, **command.payload}
    elif isinstance(command, RelationCommand):
        operation = command.operation
        request_name = RELATION_REQUEST_NAMES[operation]
        entity_id = command.relation_id
        expected_version = command.expected_version
        payload = {
            "from_work_item_id": command.from_work_item_id,
            "to_work_item_id": command.to_work_item_id,
            "relation_type": command.relation_type,
        }
    elif isinstance(command, LabelCommand):
        operation = command.operation
        request_name = LABEL_REQUEST_NAMES[operation]
        entity_id = (
            command.command_id if operation == "create" else command.label_id
        )
        expected_version = (
            None if operation == "create" else command.expected_version
        )
        payload = dict(command.payload)
    elif isinstance(command, StatusCommand):
        operation = command.operation
        request_name = STATUS_REQUEST_NAMES[operation]
        entity_id = (
            command.command_id if operation == "create" else command.status_id
        )
        # reorder 是集合级操作：不锁expected_version（见 compiler 里的说明）
        expected_version = (
            None
            if operation in {"create", "reorder"}
            else command.expected_version
        )
        payload = dict(command.payload)
    else:  # closed TS0/TS2 union; fail loudly if its contract changes
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
        else "relation" if isinstance(command, RelationCommand)
        else "work_item" if isinstance(command, (CreateWorkItem, MutateWorkItem))
        else "label" if isinstance(command, LabelCommand)
        # ★ 状态双轴：回执的 entity_type 用**单数snake**（与其它 typed 命令
        #   一致），注意它与 sync 事件的 camel（statusDefinition）不同层。
        else "status_definition" if isinstance(command, StatusCommand)
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


# ★ TS-02（2026-09-20）：批量适配（task_space/batch.py）复用同一条 canonical
#   业务载荷与 accepted 映射 —— 单条与批量对同一命令必须产生完全相同的
#   MutationRequest 与回执；下划线名保持原位以兼容既有测试。
business_payload = _business_payload
accepted_outcome = _accepted
