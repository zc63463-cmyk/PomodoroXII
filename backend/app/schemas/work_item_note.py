"""Pydantic wire schemas for WorkItemNote contract routes.

Defines a closed recursive ChecklistItem, a discriminated Block union,
and the three canonical write-path request schemas.
"""
from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from app.mutation.types import canonical_json_bytes
from app.schemas.task_space import CommandId, WireModel, WireResponseModel

MAX_NOTE_DOCUMENT_BYTES = 128 * 1024
MAX_NOTE_BLOCKS = 256
MAX_NOTE_ITEMS = 2048


# --------------------------------------------------------------------------- #
# Document models
# --------------------------------------------------------------------------- #


class ChecklistItem(WireModel):
    item_id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=10_000)
    checked: bool
    children: list["ChecklistItem"] = Field(default_factory=list, max_length=MAX_NOTE_ITEMS)


class TextBlockBase(WireModel):
    block_id: str = Field(min_length=1, max_length=64)
    text: str = Field(max_length=10_000)


class ParagraphBlock(TextBlockBase):
    type: Literal["paragraph"]


class ChecklistBlock(WireModel):
    type: Literal["checklist"]
    block_id: str = Field(min_length=1, max_length=64)
    items: list[ChecklistItem] = Field(max_length=MAX_NOTE_ITEMS)


NoteBlock = Annotated[
    ParagraphBlock | ChecklistBlock,
    Field(discriminator="type"),
]


class WorkItemNoteDocumentV1(WireModel):
    content_version: Literal[1]
    blocks: list[NoteBlock] = Field(max_length=MAX_NOTE_BLOCKS)

    @model_validator(mode="after")
    def validate_document(self) -> Self:
        _validate_blocks(self.blocks)
        if len(canonical_json_bytes(self.model_dump(mode="json", by_alias=True))) > MAX_NOTE_DOCUMENT_BYTES:
            raise ValueError("note document exceeds the canonical byte limit")
        return self


def _validate_blocks(blocks: list[NoteBlock]) -> None:
    block_ids: set[str] = set()
    item_ids: set[str] = set()
    item_count = 0

    def visit(item: ChecklistItem, depth: int) -> None:
        nonlocal item_count
        if not item.text.strip():
            raise ValueError("checklist item text must be nonblank")
        if item.item_id in item_ids:
            raise ValueError("checklist item IDs must be unique")
        item_ids.add(item.item_id)
        item_count += 1
        if item_count > MAX_NOTE_ITEMS:
            raise ValueError("note document has too many checklist items")
        if depth >= 2 and item.children:
            raise ValueError("checklist nesting exceeds two levels")
        for child in item.children:
            visit(child, depth + 1)

    for block in blocks:
        if block.block_id in block_ids:
            raise ValueError("block IDs must be unique")
        block_ids.add(block.block_id)
        if isinstance(block, ChecklistBlock):
            for item in block.items:
                visit(item, 1)


# --------------------------------------------------------------------------- #
# Response schema
# --------------------------------------------------------------------------- #


class WorkItemNoteResponse(WireResponseModel):
    """Work item note view returned by the read route.

    Fields are sourced from the actual query/model data: the ORM row
    (``id``, ``work_item_id``, ``version``) and the parsed document JSON
    (``content_version``, ``write_supported``).
    """

    id: str
    work_item_id: str
    document_json: str
    content_version: int | None
    write_supported: bool
    version: int


# --------------------------------------------------------------------------- #
# Command request schemas (three canonical write paths)
# --------------------------------------------------------------------------- #


class ReplaceDocumentRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int | None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    document: WorkItemNoteDocumentV1


class AppendBlocksRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    blocks: list[NoteBlock] = Field(min_length=1, max_length=MAX_NOTE_BLOCKS)

    @model_validator(mode="after")
    def validate_blocks(self) -> Self:
        _validate_blocks(self.blocks)
        if len(canonical_json_bytes({"blocks": self.model_dump(mode="json", by_alias=True)["blocks"]})) > MAX_NOTE_DOCUMENT_BYTES:
            raise ValueError("appended blocks exceed the canonical byte limit")
        return self


class ToggleChecklistItemRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    block_id: str = Field(min_length=1, max_length=64)
    item_id: str = Field(min_length=1, max_length=64)
    checked: bool
