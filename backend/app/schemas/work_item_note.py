"""Pydantic wire schemas for WorkItemNote contract routes.

Defines a closed recursive ChecklistItem, a discriminated Block union,
and the three canonical write-path request schemas.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from app.schemas.task_space import CommandId, WireModel

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


class ToggleChecklistItemRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    block_id: str = Field(min_length=1, max_length=64)
    item_id: str = Field(min_length=1, max_length=64)
    checked: bool
