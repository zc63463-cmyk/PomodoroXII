from __future__ import annotations

import json

import pytest

from app.task_space.document import (
    MAX_BLOCKS,
    MAX_DOCUMENT_BYTES,
    MAX_ITEMS,
    InvalidNoteDocument,
    UnsupportedContentVersion,
    append_blocks,
    canonical_document_json,
    parse_document_v1,
    set_checklist_item_checked,
)

VALID_DOCUMENT = {
    "contentVersion": 1,
    "blocks": [
        {"blockId": "p1", "type": "paragraph", "text": "Prepare the outline"},
        {
            "blockId": "c1",
            "type": "checklist",
            "items": [
                {
                    "itemId": "c1a",
                    "text": "Run review",
                    "checked": False,
                    "children": [
                        {
                            "itemId": "c1b",
                            "text": "Check sources",
                            "checked": False,
                            "children": [],
                        }
                    ],
                }
            ],
        },
    ],
}


def test_document_v1_accepts_only_paragraph_and_checklist_and_is_canonical() -> None:
    document = parse_document_v1(VALID_DOCUMENT)

    first = canonical_document_json(document)
    second = canonical_document_json(parse_document_v1(json.loads(first)))

    assert first == second
    assert json.loads(first) == VALID_DOCUMENT


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update(contentVersion=2), "unsupported contentVersion"),
        (
            lambda value: value["blocks"].append(
                {"blockId": "p1", "type": "paragraph", "text": "duplicate"}
            ),
            "duplicate Note ID",
        ),
        (
            lambda value: value["blocks"][1]["items"][0]["children"][0].update(
                children=[
                    {
                        "itemId": "third",
                        "text": "too deep",
                        "checked": False,
                        "children": [],
                    }
                ]
            ),
            "checklist depth exceeds two",
        ),
    ],
)
def test_document_v1_rejects_unknown_version_duplicate_ids_and_third_level(
    mutate,
    message: str,
) -> None:
    value = json.loads(json.dumps(VALID_DOCUMENT))
    mutate(value)

    error = UnsupportedContentVersion if value.get("contentVersion") != 1 else InvalidNoteDocument
    with pytest.raises(error, match=message):
        parse_document_v1(value)


def test_document_v1_rejects_coerced_versions_levels_and_non_object_root() -> None:
    for invalid_version in (True, 1.0):
        value = json.loads(json.dumps(VALID_DOCUMENT))
        value["contentVersion"] = invalid_version
        with pytest.raises(InvalidNoteDocument):
            parse_document_v1(value)

    non_boolean_check = json.loads(json.dumps(VALID_DOCUMENT))
    non_boolean_check["blocks"][1]["items"][0]["checked"] = 0
    with pytest.raises(InvalidNoteDocument):
        parse_document_v1(non_boolean_check)

    with pytest.raises(InvalidNoteDocument, match="root must be an object"):
        parse_document_v1([])


def test_checklist_shape_limits_and_forbidden_variants_are_locked() -> None:
    assert (MAX_DOCUMENT_BYTES, MAX_BLOCKS, MAX_ITEMS) == (128 * 1024, 256, 2048)

    wide_document = parse_document_v1(
        {
            "contentVersion": 1,
            "blocks": [
                {
                    "blockId": "wide",
                    "type": "checklist",
                    "items": [
                        {
                            "itemId": f"wide-{index}",
                            "text": "x",
                            "checked": False,
                            "children": [],
                        }
                        for index in range(501)
                    ],
                }
            ],
        }
    )
    assert len(wide_document.blocks[0].items) == 501

    forbidden_parent = json.loads(json.dumps(VALID_DOCUMENT))
    forbidden_parent["blocks"][1]["items"][0]["parentItemId"] = "not-canonical"
    with pytest.raises(InvalidNoteDocument):
        parse_document_v1(forbidden_parent)

    for forbidden_type in ("heading", "ordered_list", "unordered_list"):
        value = json.loads(json.dumps(VALID_DOCUMENT))
        value["blocks"].append({"blockId": forbidden_type, "type": forbidden_type})
        with pytest.raises(InvalidNoteDocument):
            parse_document_v1(value)

    promoted = json.loads(json.dumps(VALID_DOCUMENT))
    promoted["blocks"][1]["items"][0].update(
        workItemId="wi-1", titleSnapshot="Not in v1"
    )
    with pytest.raises(InvalidNoteDocument):
        parse_document_v1(promoted)


def test_append_blocks_returns_a_new_valid_document() -> None:
    original = parse_document_v1(VALID_DOCUMENT)

    updated = append_blocks(
        original,
        ({"blockId": "p2", "type": "paragraph", "text": "Next step"},),
    )

    assert len(original.blocks) == 2
    assert [block.block_id for block in updated.blocks] == ["p1", "c1", "p2"]


def test_toggle_checklist_item_returns_a_new_document_and_requires_one_match() -> None:
    original = parse_document_v1(VALID_DOCUMENT)

    updated = set_checklist_item_checked(original, "c1b", True)

    assert original.blocks[1].items[0].children[0].checked is False
    assert updated.blocks[1].items[0].children[0].checked is True
    with pytest.raises(InvalidNoteDocument, match="exactly one item"):
        set_checklist_item_checked(original, "missing", True)
