from dataclasses import fields
from typing import get_type_hints

import pytest

from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    PROJECT_KEY_PATTERN,
    SYSTEM_STATUS_IDS,
    BlockType,
    CreateWorkItem,
    StatusCategory,
    TaskSpaceCommand,
    TaskSpaceCommandModule,
    TaskSpaceOutcome,
    TaskSpaceQueryModule,
    WorkItemNoteCommand,
    format_work_item_display_key,
    normalize_project_key,
)


def test_status_and_block_sets_are_closed() -> None:
    assert {item.value for item in StatusCategory} == {
        "not_started",
        "in_progress",
        "paused",
        "waiting",
        "completed",
        "cancelled",
    }
    assert {item.value for item in BlockType} == {"paragraph", "checklist"}
    assert set(SYSTEM_STATUS_IDS) == {item.value for item in StatusCategory}
    assert len(set(SYSTEM_STATUS_IDS.values())) == 6


def test_note_command_carries_cas_and_idempotency_identity() -> None:
    assert {field.name for field in fields(WorkItemNoteCommand)} == {
        "kind",
        "command_id",
        "space_id",
        "work_item_id",
        "expected_version",
        "payload_hash",
        "payload",
    }
    assert get_type_hints(WorkItemNoteCommand)["expected_version"] == int | None


def test_project_key_and_work_item_number_contract() -> None:
    assert PROJECT_KEY_PATTERN.fullmatch("PX12")
    assert normalize_project_key(" px12 ") == "PX12"
    assert format_work_item_display_key("PX12", 1) == "PX12-1"
    with pytest.raises(ValueError, match="project_key"):
        normalize_project_key("1PX")
    with pytest.raises(ValueError, match="work_item_number"):
        format_work_item_display_key("PX12", 0)
    assert "display_key" not in {field.name for field in fields(CreateWorkItem)}


def test_task_space_command_module_has_one_write_entrypoint() -> None:
    assert {
        name
        for name, value in TaskSpaceCommandModule.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {"execute"}
    assert TaskSpaceCommand.__args__
    assert TaskSpaceOutcome.__args__


def test_task_space_protocols_receive_space_runtime_handles() -> None:
    for method in (
        TaskSpaceQueryModule.list_projects,
        TaskSpaceQueryModule.get_project,
        TaskSpaceQueryModule.list_definitions,
        TaskSpaceQueryModule.list_work_items,
        TaskSpaceQueryModule.get_work_item,
        TaskSpaceQueryModule.read_note,
        TaskSpaceCommandModule.execute,
    ):
        hints = get_type_hints(
            method,
            globalns={**method.__globals__, "SpaceRuntimeHandle": SpaceRuntimeHandle},
        )
        assert hints["scope"] is SpaceRuntimeHandle
