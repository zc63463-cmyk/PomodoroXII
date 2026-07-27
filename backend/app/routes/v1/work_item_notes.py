"""Thin contract router for WorkItemNote read and write paths.

Only three canonical write paths are exposed:
- PUT  /{work_item_id}/note                      (replace document)
- POST /{work_item_id}/note/append-blocks        (append blocks)
- POST /{work_item_id}/note/toggle-checklist-item (toggle item)

No generic note promotion, tree, or legacy alias routes exist.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.routes.v1.contract_dependencies import (
    get_contract_space_runtime,
    get_task_space_command_module,
    get_task_space_query_module,
)
from app.schemas.task_space import (
    TaskSpaceAcceptedResponse,
    TaskSpaceViewResponse,
)
from app.schemas.work_item_note import (
    AppendBlocksRequest,
    ReplaceDocumentRequest,
    ToggleChecklistItemRequest,
)
from app.task_space.contracts import (
    NoteCommandKind,
    TaskSpaceAccepted,
    TaskSpaceRejected,
    WorkItemNoteCommand,
)

router = APIRouter()


def _map_accepted(outcome: Any) -> TaskSpaceAcceptedResponse:
    if isinstance(outcome, TaskSpaceAccepted):
        return TaskSpaceAcceptedResponse(
            command_id=outcome.command_id,
            entity_type=outcome.entity_type,
            entity_id=outcome.entity_id,
            version=outcome.version,
            value=dict(outcome.value),
        )
    rejected: TaskSpaceRejected = outcome
    raise HTTPException(
        status_code=409,
        detail={
            "code": rejected.code,
            "retryable": rejected.retryable,
            "details": dict(rejected.details),
        },
    )


# --------------------------------------------------------------------------- #
# Note read
# --------------------------------------------------------------------------- #


@router.get("/{work_item_id}/note", response_model=TaskSpaceViewResponse)
async def read_note(
    work_item_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpaceViewResponse:
    """Read the note document for a work item."""
    view = await query_module.read_note(scope, work_item_id)
    if view is None:
        raise HTTPException(status_code=404, detail="note_not_found")
    return TaskSpaceViewResponse(value=dict(view.value))


# --------------------------------------------------------------------------- #
# Note write — replace entire document
# --------------------------------------------------------------------------- #


@router.put("/{work_item_id}/note", response_model=TaskSpaceAcceptedResponse)
async def replace_document(
    work_item_id: str,
    body: ReplaceDocumentRequest,
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpaceAcceptedResponse:
    """Replace the entire note document."""
    command = WorkItemNoteCommand(
        kind=NoteCommandKind.REPLACE_DOCUMENT,
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={"document": body.document.model_dump(mode="json")},
    )
    outcome = await command_module.execute(scope, command)
    return _map_accepted(outcome)


# --------------------------------------------------------------------------- #
# Note write — append blocks
# --------------------------------------------------------------------------- #


@router.post(
    "/{work_item_id}/note/append-blocks",
    response_model=TaskSpaceAcceptedResponse,
)
async def append_blocks(
    work_item_id: str,
    body: AppendBlocksRequest,
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpaceAcceptedResponse:
    """Append blocks to the note document."""
    command = WorkItemNoteCommand(
        kind=NoteCommandKind.APPEND_BLOCKS,
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={
            "blocks": [block.model_dump(mode="json") for block in body.blocks],
        },
    )
    outcome = await command_module.execute(scope, command)
    return _map_accepted(outcome)


# --------------------------------------------------------------------------- #
# Note write — toggle checklist item
# --------------------------------------------------------------------------- #


@router.post(
    "/{work_item_id}/note/toggle-checklist-item",
    response_model=TaskSpaceAcceptedResponse,
)
async def toggle_checklist_item(
    work_item_id: str,
    body: ToggleChecklistItemRequest,
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_contract_space_runtime),
) -> TaskSpaceAcceptedResponse:
    """Toggle a checklist item in the note document."""
    command = WorkItemNoteCommand(
        kind=NoteCommandKind.TOGGLE_CHECKLIST_ITEM,
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={
            "block_id": body.block_id,
            "item_id": body.item_id,
            "checked": body.checked,
        },
    )
    outcome = await command_module.execute(scope, command)
    return _map_accepted(outcome)
