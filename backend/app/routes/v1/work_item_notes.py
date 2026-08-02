"""Thin contract router for WorkItemNote read and write paths.

Only three canonical write paths are exposed:
- PUT  /{work_item_id}/note                      (replace document)
- POST /{work_item_id}/note/append-blocks        (append blocks)
- POST /{work_item_id}/note/toggle-checklist-item (toggle item)

No generic note promotion, tree, or legacy alias routes exist.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException

from app.deps import get_space_runtime_handle
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space import (
    TaskSpaceAcceptedResponse,
)
from app.schemas.work_item_note import (
    AppendBlocksRequest,
    ChecklistBlock,
    ChecklistItem,
    NoteBlock,
    ReplaceDocumentRequest,
    ToggleChecklistItemRequest,
    WorkItemNoteDocumentV1,
    WorkItemNoteResponse,
)
from app.task_space.contracts import (
    NoteCommandKind,
    WorkItemNoteCommand,
)

router = APIRouter()


def _map_checklist_item(item: ChecklistItem) -> dict[str, object]:
    return {
        "itemId": item.item_id,
        "text": item.text,
        "checked": item.checked,
        "children": [_map_checklist_item(child) for child in item.children],
    }


def _map_note_block(block: NoteBlock) -> dict[str, object]:
    if isinstance(block, ChecklistBlock):
        return {
            "type": block.type,
            "blockId": block.block_id,
            "items": [_map_checklist_item(item) for item in block.items],
        }
    return {"type": block.type, "blockId": block.block_id, "text": block.text}


def _map_note_document(document: WorkItemNoteDocumentV1) -> dict[str, object]:
    return {
        "contentVersion": document.content_version,
        "blocks": [_map_note_block(block) for block in document.blocks],
    }


# --------------------------------------------------------------------------- #
# Note read
# --------------------------------------------------------------------------- #


@router.get("/{work_item_id}/note", response_model=WorkItemNoteResponse)
async def read_note(
    work_item_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> WorkItemNoteResponse:
    """Read the note document for a work item."""
    view = await query_module.read_note(scope, work_item_id)
    if view is None:
        raise HTTPException(status_code=404, detail="note_not_found")
    v = view.value
    document_json = str(v["document_json"])
    return WorkItemNoteResponse(
        id=str(v["id"]),
        work_item_id=str(v["work_item_id"]),
        document_json=document_json,
        content_version=v["content_version"],
        write_supported=bool(v["write_supported"]),
        version=int(v["version"]),
    )


# --------------------------------------------------------------------------- #
# Note write — replace entire document
# --------------------------------------------------------------------------- #


@router.put("/{work_item_id}/note", response_model=TaskSpaceAcceptedResponse)
async def replace_document(
    work_item_id: str,
    body: ReplaceDocumentRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Replace the entire note document."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = WorkItemNoteCommand(
        kind=NoteCommandKind.REPLACE_DOCUMENT,
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={"document": _map_note_document(body.document)},
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


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
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Append blocks to the note document."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = WorkItemNoteCommand(
        kind=NoteCommandKind.APPEND_BLOCKS,
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={
            "blocks": [_map_note_block(block) for block in body.blocks],
        },
    )
    outcome = await command_module.execute(scope, command)
    return map_task_space_outcome(outcome)


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
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Toggle a checklist item in the note document."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
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
    return map_task_space_outcome(outcome)
