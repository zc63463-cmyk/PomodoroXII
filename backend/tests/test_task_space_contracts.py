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
    # ★ 2026-10-02（状态双轴）：category 由 6 值收敛为 5 值（`paused` 并入
    #   in_progress，迁移 space_017）。`waiting` 保留 —— 它是 ADR-0003 等待前态的锚点。
    assert {item.value for item in StatusCategory} == {
        "not_started",
        "in_progress",
        "waiting",
        "completed",
        "cancelled",
    }
    assert {item.value for item in BlockType} == {"paragraph", "checklist"}
    # ★ SYSTEM_STATUS_IDS 现在是「每个 category 的系统代表 status」，
    #   不再是 category 全集 —— 但两者当前仍一一对应，故这条断言继续成立。
    assert set(SYSTEM_STATUS_IDS) == {item.value for item in StatusCategory}
    assert len(set(SYSTEM_STATUS_IDS.values())) == 5


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
