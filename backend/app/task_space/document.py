"""Closed, immutable WorkItemNote document v1 domain model."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator, Mapping
from copy import deepcopy
from typing import Annotated, Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

MAX_DOCUMENT_BYTES = 128 * 1024
MAX_BLOCKS = 256
MAX_ITEMS = 2048
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class InvalidNoteDocument(ValueError):
    """Raised when a note document violates the v1 contract."""


class UnsupportedContentVersion(ValueError):
    """Raised when a recognized integer content version is not supported."""


class _ClosedModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )


class ChecklistItemV1(_ClosedModel):
    item_id: str = Field(alias="itemId", min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=10_000)
    checked: bool
    children: tuple[ChecklistItemV1, ...] = Field(default=(), max_length=MAX_ITEMS)

    @field_validator("children", mode="before")
    @classmethod
    def freeze_children(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def validate_shape(self) -> ChecklistItemV1:
        if ID_PATTERN.fullmatch(self.item_id) is None:
            raise ValueError("invalid itemId")
        if not self.text.strip():
            raise ValueError("checklist item requires nonblank text")
        return self


class ParagraphBlockV1(_ClosedModel):
    block_id: str = Field(alias="blockId", min_length=1, max_length=64)
    type: Literal["paragraph"]
    text: str = Field(max_length=10_000)


class ChecklistBlockV1(_ClosedModel):
    block_id: str = Field(alias="blockId", min_length=1, max_length=64)
    type: Literal["checklist"]
    items: tuple[ChecklistItemV1, ...] = Field(max_length=MAX_ITEMS)

    @field_validator("items", mode="before")
    @classmethod
    def freeze_items(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value


NoteBlockV1: TypeAlias = Annotated[
    ParagraphBlockV1 | ChecklistBlockV1,
    Field(discriminator="type"),
]
_BLOCK_ADAPTER = TypeAdapter(NoteBlockV1)


class WorkItemNoteDocumentV1(_ClosedModel):
    content_version: Literal[1] = Field(alias="contentVersion")
    blocks: tuple[NoteBlockV1, ...] = Field(max_length=MAX_BLOCKS)

    @field_validator("blocks", mode="before")
    @classmethod
    def freeze_blocks(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value


def _walk_items(
    items: tuple[ChecklistItemV1, ...],
    *,
    depth: int,
) -> Iterator[ChecklistItemV1]:
    for item in items:
        if depth > 2:
            raise InvalidNoteDocument("checklist depth exceeds two")
        yield item
        yield from _walk_items(item.children, depth=depth + 1)


def _validate_document(document: WorkItemNoteDocumentV1) -> WorkItemNoteDocumentV1:
    seen: set[str] = set()
    item_count = 0
    for block in document.blocks:
        if ID_PATTERN.fullmatch(block.block_id) is None:
            raise InvalidNoteDocument("invalid blockId")
        if block.block_id in seen:
            raise InvalidNoteDocument("duplicate Note ID")
        seen.add(block.block_id)
        if isinstance(block, ChecklistBlockV1):
            for item in _walk_items(block.items, depth=1):
                item_count += 1
                if item.item_id in seen:
                    raise InvalidNoteDocument("duplicate Note ID")
                seen.add(item.item_id)
    if item_count > MAX_ITEMS:
        raise InvalidNoteDocument("Note item count exceeds limit")
    if len(canonical_document_json(document).encode("utf-8")) > MAX_DOCUMENT_BYTES:
        raise InvalidNoteDocument("Note document exceeds byte limit")
    return document


def parse_document_v1(raw: object) -> WorkItemNoteDocumentV1:
    """Parse and validate a raw value as the closed document v1 contract."""
    if not isinstance(raw, Mapping):
        raise InvalidNoteDocument("Note document root must be an object")
    content_version = raw.get("contentVersion")
    if type(content_version) is int and content_version != 1:
        raise UnsupportedContentVersion("unsupported contentVersion")
    if type(content_version) is not int:
        raise InvalidNoteDocument("contentVersion must be integer 1")
    try:
        document = WorkItemNoteDocumentV1.model_validate(raw)
        return _validate_document(document)
    except (UnsupportedContentVersion, InvalidNoteDocument):
        raise
    except Exception as exc:
        raise InvalidNoteDocument(str(exc)) from exc


def canonical_document_json(document: WorkItemNoteDocumentV1) -> str:
    """Serialize a validated document deterministically."""
    return json.dumps(
        document.model_dump(by_alias=True, mode="json", exclude_none=True),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def append_blocks(
    document: WorkItemNoteDocumentV1,
    blocks: tuple[Mapping[str, object], ...],
) -> WorkItemNoteDocumentV1:
    """Return a document with validated blocks appended."""
    raw = document.model_dump(by_alias=True, mode="json", exclude_none=True)
    raw["blocks"].extend(deepcopy(dict(block)) for block in blocks)
    return parse_document_v1(raw)


ItemRewrite = Callable[[dict[str, object]], dict[str, object]]


def _rewrite_item(
    item: dict[str, object],
    item_id: str,
    rewrite: ItemRewrite,
) -> tuple[dict[str, object], bool]:
    if item["itemId"] == item_id:
        return rewrite(deepcopy(item)), True
    rewritten_children: list[dict[str, object]] = []
    found = False
    for child in item.get("children", []):
        rewritten, matched = _rewrite_item(child, item_id, rewrite)
        rewritten_children.append(rewritten)
        found = found or matched
    output = deepcopy(item)
    output["children"] = rewritten_children
    return output, found


def _rewrite_document_item(
    document: WorkItemNoteDocumentV1,
    *,
    block_id: str | None,
    item_id: str,
    rewrite: ItemRewrite,
) -> WorkItemNoteDocumentV1:
    raw: dict[str, Any] = document.model_dump(by_alias=True, mode="json", exclude_none=True)
    matches = 0
    for block in raw["blocks"]:
        if block_id is not None and block["blockId"] != block_id:
            continue
        if "items" not in block:
            continue
        items: list[dict[str, object]] = []
        for item in block["items"]:
            rewritten, found = _rewrite_item(item, item_id, rewrite)
            items.append(rewritten)
            matches += int(found)
        block["items"] = items
    if matches != 1:
        raise InvalidNoteDocument("itemId must identify exactly one item")
    return parse_document_v1(raw)


def set_checklist_item_checked(
    document: WorkItemNoteDocumentV1,
    item_id: str,
    checked: bool,
) -> WorkItemNoteDocumentV1:
    """Return a document with exactly one checklist item state replaced."""

    def set_checked(item: dict[str, object]) -> dict[str, object]:
        if not isinstance(item.get("checked"), bool):
            raise InvalidNoteDocument("item is not a checklist item")
        item["checked"] = checked
        return item

    return _rewrite_document_item(
        document,
        block_id=None,
        item_id=item_id,
        rewrite=set_checked,
    )
